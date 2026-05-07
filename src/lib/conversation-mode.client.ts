// Browser-only controller for the back-to-back conversational TTS/STT
// mode. Owns one long-running MediaStream + AudioContext + AnalyserNode
// for the whole mode session, creates per-turn MediaRecorder instances,
// and a single <audio> element for assistant TTS playback. A continuous
// rAF loop runs the VAD across all phases so barge-in (user speaking
// over the assistant) flips back to recording promptly.

import { sendMessageRpc } from './conversations.remote';
import {
	explainMicError,
	pickMimeType,
	transcribe,
} from './speech-recognition.client';
import {
	BARGE_IN_VAD_OPTS,
	DEFAULT_VAD_OPTS,
	computeRms,
	dbFromRms,
	initialVadState,
	stepVad,
	type VadState,
} from './vad';

export type ConversationModePhase =
	| 'idle'
	| 'listening'
	| 'recording'
	| 'transcribing'
	| 'sending'
	| 'thinking'
	| 'speaking'
	| 'error';

export type ConversationModeSnapshot = {
	active: boolean;
	phase: ConversationModePhase;
	errorMessage: string | null;
};

export type ConversationModeEvent =
	| { type: 'toggle_on' }
	| { type: 'toggle_off' }
	| { type: 'speech_onset' }
	| { type: 'turn_ended' }
	| { type: 'transcribed'; text: string }
	| { type: 'sent' }
	| { type: 'assistant_complete' }
	| { type: 'tts_ended' }
	| { type: 'fail' };

/**
 * Pure reducer driving the phase state machine. Exported so the
 * transition table can be unit-tested without touching DOM resources.
 */
export function nextPhase(
	current: ConversationModePhase,
	event: ConversationModeEvent,
): ConversationModePhase {
	switch (event.type) {
		case 'toggle_on':
			return current === 'idle' ? 'listening' : current;
		case 'toggle_off':
			return 'idle';
		case 'fail':
			return 'error';
		case 'speech_onset':
			return current === 'listening' || current === 'speaking' ? 'recording' : current;
		case 'turn_ended':
			return current === 'recording' ? 'transcribing' : current;
		case 'transcribed':
			if (current !== 'transcribing') return current;
			return event.text.trim() ? 'sending' : 'listening';
		case 'sent':
			return current === 'sending' ? 'thinking' : current;
		case 'assistant_complete':
			return current === 'thinking' ? 'speaking' : current;
		case 'tts_ended':
			return current === 'speaking' ? 'listening' : current;
	}
}

export type ConversationModeDeps = {
	conversationId: string;
	getModel: () => string;
	onOptimisticSubmit: (content: string, model: string) => void;
	onOptimisticRevert: () => void;
	onToast: (message: string) => void;
};

type Listener = (snapshot: ConversationModeSnapshot) => void;

export class ConversationMode {
	private snapshot: ConversationModeSnapshot = {
		active: false,
		phase: 'idle',
		errorMessage: null,
	};
	private listeners = new Set<Listener>();

	private stream: MediaStream | null = null;
	private audioContext: AudioContext | null = null;
	private analyser: AnalyserNode | null = null;
	private analyserBuffer: Uint8Array<ArrayBuffer> | null = null;
	private rafHandle: number | null = null;
	private vadState: VadState = initialVadState();

	private recorder: MediaRecorder | null = null;
	private recorderChunks: Blob[] = [];

	private audio: HTMLAudioElement | null = null;
	private pendingSpeakMessageId: string | null = null;

	private failureCount = 0;
	private toggling = false;

	constructor(private deps: ConversationModeDeps) {}

	get state(): ConversationModeSnapshot {
		return this.snapshot;
	}

	subscribe(listener: Listener): () => void {
		this.listeners.add(listener);
		listener(this.snapshot);
		return () => this.listeners.delete(listener);
	}

	async toggle(): Promise<void> {
		if (this.toggling) return;
		this.toggling = true;
		try {
			if (this.snapshot.active) {
				this.dispatch({ type: 'toggle_off' });
			} else {
				await this.start();
			}
		} finally {
			this.toggling = false;
		}
	}

	/** Force-end the current user turn (manual override on the VAD). */
	stopTurn(): void {
		if (this.snapshot.phase !== 'recording') return;
		this.dispatch({ type: 'turn_ended' });
	}

	/**
	 * Page-level signal: the assistant message with this id has finished
	 * streaming. Only triggers TTS when we're the one waiting on it.
	 */
	speakAssistant(messageId: string): void {
		if (!this.snapshot.active) return;
		if (this.snapshot.phase !== 'thinking') return;
		this.pendingSpeakMessageId = messageId;
		this.dispatch({ type: 'assistant_complete' });
	}

	dispose(): void {
		this.teardown();
		this.listeners.clear();
	}

	// ---- internal ---------------------------------------------------------

	private setSnapshot(patch: Partial<ConversationModeSnapshot>): void {
		const next = { ...this.snapshot, ...patch };
		if (
			next.active === this.snapshot.active &&
			next.phase === this.snapshot.phase &&
			next.errorMessage === this.snapshot.errorMessage
		) {
			return;
		}
		this.snapshot = next;
		for (const listener of this.listeners) listener(this.snapshot);
	}

	private dispatch(event: ConversationModeEvent): void {
		const prev = this.snapshot.phase;
		const next = nextPhase(prev, event);
		if (next !== prev) {
			this.setSnapshot({ phase: next });
		}
		this.runSideEffect(prev, next, event);
	}

	private runSideEffect(
		prev: ConversationModePhase,
		next: ConversationModePhase,
		event: ConversationModeEvent,
	): void {
		if (event.type === 'toggle_off') {
			this.teardown();
			return;
		}
		if (event.type === 'fail') {
			this.teardown();
			return;
		}
		// Reset VAD state when entering a phase that listens for onset
		// from idle (i.e. fresh "listening"). When transitioning into
		// 'recording' from 'listening' or 'speaking', we keep the
		// in-speech state so silenceMs accumulates correctly.
		if (next === 'listening' && prev !== 'listening') {
			this.vadState = initialVadState();
		}
		if (next === 'recording' && prev !== next) {
			// listening → recording (fresh turn) OR speaking → recording (barge-in)
			if (prev === 'speaking' && this.audio) {
				try {
					this.audio.pause();
				} catch {
					/* ignore */
				}
			}
			this.startRecorder();
			return;
		}
		if (next === 'transcribing' && prev !== next) {
			void this.stopRecorderAndTranscribe();
			return;
		}
		if (next === 'speaking' && prev !== next) {
			this.startTts();
			return;
		}
	}

	private async start(): Promise<void> {
		this.failureCount = 0;
		try {
			this.stream = await navigator.mediaDevices.getUserMedia({
				audio: {
					echoCancellation: true,
					noiseSuppression: true,
					autoGainControl: true,
				},
			});
		} catch (err) {
			this.fail(explainMicError(err));
			return;
		}
		try {
			const ctx = new AudioContext();
			this.audioContext = ctx;
			const source = ctx.createMediaStreamSource(this.stream);
			const analyser = ctx.createAnalyser();
			analyser.fftSize = 2048;
			source.connect(analyser);
			this.analyser = analyser;
			this.analyserBuffer = new Uint8Array(new ArrayBuffer(analyser.fftSize));
			this.vadState = initialVadState();

			// Create the audio element inside the user-gesture stack so
			// later programmatic .play() calls satisfy autoplay policy.
			const audio = new Audio();
			audio.preload = 'none';
			audio.addEventListener('ended', () => this.dispatch({ type: 'tts_ended' }));
			audio.addEventListener('error', () => this.fail('TTS playback failed'));
			this.audio = audio;

			this.setSnapshot({ active: true, errorMessage: null });
			this.dispatch({ type: 'toggle_on' });
			this.startAnalyserLoop();
		} catch (err) {
			this.fail(err instanceof Error ? err.message : 'Could not start conversation mode');
		}
	}

	private startAnalyserLoop(): void {
		const tick = () => {
			const analyser = this.analyser;
			const buffer = this.analyserBuffer;
			if (!analyser || !buffer) return;
			analyser.getByteTimeDomainData(buffer);
			const db = dbFromRms(computeRms(buffer));

			// Only meaningful in phases where we monitor for transitions.
			const phase = this.snapshot.phase;
			const opts = phase === 'speaking' ? BARGE_IN_VAD_OPTS : DEFAULT_VAD_OPTS;
			const result = stepVad(this.vadState, db, opts);
			this.vadState = result.state;

			if (result.event === 'speech_onset') {
				if (phase === 'listening' || phase === 'speaking') {
					this.dispatch({ type: 'speech_onset' });
				}
			} else if (result.event === 'turn_ended') {
				if (phase === 'recording') {
					this.dispatch({ type: 'turn_ended' });
				}
			}

			this.rafHandle = requestAnimationFrame(tick);
		};
		this.rafHandle = requestAnimationFrame(tick);
	}

	private startRecorder(): void {
		const stream = this.stream;
		if (!stream) {
			this.fail('Microphone stream not available');
			return;
		}
		const mime = pickMimeType();
		if (mime === null) {
			this.fail('MediaRecorder not supported');
			return;
		}
		try {
			const rec = mime
				? new MediaRecorder(stream, { mimeType: mime })
				: new MediaRecorder(stream);
			this.recorderChunks = [];
			rec.addEventListener('dataavailable', (e) => {
				if (e.data && e.data.size > 0) this.recorderChunks.push(e.data);
			});
			rec.start();
			this.recorder = rec;
		} catch (err) {
			this.fail(err instanceof Error ? err.message : 'Could not start recorder');
		}
	}

	private async stopRecorderAndTranscribe(): Promise<void> {
		const rec = this.recorder;
		this.recorder = null;
		if (!rec) {
			this.dispatch({ type: 'transcribed', text: '' });
			return;
		}
		const stopped = new Promise<void>((resolve, reject) => {
			rec.addEventListener('stop', () => resolve(), { once: true });
			rec.addEventListener(
				'error',
				(e) => reject((e as ErrorEvent).error ?? new Error('Recorder error')),
				{ once: true },
			);
		});
		try {
			if (rec.state !== 'inactive') rec.stop();
			await stopped;
		} catch (err) {
			this.recorderChunks = [];
			this.failTranscription(err instanceof Error ? err.message : String(err));
			return;
		}

		if (!this.snapshot.active) return; // mode was toggled off mid-stop

		const blob = new Blob(this.recorderChunks, { type: rec.mimeType || 'audio/webm' });
		this.recorderChunks = [];
		if (blob.size === 0) {
			this.dispatch({ type: 'transcribed', text: '' });
			return;
		}

		try {
			const text = await transcribe(blob);
			if (!this.snapshot.active) return;
			this.dispatch({ type: 'transcribed', text });
			if (text.trim()) {
				this.failureCount = 0;
				void this.sendUserMessage(text.trim());
			}
		} catch (err) {
			this.failTranscription(err instanceof Error ? err.message : 'Transcription failed');
		}
	}

	private failTranscription(message: string): void {
		this.failureCount += 1;
		if (this.failureCount >= 2) {
			this.fail(message);
			return;
		}
		this.deps.onToast(message);
		// Try again — drop back to listening.
		this.dispatch({ type: 'transcribed', text: '' });
	}

	private async sendUserMessage(content: string): Promise<void> {
		const model = this.deps.getModel();
		this.deps.onOptimisticSubmit(content, model);
		try {
			await sendMessageRpc({
				conversationId: this.deps.conversationId,
				content,
				model,
			});
			if (!this.snapshot.active) return;
			this.dispatch({ type: 'sent' });
		} catch (err) {
			this.deps.onOptimisticRevert();
			this.deps.onToast(err instanceof Error ? err.message : 'Failed to send message');
			if (!this.snapshot.active) return;
			// Bounce back to listening so the user can try again without
			// quitting the mode.
			this.dispatch({ type: 'tts_ended' });
		}
	}

	private startTts(): void {
		const id = this.pendingSpeakMessageId;
		this.pendingSpeakMessageId = null;
		const audio = this.audio;
		if (!id || !audio) {
			// No message to play — fall through to listening.
			this.dispatch({ type: 'tts_ended' });
			return;
		}
		audio.src = `/c/${this.deps.conversationId}/m/${id}/speak`;
		audio.currentTime = 0;
		audio.play().catch((err) => {
			this.fail(err instanceof Error ? err.message : 'TTS playback failed');
		});
	}

	private fail(message: string): void {
		this.setSnapshot({ errorMessage: message });
		this.deps.onToast(message);
		this.dispatch({ type: 'fail' });
	}

	private teardown(): void {
		if (this.rafHandle != null) {
			cancelAnimationFrame(this.rafHandle);
			this.rafHandle = null;
		}
		if (this.recorder) {
			try {
				if (this.recorder.state !== 'inactive') this.recorder.stop();
			} catch {
				/* ignore */
			}
			this.recorder = null;
			this.recorderChunks = [];
		}
		if (this.audio) {
			try {
				this.audio.pause();
			} catch {
				/* ignore */
			}
			this.audio.src = '';
			this.audio = null;
		}
		if (this.stream) {
			for (const t of this.stream.getTracks()) t.stop();
			this.stream = null;
		}
		if (this.audioContext) {
			void this.audioContext.close();
			this.audioContext = null;
		}
		this.analyser = null;
		this.analyserBuffer = null;
		this.vadState = initialVadState();
		this.pendingSpeakMessageId = null;
		this.setSnapshot({ active: false, phase: 'idle' });
	}
}

export function isConversationModeSupported(): boolean {
	if (typeof window === 'undefined') return false;
	if (!window.MediaRecorder) return false;
	if (!navigator.mediaDevices?.getUserMedia) return false;
	const Ctx =
		(window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext })
			.AudioContext ??
		(window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
	return typeof Ctx === 'function';
}

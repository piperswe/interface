// Browser-only helper: records audio via MediaRecorder, posts the resulting
// blob to /transcribe, and returns the transcribed text. The server side
// runs Workers AI Whisper (`@cf/openai/whisper-large-v3-turbo`).

import { z } from 'zod';
import { safeValidate } from '$lib/zod-utils';

const transcribeResponseSchema = z.object({ text: z.string().optional() }).passthrough();

const PREFERRED_MIME_TYPES = [
	'audio/webm;codecs=opus',
	'audio/webm',
	'audio/mp4',
	'audio/ogg;codecs=opus',
];

export function isSpeechRecognitionSupported(): boolean {
	if (typeof window === 'undefined') return false;
	if (!window.MediaRecorder) return false;
	if (!navigator.mediaDevices?.getUserMedia) return false;
	return pickMimeType() !== null;
}

export function pickMimeType(): string | null {
	if (typeof window === 'undefined' || !window.MediaRecorder) return null;
	for (const t of PREFERRED_MIME_TYPES) {
		if (MediaRecorder.isTypeSupported(t)) return t;
	}
	return MediaRecorder.isTypeSupported('') ? '' : null;
}

export function explainMicError(err: unknown): string {
	if (err instanceof Error) {
		switch (err.name) {
			case 'NotAllowedError':
			case 'PermissionDeniedError':
				return 'Microphone permission denied.';
			case 'NotFoundError':
			case 'DevicesNotFoundError':
				return 'No microphone found.';
			case 'NotReadableError':
				return 'Microphone is in use by another app.';
			case 'SecurityError':
				return 'Microphone access blocked by the browser.';
		}
		return err.message || 'Microphone error.';
	}
	return String(err);
}

export class Recorder {
	private stream: MediaStream | null = null;
	private recorder: MediaRecorder | null = null;
	private chunks: Blob[] = [];
	private mimeType = '';

	async start(): Promise<void> {
		if (this.recorder) throw new Error('Recorder already started');
		const mime = pickMimeType();
		if (mime === null) throw new Error('MediaRecorder not supported');
		this.mimeType = mime;
		this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
		this.recorder = mime
			? new MediaRecorder(this.stream, { mimeType: mime })
			: new MediaRecorder(this.stream);
		this.chunks = [];
		this.recorder.addEventListener('dataavailable', (e) => {
			if (e.data && e.data.size > 0) this.chunks.push(e.data);
		});
		this.recorder.start();
	}

	async stop(): Promise<Blob> {
		const rec = this.recorder;
		if (!rec) throw new Error('Recorder not started');
		const stopped = new Promise<void>((resolve, reject) => {
			rec.addEventListener('stop', () => resolve(), { once: true });
			rec.addEventListener('error', (e) => reject((e as ErrorEvent).error ?? e), { once: true });
		});
		if (rec.state !== 'inactive') rec.stop();
		await stopped;
		this.releaseStream();
		const type = rec.mimeType || this.mimeType || 'audio/webm';
		const blob = new Blob(this.chunks, { type });
		this.recorder = null;
		this.chunks = [];
		return blob;
	}

	cancel(): void {
		if (this.recorder && this.recorder.state !== 'inactive') {
			try {
				this.recorder.stop();
			} catch {
				// ignore — we're tearing down anyway
			}
		}
		this.recorder = null;
		this.chunks = [];
		this.releaseStream();
	}

	private releaseStream(): void {
		if (this.stream) {
			for (const t of this.stream.getTracks()) t.stop();
			this.stream = null;
		}
	}
}

export async function transcribe(blob: Blob): Promise<string> {
	const res = await fetch('/transcribe', {
		method: 'POST',
		headers: { 'Content-Type': blob.type || 'audio/webm' },
		body: blob,
	});
	if (!res.ok) {
		const detail = await res.text().catch(() => `${res.status}`);
		throw new Error(detail || `Transcription failed (${res.status})`);
	}
	const validated = safeValidate(transcribeResponseSchema, await res.json());
	if (!validated.ok) {
		throw new Error(`Unexpected /transcribe response shape: ${validated.error}`);
	}
	return (validated.value.text ?? '').trim();
}

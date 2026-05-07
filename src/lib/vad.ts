// Pure helpers for voice-activity detection. Used by the conversational
// mode controller to drive a state machine off an AnalyserNode RMS feed.
// No DOM dependencies — all functions are pure so they can be unit-tested
// with synthetic frame arrays.

export type VadOpts = {
	/** Frames at or above this dBFS are "voice". */
	speechThresholdDb: number;
	/**
	 * Frames strictly below this dBFS are "silence". Set lower than
	 * `speechThresholdDb` to give the detector hysteresis: once we're in
	 * speech, frames in the band between the two thresholds keep us
	 * there instead of flapping to silence.
	 */
	silenceThresholdDb: number;
	/** Consecutive voice frames required to declare speech onset. */
	onsetFrames: number;
	/** ms of continuous silence after speech that ends a turn. */
	silenceMs: number;
	/** Min ms of detected speech before silence-end is allowed to fire. */
	minSpeechMs: number;
	/** Approx ms per frame (used to convert ms thresholds to counts). */
	frameIntervalMs: number;
};

export const DEFAULT_VAD_OPTS: VadOpts = {
	speechThresholdDb: -45,
	silenceThresholdDb: -50,
	onsetFrames: 3,
	silenceMs: 1500,
	minSpeechMs: 400,
	frameIntervalMs: 20,
};

// Stricter onset for detecting barge-in while assistant TTS is playing
// — echo cancellation isn't perfect, so we want more evidence before
// interrupting playback.
export const BARGE_IN_VAD_OPTS: VadOpts = {
	...DEFAULT_VAD_OPTS,
	onsetFrames: 5,
};

/**
 * RMS of a time-domain audio frame. Accepts the byte form returned by
 * `AnalyserNode.getByteTimeDomainData` (range 0..255, midpoint 128) or
 * the float form from `getFloatTimeDomainData` (range -1..1).
 */
export function computeRms(buf: Uint8Array | Float32Array): number {
	let sum = 0;
	if (buf instanceof Uint8Array) {
		for (let i = 0; i < buf.length; i++) {
			const v = (buf[i] - 128) / 128;
			sum += v * v;
		}
	} else {
		for (let i = 0; i < buf.length; i++) {
			sum += buf[i] * buf[i];
		}
	}
	return Math.sqrt(sum / buf.length);
}

export function dbFromRms(rms: number): number {
	if (rms <= 0) return Number.NEGATIVE_INFINITY;
	return 20 * Math.log10(rms);
}

export type VadState = {
	/** True after onset, until a turn-end (or external reset). */
	inSpeech: boolean;
	/** Consecutive voice frames seen pre-onset. */
	onsetRun: number;
	/** ms of detected speech accumulated since onset. */
	speechMs: number;
	/** ms of trailing silence since the last voice frame, while inSpeech. */
	silenceMs: number;
};

export function initialVadState(): VadState {
	return { inSpeech: false, onsetRun: 0, speechMs: 0, silenceMs: 0 };
}

export type VadEvent = 'speech_onset' | 'turn_ended';

export type VadFrameResult = {
	state: VadState;
	/** Edge events the caller reacts to. Zero or one fires per frame. */
	event: VadEvent | null;
};

/**
 * Advance the VAD by one frame given its dBFS reading. Pure: returns a
 * fresh state plus an optional edge event.
 */
export function stepVad(state: VadState, db: number, opts: VadOpts): VadFrameResult {
	if (!state.inSpeech) {
		if (db >= opts.speechThresholdDb) {
			const onsetRun = state.onsetRun + 1;
			if (onsetRun >= opts.onsetFrames) {
				return {
					state: {
						inSpeech: true,
						onsetRun: 0,
						speechMs: opts.frameIntervalMs * onsetRun,
						silenceMs: 0,
					},
					event: 'speech_onset',
				};
			}
			return { state: { ...state, onsetRun }, event: null };
		}
		if (state.onsetRun > 0) {
			return { state: { ...state, onsetRun: 0 }, event: null };
		}
		return { state, event: null };
	}

	if (db < opts.silenceThresholdDb) {
		const silenceMs = state.silenceMs + opts.frameIntervalMs;
		if (silenceMs >= opts.silenceMs && state.speechMs >= opts.minSpeechMs) {
			return { state: initialVadState(), event: 'turn_ended' };
		}
		return { state: { ...state, silenceMs }, event: null };
	}

	return {
		state: {
			inSpeech: true,
			onsetRun: 0,
			speechMs: state.speechMs + opts.frameIntervalMs,
			silenceMs: 0,
		},
		event: null,
	};
}

/** Convenience: drive the VAD over a dB sequence and collect the events. */
export function runVad(
	history: number[],
	opts: VadOpts,
): { events: VadEvent[]; state: VadState } {
	let state = initialVadState();
	const events: VadEvent[] = [];
	for (const db of history) {
		const result = stepVad(state, db, opts);
		state = result.state;
		if (result.event) events.push(result.event);
	}
	return { events, state };
}

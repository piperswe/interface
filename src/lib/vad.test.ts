import { describe, expect, it } from 'vitest';
import {
	BARGE_IN_VAD_OPTS,
	DEFAULT_VAD_OPTS,
	computeRms,
	dbFromRms,
	initialVadState,
	runVad,
	stepVad,
} from './vad';

describe('computeRms', () => {
	it('returns 0 for a zero Float32 buffer', () => {
		expect(computeRms(new Float32Array(256))).toBe(0);
	});

	it('returns 0 for a Uint8 buffer pinned at the midpoint', () => {
		expect(computeRms(new Uint8Array(256).fill(128))).toBe(0);
	});

	it('returns 1 for a constant full-scale Float32 buffer', () => {
		expect(computeRms(new Float32Array(256).fill(1))).toBeCloseTo(1, 5);
	});

	it('handles Uint8 deviation from the 128 midpoint', () => {
		// (192 - 128) / 128 = 0.5
		expect(computeRms(new Uint8Array(256).fill(192))).toBeCloseTo(0.5, 5);
	});
});

describe('dbFromRms', () => {
	it('returns -Infinity for zero', () => {
		expect(dbFromRms(0)).toBe(Number.NEGATIVE_INFINITY);
	});

	it('returns 0 dB for full scale', () => {
		expect(dbFromRms(1)).toBe(0);
	});

	it('returns -20 dB for 0.1 RMS', () => {
		expect(dbFromRms(0.1)).toBeCloseTo(-20, 5);
	});
});

describe('stepVad', () => {
	it('does not emit onset on isolated above-threshold frames', () => {
		const { events, state } = runVad([-30, -60, -30, -60], DEFAULT_VAD_OPTS);
		expect(events).toEqual([]);
		expect(state.inSpeech).toBe(false);
	});

	it('emits speech_onset after onsetFrames consecutive voice frames', () => {
		const { events, state } = runVad([-30, -30, -30], DEFAULT_VAD_OPTS);
		expect(events).toEqual(['speech_onset']);
		expect(state.inSpeech).toBe(true);
	});

	it('does not emit turn_ended on a sub-min-speech blip followed by silence', () => {
		// 5 voice frames = ~100ms of speech (below the 400ms minSpeech),
		// then 2000ms of silence. Onset fires but turn_ended must not.
		const history = [...new Array(5).fill(-30), ...new Array(100).fill(-70)];
		const { events } = runVad(history, DEFAULT_VAD_OPTS);
		expect(events).toContain('speech_onset');
		expect(events).not.toContain('turn_ended');
	});

	it('emits turn_ended after sustained speech then 1500ms of silence', () => {
		const history = [...new Array(30).fill(-30), ...new Array(80).fill(-70)];
		const { events } = runVad(history, DEFAULT_VAD_OPTS);
		expect(events).toEqual(['speech_onset', 'turn_ended']);
	});

	it('hysteresis: frames in the band between the two thresholds hold us in speech', () => {
		// After onset, sit at -48 dBFS (below speech, above silence) for
		// 1s; the silence counter must stay at zero, so a real silence
		// shorter than 1500ms can't end the turn yet.
		const history = [
			...new Array(30).fill(-30),
			...new Array(50).fill(-48),
			...new Array(50).fill(-70),
		];
		const { events } = runVad(history, DEFAULT_VAD_OPTS);
		expect(events).toEqual(['speech_onset']);
	});

	it('barge-in opts require more onset frames before flipping to speech', () => {
		const lax = runVad([-30, -30, -30], DEFAULT_VAD_OPTS);
		const strict3 = runVad([-30, -30, -30], BARGE_IN_VAD_OPTS);
		const strict5 = runVad([-30, -30, -30, -30, -30], BARGE_IN_VAD_OPTS);
		expect(lax.events).toEqual(['speech_onset']);
		expect(strict3.events).toEqual([]);
		expect(strict5.events).toEqual(['speech_onset']);
	});

	it('a single frame step is referentially fresh (state immutability)', () => {
		const before = initialVadState();
		const { state: after } = stepVad(before, -30, DEFAULT_VAD_OPTS);
		expect(before.onsetRun).toBe(0);
		expect(after.onsetRun).toBe(1);
	});
});

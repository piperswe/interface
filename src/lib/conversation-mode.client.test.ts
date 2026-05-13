import { describe, expect, it } from 'vitest';
import { type ConversationModePhase, nextPhase } from './conversation-mode.client';

describe('nextPhase', () => {
	it('toggle_on takes us from idle to listening', () => {
		expect(nextPhase('idle', { type: 'toggle_on' })).toBe('listening');
	});

	it('toggle_on is a no-op while already active', () => {
		expect(nextPhase('listening', { type: 'toggle_on' })).toBe('listening');
		expect(nextPhase('speaking', { type: 'toggle_on' })).toBe('speaking');
	});

	it('toggle_off resets any phase to idle', () => {
		const phases: ConversationModePhase[] = ['listening', 'recording', 'transcribing', 'sending', 'thinking', 'speaking', 'error'];
		for (const p of phases) {
			expect(nextPhase(p, { type: 'toggle_off' })).toBe('idle');
		}
	});

	it('happy path: listening → recording → transcribing → sending → thinking → speaking → listening', () => {
		expect(nextPhase('listening', { type: 'speech_onset' })).toBe('recording');
		expect(nextPhase('recording', { type: 'turn_ended' })).toBe('transcribing');
		expect(nextPhase('transcribing', { text: 'hello', type: 'transcribed' })).toBe('sending');
		expect(nextPhase('sending', { type: 'sent' })).toBe('thinking');
		expect(nextPhase('thinking', { type: 'assistant_complete' })).toBe('speaking');
		expect(nextPhase('speaking', { type: 'tts_ended' })).toBe('listening');
	});

	it('barge-in: speech_onset while speaking transitions to recording', () => {
		expect(nextPhase('speaking', { type: 'speech_onset' })).toBe('recording');
	});

	it('empty transcript bounces back to listening instead of sending', () => {
		expect(nextPhase('transcribing', { text: '', type: 'transcribed' })).toBe('listening');
		expect(nextPhase('transcribing', { text: '   ', type: 'transcribed' })).toBe('listening');
	});

	it('fail event always transitions to error', () => {
		const phases: ConversationModePhase[] = ['idle', 'listening', 'recording', 'transcribing', 'sending', 'thinking', 'speaking'];
		for (const p of phases) {
			expect(nextPhase(p, { type: 'fail' })).toBe('error');
		}
	});

	it('out-of-band events do not change phase', () => {
		// turn_ended only valid in recording
		expect(nextPhase('listening', { type: 'turn_ended' })).toBe('listening');
		// speech_onset only valid in listening or speaking
		expect(nextPhase('recording', { type: 'speech_onset' })).toBe('recording');
		expect(nextPhase('transcribing', { type: 'speech_onset' })).toBe('transcribing');
		// assistant_complete only valid in thinking
		expect(nextPhase('listening', { type: 'assistant_complete' })).toBe('listening');
		expect(nextPhase('sending', { type: 'assistant_complete' })).toBe('sending');
		// tts_ended only valid in speaking
		expect(nextPhase('listening', { type: 'tts_ended' })).toBe('listening');
	});
});

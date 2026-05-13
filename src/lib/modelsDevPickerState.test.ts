import { describe, expect, it } from 'vitest';
import { computeAutoPrefixUpdate } from './modelsDevPickerState';

describe('computeAutoPrefixUpdate', () => {
	it('auto-fills on the first filter selection', () => {
		const result = computeAutoPrefixUpdate({
			currentPrefix: '',
			filter: 'anthropic',
			previousAutoFilter: '',
			providerType: 'openai_compatible',
		});
		expect(result).toEqual({ autoFilter: 'anthropic', prefix: 'anthropic/' });
	});

	it('updates the prefix when switching between filters and the user has not customized', () => {
		const result = computeAutoPrefixUpdate({
			currentPrefix: 'anthropic/',
			filter: 'openai',
			previousAutoFilter: 'anthropic',
			providerType: 'openai_compatible',
		});
		expect(result).toEqual({ autoFilter: 'openai', prefix: 'openai/' });
	});

	it('leaves a user-customized prefix alone when the filter changes', () => {
		const result = computeAutoPrefixUpdate({
			currentPrefix: 'custom/',
			filter: 'openai',
			previousAutoFilter: 'anthropic',
			providerType: 'openai_compatible',
		});
		expect(result).toEqual({ autoFilter: 'openai', prefix: 'custom/' });
	});

	// Regression: the previous implementation treated an empty prefix as
	// "still auto-set", so the $effect snapped it back to `${filter}/` on
	// every reactive tick. Users couldn't keep the prefix empty.
	it('no-ops when the filter has not changed since the last auto-fill (preserves a user-cleared empty prefix)', () => {
		const result = computeAutoPrefixUpdate({
			currentPrefix: '',
			filter: 'anthropic',
			previousAutoFilter: 'anthropic',
			providerType: 'openai_compatible',
		});
		expect(result).toEqual({ autoFilter: 'anthropic', prefix: '' });
	});

	// Regression companion: once the user clears the auto-filled prefix, the
	// emptied value must survive across a subsequent filter switch — otherwise
	// the next filter change would re-introduce a prefix the user explicitly
	// removed.
	it('preserves a user-cleared empty prefix across filter changes', () => {
		const result = computeAutoPrefixUpdate({
			currentPrefix: '',
			filter: 'openai',
			previousAutoFilter: 'anthropic',
			providerType: 'openai_compatible',
		});
		expect(result).toEqual({ autoFilter: 'openai', prefix: '' });
	});

	it('clears the auto-filled prefix when the filter is cleared', () => {
		const result = computeAutoPrefixUpdate({
			currentPrefix: 'anthropic/',
			filter: '',
			previousAutoFilter: 'anthropic',
			providerType: 'openai_compatible',
		});
		expect(result).toEqual({ autoFilter: '', prefix: '' });
	});

	it('never modifies state for anthropic-typed providers', () => {
		const result = computeAutoPrefixUpdate({
			currentPrefix: '',
			filter: 'anthropic',
			previousAutoFilter: '',
			providerType: 'anthropic',
		});
		expect(result).toEqual({ autoFilter: '', prefix: '' });
	});
});

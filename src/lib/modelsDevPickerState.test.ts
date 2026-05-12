import { describe, it, expect } from 'vitest';
import { computeAutoPrefixUpdate } from './modelsDevPickerState';

describe('computeAutoPrefixUpdate', () => {
	it('auto-fills on the first filter selection', () => {
		const result = computeAutoPrefixUpdate({
			providerType: 'openai_compatible',
			filter: 'anthropic',
			previousAutoFilter: '',
			currentPrefix: '',
		});
		expect(result).toEqual({ prefix: 'anthropic/', autoFilter: 'anthropic' });
	});

	it('updates the prefix when switching between filters and the user has not customized', () => {
		const result = computeAutoPrefixUpdate({
			providerType: 'openai_compatible',
			filter: 'openai',
			previousAutoFilter: 'anthropic',
			currentPrefix: 'anthropic/',
		});
		expect(result).toEqual({ prefix: 'openai/', autoFilter: 'openai' });
	});

	it('leaves a user-customized prefix alone when the filter changes', () => {
		const result = computeAutoPrefixUpdate({
			providerType: 'openai_compatible',
			filter: 'openai',
			previousAutoFilter: 'anthropic',
			currentPrefix: 'custom/',
		});
		expect(result).toEqual({ prefix: 'custom/', autoFilter: 'openai' });
	});

	// Regression: the previous implementation treated an empty prefix as
	// "still auto-set", so the $effect snapped it back to `${filter}/` on
	// every reactive tick. Users couldn't keep the prefix empty.
	it('no-ops when the filter has not changed since the last auto-fill (preserves a user-cleared empty prefix)', () => {
		const result = computeAutoPrefixUpdate({
			providerType: 'openai_compatible',
			filter: 'anthropic',
			previousAutoFilter: 'anthropic',
			currentPrefix: '',
		});
		expect(result).toEqual({ prefix: '', autoFilter: 'anthropic' });
	});

	// Regression companion: once the user clears the auto-filled prefix, the
	// emptied value must survive across a subsequent filter switch — otherwise
	// the next filter change would re-introduce a prefix the user explicitly
	// removed.
	it('preserves a user-cleared empty prefix across filter changes', () => {
		const result = computeAutoPrefixUpdate({
			providerType: 'openai_compatible',
			filter: 'openai',
			previousAutoFilter: 'anthropic',
			currentPrefix: '',
		});
		expect(result).toEqual({ prefix: '', autoFilter: 'openai' });
	});

	it('clears the auto-filled prefix when the filter is cleared', () => {
		const result = computeAutoPrefixUpdate({
			providerType: 'openai_compatible',
			filter: '',
			previousAutoFilter: 'anthropic',
			currentPrefix: 'anthropic/',
		});
		expect(result).toEqual({ prefix: '', autoFilter: '' });
	});

	it('never modifies state for anthropic-typed providers', () => {
		const result = computeAutoPrefixUpdate({
			providerType: 'anthropic',
			filter: 'anthropic',
			previousAutoFilter: '',
			currentPrefix: '',
		});
		expect(result).toEqual({ prefix: '', autoFilter: '' });
	});
});

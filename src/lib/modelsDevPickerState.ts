import type { ProviderType } from '$lib/server/providers/types';

export type AutoPrefixInput = {
	providerType: ProviderType;
	filter: string;
	previousAutoFilter: string;
	currentPrefix: string;
};

export type AutoPrefixOutput = {
	prefix: string;
	autoFilter: string;
};

// Computes the next (prefix, autoFilter) for the models.dev picker's
// auto-prefix behavior. Pure so the $effect that drives it can be regression-
// tested without a Svelte runtime — see modelsDevPickerState.test.ts.
//
// Contract:
//   - For anthropic providers, never change state (bare ids only).
//   - If the filter hasn't changed since the last auto-fill, no-op.
//   - On a filter change, only overwrite the prefix when it still matches the
//     last auto-filled value (i.e. the user hasn't customized it). An empty
//     prefix only "looks auto-set" if the previous auto-filter was also empty
//     — so a user-cleared prefix sticks across filter changes.
export function computeAutoPrefixUpdate(input: AutoPrefixInput): AutoPrefixOutput {
	const { providerType, filter, previousAutoFilter, currentPrefix } = input;
	if (providerType === 'anthropic') {
		return { autoFilter: previousAutoFilter, prefix: currentPrefix };
	}
	if (filter === previousAutoFilter) {
		return { autoFilter: previousAutoFilter, prefix: currentPrefix };
	}
	const previousAuto = previousAutoFilter ? `${previousAutoFilter}/` : '';
	const looksAutoSet = currentPrefix === previousAuto;
	return {
		autoFilter: filter,
		prefix: looksAutoSet ? (filter ? `${filter}/` : '') : currentPrefix,
	};
}

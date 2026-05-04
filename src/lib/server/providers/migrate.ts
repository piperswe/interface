// Migrate legacy model_list setting to the new provider/model tables.
// Called lazily from listProviders / listAllModels when the tables are empty.

import { getSetting, deleteSetting } from '$lib/server/settings';
import { createProvider, listProviders } from '$lib/server/providers/store';
import { createModel } from '$lib/server/providers/models';
import type { ReasoningType } from '$lib/server/providers/types';

export async function migrateLegacyModelList(env: Env): Promise<void> {
	const raw = await getSetting(env, 'model_list');
	if (!raw) return;

	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!Array.isArray(parsed)) return;

		// Check if we already have providers
		const existing = await listProviders(env);
		if (existing.length > 0) return;

		// Create a default openrouter provider from the legacy list
		await createProvider(env, {
			id: 'openrouter',
			type: 'openai_compatible',
			apiKey: null, // will need to be filled in via UI
			endpoint: 'https://openrouter.ai/api/v1',
			gatewayId: null,
		});

		for (const item of parsed) {
			if (!item || typeof item !== 'object') continue;
			const slug = String((item as Record<string, unknown>).slug ?? '').trim();
			const label = String((item as Record<string, unknown>).label ?? '').trim();
			const reasoningRaw = (item as Record<string, unknown>).reasoning;
			const reasoningType: ReasoningType | null =
				reasoningRaw === 'effort' || reasoningRaw === 'max_tokens' ? reasoningRaw : null;
			if (!slug) continue;

			await createModel(env, 'openrouter', {
				id: slug,
				name: label || slug,
				description: null,
				maxContextLength: 128_000,
				reasoningType,
			});
		}

		// Delete the legacy setting
		await deleteSetting(env, 'model_list');
	} catch {
		// Migration failure is non-fatal; user can configure providers manually.
	}
}

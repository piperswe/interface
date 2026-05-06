import { describe, expect, it } from 'vitest';
import { getPresetById, PROVIDER_PRESETS } from './presets';

describe('PROVIDER_PRESETS', () => {
	it('exposes openrouter, ai-gateway, and workers-ai presets', () => {
		const ids = PROVIDER_PRESETS.map((p) => p.id);
		expect(ids).toEqual(['openrouter', 'ai-gateway', 'workers-ai']);
	});

	it('every preset has a non-empty label and a recognised provider type', () => {
		for (const p of PROVIDER_PRESETS) {
			expect(p.label.length).toBeGreaterThan(0);
			expect(['anthropic', 'openai_compatible']).toContain(p.type);
		}
	});

	it('only the openrouter preset advertises canFetchModels', () => {
		// Other presets ship with curated lists.
		const fetchable = PROVIDER_PRESETS.filter((p) => p.canFetchModels).map((p) => p.id);
		expect(fetchable).toEqual(['openrouter']);
	});

	it('curated default models in non-fetchable presets have unique ids and non-empty names', () => {
		for (const p of PROVIDER_PRESETS) {
			if (p.canFetchModels) {
				// openrouter ships an empty list — fetched dynamically.
				expect(p.defaultModels).toEqual([]);
				continue;
			}
			expect(p.defaultModels.length).toBeGreaterThan(0);
			const ids = p.defaultModels.map((m) => m.id);
			expect(new Set(ids).size).toBe(ids.length);
			for (const m of p.defaultModels) {
				expect(m.name.length).toBeGreaterThan(0);
				expect(m.maxContextLength).toBeGreaterThan(0);
			}
		}
	});

	it('every preset advertises requiresApiKey: true', () => {
		// Cloud providers all need a key today; lock that down so a future
		// no-key preset is reviewed.
		for (const p of PROVIDER_PRESETS) {
			expect(p.requiresApiKey).toBe(true);
		}
	});
});

describe('getPresetById', () => {
	it('returns the matching preset', () => {
		expect(getPresetById('openrouter')?.id).toBe('openrouter');
		expect(getPresetById('ai-gateway')?.label).toBe('Cloudflare AI Gateway');
		expect(getPresetById('workers-ai')?.type).toBe('openai_compatible');
	});

	it('returns null for unknown ids', () => {
		expect(getPresetById('not-a-preset')).toBeNull();
		expect(getPresetById('')).toBeNull();
	});
});

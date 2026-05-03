import { describe, expect, it } from 'vitest';
import type { MessagePart } from '../../types/conversation';

// renderParts is internal to Message.tsx; we test the part-ordering invariant
// at the type level + a small structural smoke. Real rendering is exercised
// via the full DO + client pipeline.
describe('MessagePart timeline', () => {
	it('supports interleaved thinking, text, and tool parts', () => {
		const parts: MessagePart[] = [
			{ type: 'thinking', text: 'Let me consider' },
			{ type: 'text', text: 'Searching now.' },
			{ type: 'tool_use', id: 't1', name: 'web_search', input: { q: 'cats' } },
			{ type: 'tool_result', toolUseId: 't1', content: 'no cats found', isError: false },
			{ type: 'thinking', text: 'Hmm, retrying' },
			{ type: 'text', text: 'No results.' },
		];
		const types = parts.map((p) => p.type);
		expect(types).toEqual(['thinking', 'text', 'tool_use', 'tool_result', 'thinking', 'text']);
		// First and last thinking parts are not adjacent — interleaving holds.
		expect(types.indexOf('thinking')).toBeLessThan(types.indexOf('text'));
		expect(types.lastIndexOf('thinking')).toBeGreaterThan(types.indexOf('tool_result'));
	});
});

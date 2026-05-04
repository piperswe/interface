// Pure helpers used by Message.svelte to group an assistant turn's parts
// into a renderable timeline. Lives in its own module so it can be unit-
// tested without the Svelte compiler.

import type { MessagePart, ToolResultPart, ToolUsePart } from '$lib/types/conversation';

export type Bundle = {
	kind: 'bundle';
	key: string;
	parts: { part: MessagePart; index: number }[];
	hasActive: boolean;
	mixed: boolean;
};
export type Standalone = { kind: 'standalone'; part: MessagePart; index: number };
export type Group = Bundle | Standalone;

const isOutput = (part: MessagePart) => part.type === 'text' || part.type === 'info';

export function buildResultsMap(parts: MessagePart[]): Map<string, ToolResultPart> {
	const m = new Map<string, ToolResultPart>();
	for (const p of parts) if (p.type === 'tool_result') m.set(p.toolUseId, p);
	return m;
}

// Group consecutive non-output parts (thinking, tool_use, tool_result) into
// a single collapsible bundle. Text/info parts stay standalone.
export function groupParts(parts: MessagePart[], streaming: boolean, results: Map<string, ToolResultPart>): Group[] {
	const groups: Group[] = [];
	let bundle: { part: MessagePart; index: number }[] = [];

	const flush = () => {
		if (bundle.length === 0) return;
		if (bundle.length === 1) {
			groups.push({ kind: 'standalone', part: bundle[0].part, index: bundle[0].index });
		} else {
			const hasActive = bundle.some(({ part, index }) => {
			if (part.type === 'thinking') return streaming && index === parts.length - 1;
			if (part.type === 'tool_use') {
				const result = results.get((part as ToolUsePart).id);
				if (!result) return streaming;
				return streaming && result.streaming;
			}
			return false;
			});
			const mixed = bundle.some((b) => b.part.type === 'tool_use');
			groups.push({
				kind: 'bundle',
				key: `bundle-${bundle[0].index}-${bundle[bundle.length - 1].index}`,
				parts: bundle,
				hasActive,
				mixed,
			});
		}
		bundle = [];
	};

	for (let i = 0; i < parts.length; i++) {
		const part = parts[i];
		if (isOutput(part)) {
			flush();
			if (part.type === 'text' && !part.text) continue;
			groups.push({ kind: 'standalone', part, index: i });
		} else {
			bundle.push({ part, index: i });
		}
	}
	flush();
	return groups;
}

export function fmtNumber(n: unknown): string {
	return typeof n === 'number' ? n.toLocaleString() : '—';
}

export function fmtMs(ms: number): string {
	if (!ms || ms < 0) return '—';
	return ms < 1000 ? ms + ' ms' : (ms / 1000).toFixed(2) + ' s';
}

export function fmtThroughput(completionTokens: number | undefined, totalMs: number): string {
	if (!completionTokens || !totalMs) return '—';
	return (completionTokens / (totalMs / 1000)).toFixed(1) + ' tok/s';
}

export function fmtRelative(ms: number, now: number = Date.now()): string {
	const diff = now - ms;
	if (diff < 60_000) return 'just now';
	if (diff < 3_600_000) return Math.floor(diff / 60_000) + 'm ago';
	if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + 'h ago';
	return Math.floor(diff / 86_400_000) + 'd ago';
}

export type RecencyBand = 'today' | 'this-week' | 'earlier';

const DAY = 86_400_000;

export function recencyBand(ms: number, now: number = Date.now()): RecencyBand {
	const diff = now - ms;
	if (diff < DAY) return 'today';
	if (diff < 7 * DAY) return 'this-week';
	return 'earlier';
}

export function recencyBandLabel(band: RecencyBand): string {
	if (band === 'today') return 'Today';
	if (band === 'this-week') return 'This week';
	return 'Earlier';
}

export function fmtNumber(n: unknown): string {
	return typeof n === 'number' ? n.toLocaleString() : '—';
}

export function fmtCost(n: unknown): string {
	if (typeof n !== 'number') return '—';
	return '$' + n.toFixed(6);
}

export function fmtMs(ms: number): string {
	if (!ms || ms < 0) return '—';
	return ms < 1000 ? ms + ' ms' : (ms / 1000).toFixed(2) + ' s';
}

export function fmtThroughput(completionTokens: number | undefined, totalMs: number): string {
	if (!completionTokens || !totalMs) return '—';
	return (completionTokens / (totalMs / 1000)).toFixed(1) + ' tok/s';
}

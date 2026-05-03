import type { ChatStreamChunk, ChatUsage } from '@openrouter/sdk/esm/models';

const output = document.getElementById('output')!;
const meta = document.getElementById('meta')!;
const form = document.getElementById('form')!;
const input = document.getElementById('question')! as HTMLInputElement;
const btn = document.getElementById('go')! as HTMLButtonElement;
const modelSelect = document.getElementById('model')! as unknown as HTMLSelectElement;
let es: EventSource | null = null;
let startedAt = 0;
let firstTokenAt = 0;
let lastChunk: ChatStreamChunk | null = null;
let usage: ChatUsage | null = null;

function fmtNumber(n: unknown) {
	return typeof n === 'number' ? n.toLocaleString() : '—';
}
function fmtCost(n: unknown) {
	if (typeof n !== 'number') return '—';
	return '$' + n.toFixed(6);
}
function fmtMs(ms: number) {
	if (!ms || ms < 0) return '—';
	return ms < 1000 ? ms + ' ms' : (ms / 1000).toFixed(2) + ' s';
}
function row(dt: string, dd: string) {
	return '<dt>' + dt + '</dt><dd>' + dd + '</dd>';
}
function renderMeta() {
	const totalMs = Date.now() - startedAt;
	const ttftMs = firstTokenAt ? firstTokenAt - startedAt : 0;
	const completionTokens = usage?.completionTokens ?? usage?.completionTokens;
	const promptTokens = usage?.promptTokens ?? usage?.promptTokens;
	const totalTokens = usage?.totalTokens ?? usage?.totalTokens;
	const cachedTokens = usage?.promptTokensDetails?.cachedTokens ?? usage?.promptTokensDetails?.cachedTokens;
	const reasoningTokens = usage?.completionTokensDetails?.reasoningTokens ?? usage?.completionTokensDetails?.reasoningTokens;
	const tps = completionTokens && totalMs ? (completionTokens / (totalMs / 1000)).toFixed(1) + ' tok/s' : '—';
	const rows = [
		row('Model', lastChunk?.model ?? '—'),
		row('ID', lastChunk?.id ?? '—'),
		row('Service tier', lastChunk?.serviceTier ?? lastChunk?.serviceTier ?? '—'),
		row('Prompt tokens', fmtNumber(promptTokens)),
		row('Completion tokens', fmtNumber(completionTokens)),
		row('Total tokens', fmtNumber(totalTokens)),
		row('Cached tokens', fmtNumber(cachedTokens)),
		row('Reasoning tokens', fmtNumber(reasoningTokens)),
		row('Cost', fmtCost(usage?.cost)),
		row('Time to first token', fmtMs(ttftMs)),
		row('Total time', fmtMs(totalMs)),
		row('Throughput', tps),
	];
	meta.innerHTML = '<h2>Request metadata</h2><dl>' + rows.join('') + '</dl>';
	meta.style.display = 'block';
}

form.addEventListener('submit', (event) => {
	event.preventDefault();
	const question = input.value.trim();
	if (!question) return;
	if (es) es.close();
	output.textContent = '';
	meta.style.display = 'none';
	meta.innerHTML = '';
	lastChunk = null;
	usage = null;
	firstTokenAt = 0;
	startedAt = Date.now();
	btn.disabled = true;

	const params = new URLSearchParams({ q: question });
	if (modelSelect && modelSelect.value) params.set('model', modelSelect.value);
	es = new EventSource('/api/hello?' + params.toString());
	es.onmessage = (e) => {
		try {
			const chunk = JSON.parse(e.data);
			lastChunk = chunk;
			if (chunk?.usage) usage = chunk.usage;
			const delta = chunk?.choices?.[0]?.delta?.content ?? '';
			if (delta) {
				if (!firstTokenAt) firstTokenAt = Date.now();
				output.textContent += delta;
			}
		} catch {
			output.textContent += e.data;
		}
	};
	es.onerror = () => {
		if (es) {
			es.close();
			es = null;
		}
		btn.disabled = false;
		renderMeta();
	};
});

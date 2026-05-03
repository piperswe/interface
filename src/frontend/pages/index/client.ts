import type { ChatStreamChunk, ChatUsage } from '@openrouter/sdk/esm/models';
import { createMetaPanel } from './meta';

const output = document.getElementById('output') as HTMLElement;
const form = document.getElementById('form') as HTMLFormElement;
const input = document.getElementById('question') as HTMLInputElement;
const btn = document.getElementById('go') as HTMLButtonElement;
const modelSelect = document.getElementById('model') as unknown as HTMLSelectElement;
const metaPanel = createMetaPanel(document.getElementById('meta') as HTMLElement);

const outputText = output.appendChild(document.createTextNode(''));

let es: EventSource | null = null;
let startedAt = 0;
let firstTokenAt = 0;
let lastChunk: ChatStreamChunk | null = null;
let usage: ChatUsage | null = null;

function closeStream() {
	if (es) {
		es.close();
		es = null;
	}
}

form.addEventListener('submit', (event) => {
	event.preventDefault();
	const question = input.value.trim();
	if (!question) return;

	closeStream();
	outputText.data = '';
	metaPanel.hide();
	lastChunk = null;
	usage = null;
	firstTokenAt = 0;
	startedAt = Date.now();
	btn.disabled = true;

	const params = new URLSearchParams({ q: question });
	if (modelSelect.value) params.set('model', modelSelect.value);

	es = new EventSource('/api/hello?' + params.toString());

	es.onmessage = (e) => {
		try {
			const chunk = JSON.parse(e.data) as ChatStreamChunk;
			lastChunk = chunk;
			if (chunk?.usage) usage = chunk.usage;
			const delta = chunk?.choices?.[0]?.delta?.content ?? '';
			if (delta) {
				if (!firstTokenAt) firstTokenAt = Date.now();
				outputText.data += delta;
			}
		} catch {
			outputText.data += e.data;
		}
	};

	es.onerror = () => {
		closeStream();
		btn.disabled = false;
		metaPanel.render({ startedAt, firstTokenAt, lastChunk, usage });
	};
});

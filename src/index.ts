export { default as ChatDurableObject } from './durable_objects/ChatDurableObject';

type OpenRouterFrontendModel = {
	slug: string;
	short_name?: string;
	name?: string;
	is_hidden?: boolean;
	is_disabled?: boolean;
};

const FALLBACK_MODEL = { slug: 'openai/gpt-5.5', label: 'GPT-5.5' };

function escapeHtml(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;');
}

async function fetchTopModels(limit: number): Promise<Array<{ slug: string; label: string }>> {
	try {
		const response = await fetch('https://openrouter.ai/api/frontend/models/find?order=top-weekly', {
			headers: { Accept: 'application/json' },
		});
		if (!response.ok) throw new Error(`Status ${response.status}`);
		const body = (await response.json()) as { data?: { models?: OpenRouterFrontendModel[] } };
		const models = body.data?.models ?? [];
		return models
			.filter((m) => m && m.slug && !m.is_hidden && !m.is_disabled)
			.slice(0, limit)
			.map((m) => ({ slug: m.slug, label: m.short_name || m.name || m.slug }));
	} catch {
		return [FALLBACK_MODEL];
	}
}

function renderIndexHtml(modelOptionsHtml: string): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Chat</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 720px; margin: 2rem auto; padding: 0 1rem; }
  form { display: flex; gap: 0.5rem; margin-bottom: 1rem; flex-wrap: wrap; }
  select { padding: 0.5rem; font-size: 1rem; }
  input { flex: 1; min-width: 12rem; padding: 0.5rem; font-size: 1rem; }
  button { padding: 0.5rem 1rem; font-size: 1rem; cursor: pointer; }
  #output { white-space: pre-wrap; border: 1px solid #ccc; padding: 1rem; min-height: 8rem; border-radius: 6px; }
  #meta { margin-top: 1rem; border: 1px solid #ddd; border-radius: 6px; padding: 0.75rem 1rem; background: #fafafa; font-size: 0.9rem; display: none; }
  #meta h2 { margin: 0 0 0.5rem; font-size: 1rem; }
  #meta dl { display: grid; grid-template-columns: max-content 1fr; gap: 0.25rem 1rem; margin: 0; }
  #meta dt { color: #666; }
  #meta dd { margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-all; }
</style>
</head>
<body>
<h1>Chat</h1>
<form id="form">
  <select id="model" name="model">${modelOptionsHtml}</select>
  <input id="question" type="text" placeholder="Ask a question..." autocomplete="off" required />
  <button id="go" type="submit">Ask</button>
</form>
<div id="output"></div>
<div id="meta"></div>
<script>
  const output = document.getElementById('output');
  const meta = document.getElementById('meta');
  const form = document.getElementById('form');
  const input = document.getElementById('question');
  const btn = document.getElementById('go');
  const modelSelect = document.getElementById('model');
  let es = null;
  let startedAt = 0;
  let firstTokenAt = 0;
  let lastChunk = null;
  let usage = null;

  function fmtNumber(n) {
    return typeof n === 'number' ? n.toLocaleString() : '—';
  }
  function fmtCost(n) {
    if (typeof n !== 'number') return '—';
    return '$' + n.toFixed(6);
  }
  function fmtMs(ms) {
    if (!ms || ms < 0) return '—';
    return ms < 1000 ? ms + ' ms' : (ms / 1000).toFixed(2) + ' s';
  }
  function row(dt, dd) {
    return '<dt>' + dt + '</dt><dd>' + dd + '</dd>';
  }
  function renderMeta() {
    const totalMs = Date.now() - startedAt;
    const ttftMs = firstTokenAt ? firstTokenAt - startedAt : 0;
    const completionTokens = usage?.completionTokens ?? usage?.completion_tokens;
    const promptTokens = usage?.promptTokens ?? usage?.prompt_tokens;
    const totalTokens = usage?.totalTokens ?? usage?.total_tokens;
    const cachedTokens = usage?.promptTokensDetails?.cachedTokens ?? usage?.prompt_tokens_details?.cached_tokens;
    const reasoningTokens = usage?.completionTokensDetails?.reasoningTokens ?? usage?.completion_tokens_details?.reasoning_tokens;
    const tps = completionTokens && totalMs ? (completionTokens / (totalMs / 1000)).toFixed(1) + ' tok/s' : '—';
    const rows = [
      row('Model', lastChunk?.model ?? '—'),
      row('ID', lastChunk?.id ?? '—'),
      row('Service tier', lastChunk?.serviceTier ?? lastChunk?.service_tier ?? '—'),
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
      es.close();
      es = null;
      btn.disabled = false;
      renderMeta();
    };
  });
</script>
</body>
</html>`;
}

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === '/api/hello') {
			const question = url.searchParams.get('q');
			if (!question) {
				return new Response('Missing q parameter', { status: 400 });
			}
			const model = url.searchParams.get('model') ?? undefined;
			const stub = env.CHAT_DURABLE_OBJECT.getByName('foo');
			const stream = await stub.ask(question, model);
			return new Response(stream, {
				headers: {
					'Content-Type': 'text/event-stream',
					'Cache-Control': 'no-cache',
					Connection: 'keep-alive',
				},
			});
		}

		if (url.pathname === '/' || url.pathname === '/index.html') {
			const models = await fetchTopModels(20);
			const optionsHtml = models
				.map((m) => `<option value="${escapeHtml(m.slug)}">${escapeHtml(m.label)}</option>`)
				.join('');
			return new Response(renderIndexHtml(optionsHtml), {
				headers: { 'Content-Type': 'text/html; charset=utf-8' },
			});
		}

		return new Response('Not Found', { status: 404 });
	},
} satisfies ExportedHandler<Env>;

# Interface — full project audit

Scope: performance, software architecture, DRY, testability, correctness & bugs.
Single-tenant, Cloudflare-Access-fronted; security findings are de-prioritised.

Findings are graded **P0** (data loss / hangs / hard breakage), **P1** (visible
bug, real perf cost, or pervasive design smell), **P2** (worth fixing when
nearby), **P3** (nice-to-have).

Numbers are line numbers in the file at the top of each section.

> **Status:** the bulk of the punch list below has been fixed in this branch
> (see git log). Skim §0 for the resolution map; the rest of the document is
> kept for context on what was changed and why. Specific line numbers may
> have drifted.

---

## 0. Resolved in this branch

The following findings have been addressed; numbers reference the sections
below.

P0 / P1:
- §1 #1 — DO schema versioning (now a `_meta.schema_version` row + an
  append-only `MIGRATIONS` array; legacy ALTERs replay safely once).
- §1 #2 — `MAX_TOOL_ITERATIONS` boundary appends an info part instead of
  silently dropping the model's response.
- §1 #3 — OpenRouter double-finalisation: tool-call finalisation hoisted to
  a single `finalizeToolCalls` helper guarded by `emittedDone`.
- §1 #4 — Tool calls/results persisted inside the inner loop; abort
  synthesises tool_results for any unmatched tool_use.
- §1 #6 — `thinking` and `reasoning.max_tokens` no longer overwrite each
  other in `AnthropicLLM`; the DO picks one based on the routed provider.
- §1 #7 — MCP tool descriptors cached per-DO with TTL; client reused per
  server.
- §1 #8 — `fetch_url` streams the body and cancels the reader at the cap.
- §1 #9 — `compactHistory` subtracts cached tokens and uses the correct
  drop-index fallback.
- §1 #10 — Server-rendered markdown persisted in `messages.content_html` /
  `thinking_html` / `parts_html` / `artifacts.content_html`; SSR re-renders
  only what's missing.

P2:
- Sub-agent results forward `citations`/`artifacts` to the parent loop;
  `ChatRequest.signal` plumbed through both adapters and the sub-agent.
- Theme cached in-isolate (30s TTL) with explicit invalidation on save.
- SDK clients cached in `routeLLM` (one Anthropic / one OpenRouter per
  api key).
- `compactHistory` now takes an injectable LLM factory.
- Streaming markdown cache prunes entries for messages no longer in state.
- Streaming `appendDeltaPart` mutates the trailing same-kind part rather
  than allocating a new object per token.
- Auto-scroll keyed on a content-length signature, not the whole array
  reference.
- Compose form snaps `selectedModel` back into the curated list when the
  current selection vanishes.
- `formatError` extracted to `errors.ts` (Anthropic, OpenRouter, DO all
  use it).
- Title generation deduped behind one `#writeTitle` helper.
- `COMPLETE_PREDICATE` SQL constant.
- `confirmSubmit` / `justSubmit` form-action helpers replace 15+ inline
  handlers.
- `clickOutside` Svelte action consolidates the dropdown-close pattern.
- `KNOWN_SECRET_KEYS` is now the single source of truth for the optional-
  secret list (mirrored in `app.d.ts` with a cross-reference comment).
- `xhigh` preset id matches the reasoning effort name.
- `fmtCost` auto-scales decimal precision.
- Tool registry returns `errorCode` on failures.
- `web_search` clamps `count` to [1, 10] before hitting the backend.
- `ynab_update_transaction` skips the redundant GET when the caller
  supplies all replacement fields.
- `ynab_list_transactions` mutates in place rather than chaining
  filter/sort/slice/map across separate iterations.
- `Date.now`/`crypto.randomUUID` wrapped behind `src/lib/server/clock.ts`
  for deterministic tests.
- `FakeLLM` fixture + DO `__setLLMOverride` RPC method enable end-to-end
  `#generate` tests; new tests cover happy path, iteration cap, persisted
  HTML, and migration version.

Deferred (per the audit's own §8 "do not fix yet" note):
- Heavy YNAB DRY refactor (works, isolated, churn-prone).
- `csrf.trustedOrigins` (correct as-is behind Access).
- Bootstrap tree-shake (cosmetic).

---

## 1. Top findings (read first)

1. **DO has no schema versioning** — inline idempotent `ALTER TABLE` lists in
   `ConversationDurableObject` (lines 155–184). Every cold start replays them,
   you can never drop a column, and there's no way to verify the schema
   matches the code. **P0** — fix before the schema grows further.
2. **`MAX_TOOL_ITERATIONS` boundary loses tool calls.** When iteration `N-1`
   produces tool calls, they're appended to the message history (line 560)
   then the loop exits without executing them. The model sees an unanswered
   `tool_use` block in the next turn. **P0** — easy fix, one line.
3. **OpenRouter adapter can yield the same `tool_call` event twice** when a
   stream emits a `finishReason` and ends in the same chunk: the
   `partialToolCalls` map is iterated once at line 71–82 and again at line
   91–101. The `emittedDone` flag only guards the `done` event, not the tool
   finalisation. **P0**.
4. **Tool calls and results can desync on stream death / abort mid-loop.**
   `accumulatedToolCalls` is appended *before* execution (line 552), the
   final `UPDATE` writes both lists in one statement (line 624). If the
   stream dies between, you persist a tool_use without its result. **P1** —
   add per-call atomic persistence.
5. **No SQLite transactions for multi-statement writes.** `addUserMessage`
   does two separate `INSERT`s (lines 218–229) plus an in-memory mutation;
   `#generate` makes several `UPDATE`s and a D1 write at the end. A failed
   insert leaves the conversation half-written. **P1**.
6. **Reasoning vs thinking config silently overwrite each other** in
   `AnthropicLLM.ts:46–51`. If a caller sets both `request.thinking` and
   `request.reasoning.type === 'max_tokens'`, the second one wins with no
   warning. The DO always sets at least one and sometimes both (lines
   480–493). **P1**.
7. **MCP tool list is re-fetched on every generation** and a fresh
   `McpHttpClient` is instantiated *per tool call*
   (`ConversationDurableObject.ts:737, 748`). Two avoidable network round
   trips per turn per server. **P1**.
8. **`fetch_url` reads the entire body into memory before applying the cap**
   (`fetch_url.ts:100`). Cap exists, but a hostile or buggy origin can OOM
   the worker. **P1**.
9. **`compactHistory` uses prior-turn `inputTokens` directly** without
   subtracting cached tokens (`context.ts:60`). Models with heavy prompt
   caching trigger compaction earlier than necessary. **P2**.
10. **`crypto.randomUUID` and `Date.now` are called unmediated all over the
    DO**, blocking deterministic tests. The DO test suite is solid but can't
    verify temporal/uuid semantics. **P2** — wrap them in injectable helpers.

---

## 2. Correctness & bugs

### 2.1 Durable Object (`src/lib/server/durable_objects/ConversationDurableObject.ts`)

#### `MAX_TOOL_ITERATIONS` final-iteration data loss — **P0**

`#generate`, lines 505–615. On the last iteration, the inner stream loop can
push tool_use blocks into `messages` (line 560) and append to
`accumulatedToolCalls` (line 552), then the outer `for (iteration < MAX)`
exits without executing them. The persisted record at line 624 contains tool
calls with no matching results. The model is then called with an unmatched
`tool_use` on the next user turn → 400 from Anthropic ("Each `tool_use` block
must have a corresponding `tool_result`").

Fix: if `iteration === MAX_TOOL_ITERATIONS - 1` and `turnToolCalls.length >
0`, synthesize tool_result blocks with `isError: true, content: 'Tool
iteration budget exhausted'` so the trailing `tool_use` blocks are paired
before persistence.

#### Tool-call / tool-result atomicity — **P1**

`#generate`, lines 552–615. Concurrent abort or stream death between
"appended call" and "executed call" leaves the persisted state
inconsistent. The eventual `UPDATE` at line 624 writes
`accumulatedToolCalls` and `accumulatedToolResults` together, but they're
populated at different points in the loop.

Fix: persist `tool_calls` / `tool_results` columns inside the loop, after
each tool executes — or push the accumulator update to immediately after
result resolution (line 585) rather than between iterations.

#### `#inProgress` race on concurrent abort — **P1**

`#generate`, lines 517–544. The text/thinking deltas mutate
`this.#inProgress.content` after re-checking the guard, but
`abortGeneration()` (lines 281–292) clears `this.#inProgress` synchronously.
The guard on lines 522–523 is duplicative — it's already checked on line
517 — and the structure invites future maintenance bugs. The interleaving
also means `appendText/appendThinking` mutate `parts` (the live mirror)
even after abort.

Fix: capture `const ip = this.#inProgress` at the top of `#generate`, drop
all the `if (this.#inProgress?.messageId === assistantId)` checks in the
hot path, and only check at iteration boundaries. Or use an `AbortSignal`
that you can pass into `llm.chat()` to cut the stream.

#### Schema migration strategy — **P0** (architecture)

Constructor, lines 155–184. The DO runs
```ts
'ALTER TABLE messages ADD COLUMN started_at INTEGER',
'ALTER TABLE messages ADD COLUMN first_token_at INTEGER',
…14 more
```
in a try/catch on every cold start. Three problems:

1. No version table → can't tell whether a DO is at v3 or v8.
2. Can't ever drop a column or rename one without leaving permanent dead
   ALTERs.
3. Schema is in code, not in `migrations/` (D1's) — divergent strategies
   for the two stores.

Fix: introduce a `_meta` table with `schema_version`, run migrations as
versioned `if (current < 3) {…; current = 3}` blocks. Allow drops and
renames. See how `migrations/` is structured for D1; mirror that locally.

#### Streaming row recovery is silent and lossy — **P2**

Constructor line 185:
```ts
"UPDATE messages SET status = 'error', error = 'Generation interrupted' WHERE status = 'streaming'"
```
Triggers on every cold start. If the worker is recycled cleanly mid-stream
(no actual error), every in-flight conversation is marked errored. The
"Generation interrupted" message can't be distinguished from a real
provider failure.

Fix: include reason context (`'DO restart'`) so debugging is possible, and
consider a retry-from-where-we-left-off path for `streaming` rows whose
`#inProgress` content was already broadcast.

#### `partsHasIt` in `applyToolCall` blocks the no-op — **P3** (correctness)

`conversation-stream.ts:80`. The check `parts.some(p => p.type === 'tool_use'
&& p.id === ev.id)` correctly dedupes, but coupled with the dedupe in
`toolCalls`, you can end up with the same `tool_use` part appearing twice
on legacy/replayed data because the live mirror seeds `parts` from server
timeline (`#inProgress.parts`) and the DO already pushes a `tool_use` part
on line 565. Verify with a test that replays a sync mid-tool.

---

### 2.2 LLM adapters (`src/lib/server/llm/`)

#### OpenRouter — duplicate `tool_call` events — **P0**

`OpenRouterLLM.ts:70–104`. When `choice.finishReason` is set on the same
chunk that ends the iterator, the partial-tool-calls map is finalised at
lines 71–82 *and* at lines 91–101. `emittedDone` only protects the `done`
event. Real-world impact: depending on provider, the DO will record the
same tool_use ID twice and execute the tool twice.

Fix:
```ts
if (choice.finishReason || /* end of stream sentinel */) {
  for (const tc of partialToolCalls.values()) { … }
  partialToolCalls.clear();
  if (!emittedDone) {
    emittedDone = true;
    yield { type: 'done', finishReason: choice.finishReason, raw: lastChunk };
  }
}
```
Hoist the loop body out; gate only the `yield done` on `emittedDone`.

#### Anthropic — `thinking` vs `reasoning.max_tokens` overwrite — **P1**

`AnthropicLLM.ts:46–51`. If both are set, the second branch wins silently.
The DO sometimes sets both (`ConversationDurableObject.ts:480–493`):
- `reasoning` is set when `reasoningType` is `'max_tokens'` or `'effort'`.
- `thinking` is set when `isNativeAnthropic && thinkingBudget > 0`.

For a native-Anthropic call with `reasoningType='max_tokens'`, both fire,
and `reasoning.maxTokens` (which equals `thinkingBudget` here, so it's
benign in practice) overwrites. But the contract is a footgun.

Fix: pick one in the DO (`isNativeAnthropic` ? `thinking` : `reasoning`) and
remove the redundant branch in the adapter, or document precedence in
`LLM.ts:43–49` and have the adapter throw when both are set.

#### `compactHistory` cache-token undercount — **P2**

`context.ts:60`. `lastUsage?.inputTokens` is the *full* input including
cache reads. If your previous turn was 100k cached + 5k fresh, you measure
105k and trigger compaction even though the actual billable / usable
prompt was only 5k.

Fix: subtract `cacheReadInputTokens` to estimate fresh tokens, then add
back the messages-since-last-turn estimate.

#### `compactHistory` drop-index off by one — **P2**

`context.ts:78–90`. The fallback branch `dropIndex = Math.floor(i / 2)`
when no fit was found is using the loop variable `i` (which after the
final iteration is `messages.length - minKeep`). For a 20-message
conversation with `minKeep = 4`, that drops 8. Probably fine, but the
intent is unclear and the math doesn't actually guarantee fitting the
threshold — the function falls through with `dropIndex` set, ignoring
that no slice satisfied the constraint.

Fix: explicitly bail with `wasCompacted: false` if no slice fits, or
escalate `dropIndex` to `messages.length - minKeep` (the maximum allowed).

#### Anthropic adapter — `tool` role becomes `user` — **P3**

`AnthropicLLM.ts:128–132`. Tool-result messages are wrapped as `user` with
a `tool_result` block. That's the correct Anthropic shape, but the comment
says "Phase 3b will materialize" — we're past Phase 3b given the DO loop is
fully wired. Either the comment is stale (most likely) or the adapter is
still in a transition state.

Fix: remove the comment.

#### OpenRouter — `flattenToText` drops everything that isn't text — **P2**

`OpenRouterLLM.ts:173–180`. Tool-use blocks in assistant messages are
re-emitted via `toolCalls` (line 158), which is correct for assistant
turns. But for `user` messages (line 138), any non-text block is silently
dropped — the multi-modal contract in `LLM.ts` allows `image` and `file`
blocks on user turns.

Fix: either widen `toOpenRouterMessage` to surface images via
`{ role: 'user', content: [...] }`, or document and validate that
non-text content in user messages is unsupported on the OpenRouter path.

#### `formatError` duplicated in three places — **P2** (DRY)

Identical 11-line function in `AnthropicLLM.ts:195–205`,
`OpenRouterLLM.ts:195–205`, and (slightly different name)
`ConversationDurableObject.ts:69–79`. Extract to a shared
`src/lib/server/llm/errors.ts`.

#### `routeLLM` instantiates a fresh SDK client per call — **P2**

`route.ts:11–24`. Both `Anthropic` and `OpenRouter` clients are recreated
on every chat turn and every compaction call. SDK clients usually maintain
a fetch agent / connection pool internally; tossing them out per call
defeats that. Cache one client per provider at module scope, keyed by env
key fingerprint.

#### `_clearModelsCache` is exported only for tests — **P3**

`openrouter/models.ts:62`. Underscore prefix + comment "Exposed for
testing." is fine, but consider moving the cache to an injected store so
production code never sees the test seam.

---

### 2.3 Tools (`src/lib/server/tools/`)

#### `agent` tool: sub-agent results never propagate citations or artifacts — **P1**

`agent.ts:208–229`. The inner `innerRegistry.execute(...)` returns a full
`ToolExecutionResult` (with `citations` and `artifacts`), but only
`content` and `isError` are passed back to the parent. A sub-agent that
calls `web_search` or writes a sandbox artifact loses all of that data.

Fix: thread `result.citations` / `result.artifacts` up through the
agent-tool's outer `execute` return so the parent loop's
`accumulatedCitations` and `addArtifact` paths see them.

#### `agent` tool: `signal` not propagated to inner LLM call — **P2**

`agent.ts:147–151`. `ChatRequest` lacks a `signal` field — that's a
limitation in `LLM.ts`, but the inner loop also can't react to parent
cancellation (it doesn't observe `ctx.signal` anywhere). When the parent
generation is aborted, the sub-agent keeps spinning until it hits its
iteration cap.

Fix: add `signal?: AbortSignal` to `ChatRequest` and have both adapters
forward it; have `agent.ts` pass `ctx.signal` and abort the iteration loop
when it fires.

#### `agent` tool: max-iterations exhaustion is conflated with empty answer — **P3**

`agent.ts:232–238`. If the sub-agent stops normally with empty text, you
return "exhausted its N-iteration budget without producing a final
answer", which is misleading. The empty-text-but-stopped case should say
"returned an empty response".

Fix: track whether the loop hit the cap or broke early, and word the error
accordingly.

#### `fetch_url`: full body buffered before cap — **P1**

`fetch_url.ts:100`. `await res.text()` reads everything; the cap is
applied on the resulting string. A 1 GB origin OOMs the worker even
though we'd only use 256 KB.

Fix: stream the response with `res.body!.getReader()`, accumulate up to
`cap` bytes, then `cancel()` the reader. Wrap with the existing
content-type sniff and Readability path.

#### `fetch_url`: `isError` returned even for redirected-but-OK responses — **P3**

`fetch_url.ts:117`. `isError: !res.ok`. A 3xx that didn't follow (because
`redirect: 'follow'` was set, but the SDK still surfaces the final 4xx)
sets `isError: true` even when content was extracted successfully and
returned in `body`. Acceptable but worth documenting.

#### `web_search`: `count` is not validated — **P3**

`web_search.ts:27`. The schema says `minimum: 1, maximum: 10` and the LLM
is supposed to honour it, but if the model ignores the schema (e.g.
`count: -1`), the backend gets a junk argument. `KagiSearchBackend`
clamps with `Math.min(count, 25)` (line 33) but doesn't guard the lower
bound.

Fix: clamp `count` to `[1, 10]` after parsing.

#### `ynab.ts`: massive boilerplate, single source of truth missing — **P2** (DRY)

`ynab.ts` is 736 lines, mostly:
- 10 `function …Tool(token: string): Tool` factories with the same shape.
- The `(input ?? {}) as { … }` cast + `if (!args.budget_id) return err(...)`
  preamble in 8 of them (lines 260, 290, 330, 363, 422, 547, 632, 698).
- `await call(() => api.X.foo(...))` + `if (isError(result)) return err(...)`
  pattern in every read path.
- Three near-identical `slim*` mappers (lines 81–94, 111–126, 160–190).

Fix sketch:
```ts
function ynabTool<I, R>(
  meta: { name: string; description: string; inputSchema: object; required: (keyof I)[] },
  exec: (api: ynab.api, args: I) => Promise<R>,
): Tool { … }
```
That collapses each tool to ~8 lines. The slim mappers can be derived
from a single field-list per resource.

#### `ynab.ts` — `updateTransactionTool` always reads first — **P2**

Lines 637–641. The PUT API requires the full transaction, so the tool
always issues a GET before the PUT. For a turn where the LLM provides
every field, this is a wasted round-trip (and YNAB rate-limits at 200
req/hour).

Fix: skip the GET when *all* required PUT fields are present in `args`.

#### `ynab.ts` — `listTransactionsTool` does N passes over results — **P3**

Lines 466–470. `filter().sort().slice().map()` is O(4N). For 5000
transactions (a year of activity) that's 20k iterations. Probably fine in
practice but combinable into a single pass with a min-heap.

#### `sandbox.ts`: SSH-key injection cache is module-level — **P2**

`sandbox.ts:18`. `sshKeyInjected` is a `Set<string>` keyed by
`conversationId`, scoped to the worker isolate. It will be wrong:
- After an isolate restart (set is empty, key gets re-injected — fine).
- When conversations are deleted and IDs are eventually reused (unlikely
  with UUIDs, so okay).
- If the SSH key rotates: every conversation believes it's already
  injected. Operators have to wait for an isolate cycle.

Fix: include a hash of the key in the cache key, or invalidate when
`SANDBOX_SSH_KEY` changes.

#### MCP client recreated per call — **P1**

`ConversationDurableObject.ts:748`. The closure stored in the registry
captures `url, authJson` and instantiates a new `McpHttpClient` *every
single tool call*. That's also a fresh `#nextId = 1` counter — fine for
single requests, but no connection reuse.

Also `ConversationDurableObject.ts:737`: tool list is re-enumerated on
every generation (each call to `#buildBaseToolRegistry`), even when
nothing about the server config changed.

Fix: per-DO cache of `McpHttpClient` + tool descriptors, keyed by server
ID with TTL or invalidate on settings change.

#### Tool registry execute swallows error type — **P3**

`registry.ts:60–73`. Any throw → `{ content: e.message, isError: true }`.
The caller can't differentiate "tool not found" (line 63) from "tool
threw" (line 67). For a model trying to recover, the distinction matters.

Fix: include a discriminated error code, e.g.
`isError: true, content: …, errorCode: 'not_found' | 'execution_failure'`.

---

### 2.4 Frontend (`src/routes/`, `src/lib/components/`)

#### Race in `+page.svelte`'s SSE attach — **P2**

`src/routes/c/[id]/+page.svelte:69–82`. The `$effect` attaches a stream
keyed on `data.conversation.id`. If the user navigates A → B → A quickly,
two attach/detach cycles happen, but Svelte re-runs the effect with the
*new* id before the `return () => detach()` from the prior id resolves.
Defensive — the effect's return is awaited synchronously by Svelte — but
worth verifying with an integration test.

#### Streaming markdown renderer cache grows unbounded — **P2**

`streaming-markdown.ts:22`. `renderedTextByKey` accumulates entries keyed
by `${messageId}:${index}` and never drops them. For a 200-message
conversation that's 200 entries plus all the rendered HTML strings (which
can be substantial). Disposed only when the page unmounts — and the page
component is reused across conversations (per the comment on line 67),
so navigation alone doesn't free it.

Fix: prune entries whose `messageId` is no longer in `state.messages`, or
dispose-and-recreate on conversation change (the existing
`currentConversationId` effect on lines 21–27 is the right hook).

#### `applyDelta` reallocates `parts` on every token — **P2**

`conversation-stream.ts:46–57`. Every text/thinking delta produces a new
`parts` array (`[...parts.slice(0,-1), { ...newPart }]`). For a 5000-token
stream that's 5000 array spreads. With `Message.svelte` reading `parts`
reactively, each spread can also re-render every Message child for any
shape change.

Fix: mutate the last part in place when it's the same kind, or batch
deltas at the runner layer (similar to how
`createStreamingMarkdownRunner` already throttles re-renders to one
animation frame).

#### Scroll-to-bottom reaches into raw `convState.messages` — **P3**

`+page.svelte:107–115`. `void convState.messages` triggers the effect on
*any* change, including parts updates that don't actually grow the
content. On a fast stream that fires a `requestAnimationFrame` per
delta, scheduling redundant scroll resets.

Fix: depend on `convState.messages.length` and the last message's `content`
length, rather than the array reference.

#### Compose form: model can be selected that no longer exists — **P3**

`ComposeForm.svelte:30, 54–57`. `selectedModel` is initialised once from
`defaultModel`. If the user edits their model list in /settings and
navigates back, the dropdown still shows the stale slug; the form
submits with it; the DO returns 400 (`unknown model`) only if the slug
doesn't match anything routeable.

Fix: validate against `models` on every prop update, falling back to
`models[0]?.slug` if the current selection is gone.

#### Settings form: `serializedModels` recomputed on every keystroke — **P3**

`+page.svelte:27–42`. `JSON.stringify(...)` is recomputed inside `$derived`
for each character typed in any input. Cheap (small array) but
unnecessary; debounce or compute only on submit.

#### `contentHtml`/`textHtml` fallback shows raw text — **P3**

`Message.svelte:35, 48, 95`. When server-rendered HTML is missing, the
component falls back to `{part.text}` with `white-space: pre-wrap`. That's
plain-text, escaped by Svelte — safe — but it loses formatting and breaks
the visual contract (no headings/code blocks). Worth a "rendering…"
indicator.

#### Sidebar `now` captured at render time — **P3**

`AppShell.svelte:23`. `const now = Date.now()` is evaluated on each
component mount; relative timestamps freeze until navigation. Acceptable
for a sidebar but mark it.

#### `details` dropdowns lack click-outside on most pages — **P3**

`ComposeForm.svelte:81–89` correctly closes on outside `pointerdown`.
`+page.svelte:139–160` (the conversation menu) doesn't. Settings drawers
don't. Inconsistent UX.

Fix: extract a `clickOutside` Svelte action and apply consistently.

---

### 2.5 Server-side rendering (`src/routes/c/[id]/+page.server.ts`)

#### Markdown rendered on every load — **P1**

Lines 23–43. Every assistant message's `content` and `parts` is re-rendered
through `marked` + Shiki + KaTeX on every page load. For a 100-message
conversation with code blocks, that's hundreds of Shiki tokenisations
per request.

Fix: cache rendered HTML in the DO message row alongside the raw content
(write at completion, read at load). Already partly done — the type
allows `contentHtml`/`textHtml` — just no persistence layer. Cost: one
column per text part.

#### `withRenderedMarkdown` runs all messages in parallel — **P3**

Line 24. `Promise.all` is fine when the highlighter is warm, but the
first request after a worker spin-up serially awaits
`createHighlighter` from each call. The `getHighlighter()` lazy
initialisation in `markdown.ts:30` is single-flight via promise-cache, so
the parallel awaits funnel to one creation — fine. Just confirm in a
local cold-start trace.

---

### 2.6 Hooks (`src/hooks.server.ts`)

#### Theme read from D1 on every request — **P2**

Lines 22–28. Every page (and every navigation that triggers a reload)
fetches `theme` from D1. Single user, low traffic, but trivially
cacheable in a module-scope `Map<string, theme>` keyed by user ID with a
short TTL. Or stash in a cookie / localStorage and read on the client.

#### `csrf.trustedOrigins: []` is correct — **P3** (note)

`svelte.config.js:18`. With Cloudflare Access in front, this is fine.
Documented for the future when you add a non-browser client.

---

## 3. Performance

In rough order of payback (highest first):

1. **Cache MCP tool descriptors per DO** (P1, see §2.3). Shaves ~1 round
   trip per generation per server.
2. **Persist server-rendered markdown** (P1, §2.5). Drops O(n) Shiki/
   KaTeX work from the page load to once-per-message.
3. **Reuse SDK clients in `routeLLM`** (P2, §2.2). Drops connection setup
   per chat turn.
4. **Stream `fetch_url` body to the cap** (P1, §2.3). OOM safety + faster
   for large pages.
5. **Mutate streaming `parts` instead of cloning** (P2, §2.4). Bigger wins
   on long generations and weak clients (mobile).
6. **Cache theme in `hooks.server.ts`** (P2, §2.6). One D1 query per
   request → zero in steady state.
7. **Cache the per-DO tool registry** (P2). One D1 round for sub-agents +
   model list per turn → one per N turns.
8. **Strip `JSON.parse` per message row in `#readMessages`** (P2). Cache
   parsed forms in memory while the DO is alive.
9. **Drop the `setInterval` ping when no subscribers** (P3). It's already
   conditional on first attach; verify it actually clears (it does, via
   `#stopPingIfEmpty`).
10. **Combine YNAB list filter/sort/slice/map into one pass** (P3). Tiny.

---

## 4. Architecture

### 4.1 D1 vs DO ownership is fuzzy

D1 owns: `conversations` (title, archived, thinking_budget), `settings`,
`mcp_servers`, `sub_agents`. DO owns: `messages`, `artifacts`.

Friction:
- The DO calls D1 to fetch sub-agents, MCP servers, and model list
  *during a generation* (`#generate` on lines 464–471, 707–710). That's
  three serial round trips, mitigable by reading D1 once and caching for
  the conversation lifetime in DO memory.
- `conversations.updated_at` is updated from the DO twice per turn —
  once when the user message lands (`#touchConversation`, line 967), once
  on completion (line 638). Single update at completion would be enough
  unless you want sidebar ordering to reflect typing.
- The conversation title is generated asynchronously inside the DO
  (`#generateTitle`, lines 983–1023) and written to D1. If two messages
  arrive within ~5 seconds (rare), two title generations race. The
  `CASE WHEN title = 'New conversation'` guard on line 1007 makes it
  idempotent — fine — but worth a comment.

Recommendation: read D1 *once* per generation into the DO, expose a
small `ConversationContext` snapshot. Reduces D1 load and removes the
"is this stale?" question for the duration of a turn.

### 4.2 Parts/tool-calls/tool-results triple-storage

Every assistant turn ends up serialised three ways:
- `parts` JSON (the canonical timeline).
- `tool_calls` JSON (legacy duplicate).
- `tool_results` JSON (legacy duplicate).

`buildLegacyParts` (lines 53–67) reconstructs `parts` from the legacy
columns. The forward-compat strategy is to keep writing all three so
old clients work, but: those columns are server-only, the only consumer
is the same code path that writes them. Pick one (`parts`), drop the
others, run a one-shot migration.

### 4.3 `routeLLM` couples model strings to providers loosely

`route.ts:29` defines an "Anthropic model" by `slug.startsWith('claude-')`.
That's fine until OpenRouter ships a non-claude Anthropic model (Haiku
3.7 etc are still claude-prefixed; safe). But the same logic is
*duplicated* at `ConversationDurableObject.ts:490` (`isNativeAnthropic`).

Fix: import and reuse `isAnthropicModel` from `route.ts`.

### 4.4 Tool result shape is inconsistent

`ToolExecutionResult.content: string` forces every tool to flatten its
output. `web_search` ends up serialising titles+URLs+snippets into a
plain string (line 41–47). `ynab.ts` `JSON.stringify`s objects. `fetch_url`
prepends a header line. All of those would be cleaner as structured
content the renderer can format consistently.

Recommendation (deferred): support `content: string | ContentBlock[]` in
results, and let the DO/UI render structured blocks. Costs: small
adapter changes; benefits: drop ad-hoc formatting in every tool.

### 4.5 Sub-agents can't be tested or driven independently

`agent.ts` is wired up such that the only way to invoke it is through
the DO's tool registry. The constructor takes a `buildInnerToolRegistry`
factory (good) but the inner loop's LLM call happens via the same
`routeLLM` injection point.

For testing, the test suite would have to spin up the entire DO and
replay tool calls. The sub-agent loop is itself a small reusable
agent runtime; consider promoting it to a standalone module that
takes (LLM, ToolRegistry, prompt) → result, reusable in CLI / tests
without DO involvement.

### 4.6 `csrf.trustedOrigins: []` + remote functions

`svelte.config.js:17–19`. With Cloudflare Access in front, CSRF is
defended by the access cookie. Fine. Document this so the next person
to look doesn't add a CSRF middleware "to be safe".

---

## 5. DRY

### 5.1 `formatError` × 3

`AnthropicLLM.ts:195`, `OpenRouterLLM.ts:195`,
`ConversationDurableObject.ts:69`. Three near-identical implementations
of "trim error to 500 chars". Hoist to `src/lib/server/llm/errors.ts`.

### 5.2 SQL filter predicate `status = 'complete' AND deleted_at IS NULL` × 4

Lines 242, 407, 419, 766. A constant named `COMPLETE_PREDICATE = "status =
'complete' AND deleted_at IS NULL"` would do, or a small helper that
returns the prepared statement.

### 5.3 Title-generation logic × 2

`regenerateTitle` (lines 240–272) and `#generateTitle` (lines 983–1023)
share ~80% of their bodies. The differences:
- Source: full transcript vs first user message.
- Update guard: unconditional vs `CASE WHEN title = 'New conversation'`.

Extract to `#generateTitleFromText(conversationId, text, { unconditional: bool })`.

### 5.4 LLM tool finalisation

Both adapters have a near-identical "iterate `partialToolCalls`,
`JSON.parse(args)` with `_raw` fallback, yield `tool_call`" block.
~12 lines duplicated. See §2.2 fix for OpenRouter.

### 5.5 LLM message normalisation

`AnthropicLLM.toAnthropicMessages` and `OpenRouterLLM.toOpenRouterMessage`
both handle the `string | ContentBlock[]` content shape with a one-line
"is this a string? wrap it" expression. A shared
`normalizeBlocks(content) -> ContentBlock[]` would clean both up.

### 5.6 YNAB tool boilerplate

See §2.3. ~10 tools × ~30 lines of identical scaffolding.

### 5.7 Form `enhance` repeated everywhere

15+ instances of
```svelte
{...someForm.enhance(async ({ submit }) => { await submit(); })}
```
across `+page.svelte`, archive, and settings. A trivial helper:
```ts
export const justSubmit = async ({ submit }) => { await submit(); };
```
…and `{...someForm.enhance(justSubmit)}` everywhere.

### 5.8 Confirm-then-submit pattern × 3

`+page.svelte:152`, `archive/+page.svelte:39`, `settings/+page.svelte:78,
85`. Same code:
```ts
if (!confirm(`Delete X?`)) return;
await submit();
```
Helper:
```ts
const confirmSubmit = (msg: string) => async ({ submit }) => {
  if (!confirm(msg)) return;
  await submit();
};
```

### 5.9 Idempotent ALTER list (DO constructor)

§2.1 — really a schema strategy issue, but symptomatically a 14-line
hand-maintained list.

---

## 6. Testability

### 6.1 The good

- `parts.ts`, `sidebar.ts`, `thinking-presets.ts`, `formatters.ts` are
  pure modules carved out of the Svelte components. Excellent.
- `route.ts:isAnthropicModel`, `models/config.ts:reasoningTypeFor`,
  `parseModelList` — pure, easy to test.
- `vitest-pool-workers` is configured correctly with a stub worker
  entry. The DO is testable end-to-end in `runInDurableObject`.
- D1 migrations replayed in `setup.ts` — clean foundation.
- `app-server.ts` shim for `$app/server` — clever and minimal.

### 6.2 The gaps

- **No deterministic clock**. `Date.now()` is called all over (lines
  214, 228, 372, 401, 638, 967 in the DO; many places elsewhere). Any
  test that wants to assert timestamps has to hope they fall within a
  range. Wrap once: `const now = (env.NOW ?? Date.now)()` and inject in
  tests. Same story for `crypto.randomUUID`.
- **No abort path tests for `#generate`**. The DO test suite never runs
  a full `#generate` — only the schema-and-state checks. The riskiest
  code paths (tool-call iteration, abort, stream death) are uncovered.
  The fix is non-trivial: you need a fake LLM. The good news is the
  `LLM` interface is small enough that a `FakeLLM` with a recorded
  event list would work.
- **`compactHistory` tests can't easily mock the inner LLM** —
  `routeLLM(env, model)` is called inside (line 98). Inject an `llm:
  LLM` parameter (or a factory).
- **Tools that call external SDKs are not unit-testable**. `ynab.ts`
  reaches out to YNAB; tests have to mock the SDK module-globally.
  Each tool factory should accept its dependencies (e.g. `(deps: {
  api: ynab.api })`) so tests pass a fake.
- **No browser/component tests**. Acknowledged in `vitest.config.mts`
  (line 32–33). For a single-user app, that's a reasonable trade-off,
  but `streaming-markdown.ts`, `conversation-stream.ts` apply functions
  are pure and testable — they're already tested. The orchestration
  (`attachConversationStream`) is not.
- **`fetch` is not mocked anywhere** for the search/MCP/fetch_url paths.
  Tests for those tools would need `vi.spyOn(globalThis, 'fetch')` or
  an injected fetcher.
- **`getRequestEvent()` shim throws** if mock not set. Several test files
  may rely on remote-function imports without setting it. Verify by
  running `npm run test`.

---

## 7. Smaller items / nits

- `wrangler.jsonc:13` `compatibility_date: 2026-04-22`, but
  `wrangler.test.jsonc:11` is identical — fine, but tests should use a
  different date if you want forward-compat warnings to surface.
- `app.scss` and bootstrap CSS are imported globally
  (`+layout.svelte:2`). Bootstrap is heavy; you only use a handful of
  utilities. Consider tree-shaking via the modular Bootstrap entry or
  switching to Tailwind/UnoCSS.
- `package.json:1` — `"name": "interface"` and `"version": "0.0.0"`. Fine
  for a private worker, but bump the version when shipping changes for
  diagnostic value (Sentry/observability).
- `marked-katex-paren.ts` has been written from scratch — solid little
  module, well-documented. Worth a public-domain release if you want.
- `app.d.ts:35–46` — provider keys are listed manually; they'll drift
  from `KNOWN_SECRET_KEYS` in `settings.ts:90`. Single source of truth.
- The `JsonValue = any` escape hatch (`types/conversation.ts:43`) is
  pragmatic and well-documented; the comment says it's because
  `Serializable<>` rejects `unknown`. Consider a narrower
  `JsonPrimitive | JsonArray | JsonObject` recursive type to at least
  forbid `undefined` and functions.
- `fmtCost` (`formatters.ts:5–8`) always shows 6 decimal places, even
  for `$0.012345` → `$0.012345`. For larger costs that's noise.
  Round to 4 decimals or auto-scale.
- `fmtRelative` (`formatters.ts:20–26`) doesn't pluralise; "1m ago"
  and "5m ago" are fine. "1h ago" and "1d ago" too. Acceptable.
- `THINKING_PRESETS` (`thinking-presets.ts:7`) has an `'extra-high'`
  preset at 32k. `budgetToEffort` in the DO (`ConversationDurableObject.ts:1085`)
  buckets `> 16384` as `'xhigh'`. Inconsistent naming
  (`extra-high` vs `xhigh`). Easy alignment.
- `logLevel: 'error'` in `vitest.config.mts:16` will hide vitest's own
  warnings too, not just sourcemap noise. Consider `vite.silent` or a
  more targeted filter.
- `wrangler.jsonc:30` `max_instances: 10` for the Sandbox container.
  Fine for one user. Document as such.
- `placement: { mode: 'smart' }` (`wrangler.jsonc:58`) is great for
  proximity to D1, but with the DO sharing the same region you may
  prefer a fixed region during testing.

---

## 8. Concrete next steps

In order, smallest-payoff-first:

1. Fix the OpenRouter double-finalisation (§2.2) — 5 line change.
2. Fix the `MAX_TOOL_ITERATIONS` last-iteration loss (§2.1) — 10 lines.
3. Cache MCP tool descriptors per DO (§2.3, §3) — ~30 lines.
4. Cache `routeLLM`'s SDK clients (§2.2) — ~15 lines.
5. Stream `fetch_url`'s body to the cap (§2.3) — ~25 lines.
6. Add a `FakeLLM` and write at least one happy-path `#generate` test
   that exercises the tool loop (§6.2) — bigger lift, biggest payoff.
7. Persist server-rendered markdown alongside raw content (§2.5) —
   schema change + a write path; pays off on every page load.
8. Hoist `formatError` (§5.1) — trivial.
9. Wrap `Date.now` and `crypto.randomUUID` (§6.2) — paves the way for
   proper integration tests.
10. Introduce a real DO migration table (§2.1) — this one is *the*
    slow-burn project. Plan it before the schema grows again.

Things to *not* fix yet (deferred, low payoff):
- YNAB DRY refactor (§2.3, §5.6) — works, isolated, churn-prone.
- `csrf.trustedOrigins` (§4.6) — fine as-is.
- Bootstrap tree-shake — cosmetic.

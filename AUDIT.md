# Interface — full project audit (round 2)

Scope: performance, software architecture, DRY, testability, correctness & bugs.
Single-tenant, Cloudflare-Access-fronted; security findings de-prioritised.

> **Status:** the punch list below has been addressed in this branch
> (see git log). §0 lists what was changed; the rest of the document
> remains as context. Specific line numbers may have drifted.

---

## 0. Resolved in this branch

P0 / P1:
- §1.1 — `MetaPanel` reads token-usage fields the DO never wrote.
  `MetaSnapshot.usage` retyped as `ConversationUsage` (mirrors `Usage`
  from `LLM.ts`); `MetaPanel` now reads `inputTokens`,
  `outputTokens`, `cacheReadInputTokens`, `cacheCreationInputTokens`,
  `thinkingTokens`. `generation: unknown` field dropped (always-null).
- §1.2 — `npm test` failed on cold checkout because it didn't run
  `svelte-kit sync` first. `package.json`'s `test`, `test:watch`, and
  `test:coverage` scripts now prefix `svelte-kit sync &&`.
- §1.3 — Provider stream now cancels on user abort. `#inProgress`
  carries an `AbortController`; `abortGeneration` calls `abort('user')`
  and the signal is threaded into `llm.chat()` and
  `registry.execute({ signal })`. Both LLM adapters and the sandbox
  tools already forwarded `signal` into their `fetch` calls; the DO
  now constructs and feeds the source.
- §1.4 — `routeLLM` SDK client cache restored. Module-scope per-
  provider cache keyed on `providerId` + a fingerprint of api key /
  endpoint, so settings saves naturally cycle the cached client. Test
  seam `_resetClientCache` exposed.
- §1.5 — Compaction's LLM call routes through `#routeLLM`. Tests can
  now drive `compactHistory` via the same `__setLLMOverride` script
  used by `#generate`.
- §1.7 — `abortGeneration` persists the meta snapshot
  (`started_at`, `first_token_at`, `last_chunk_json`, `usage_json`,
  `provider`). The cut-short row now matches a normal completion's
  meta shape, so the panel no longer renders empty.
- §0.4 — `migrate.ts:migrateLegacyModelList` deleted (was dead code).
- §0.7 — `<Toaster />` mounted in `+layout.svelte`.
  `form-actions.ts` gains `toastSubmit(msg)` /
  `confirmToastSubmit(confirm, msg)` helpers; settings, archive, and
  conversation forms use them so saves and deletes get visible
  confirmation.
- §0.8 — `parts_html` column merged into `parts` (the enriched
  parts JSON contains `textHtml` baked into text/thinking entries).
  Migration 3 backfills + drops `parts_html`. Saves a JSON write per
  completed assistant row.
- §3.1 — Per-DO `ConversationContext` cache (30-second TTL) covers
  `system_prompt`, `user_bio`, `allModels`, `subAgents`,
  `mcpServers`. Cuts D1 round trips per chat turn from ~10 to 2 in
  the warm path. Title generation also reads from the cache.

P2:
- §1.6 — Title generation has its own `__setTitleLLMOverride` queue
  so test scripts for `#generate` aren't pulled by the background
  title-gen task.
- §1.11 — `addPresetProvider` pre-checks provider id collisions and
  returns a clean 400 instead of letting D1's unique-constraint
  surface as a 500.
- §1.12 — Sandbox SSH key cache key includes a SHA-256 fingerprint
  of the key, so rotating `SANDBOX_SSH_KEY` re-injects on the next
  conversation tool call instead of waiting for an isolate cycle.
- §1.13 — `+page.server.ts:withRenderedMarkdown`'s `??` chain
  simplified. The dead branch (`m.contentHtml ?? null` when both
  `contentHtml` and `content` are empty) was always-null.
- AppShell's `now = Date.now()` is now a reactive `$state` refreshed
  every 60 s, so sidebar relative timestamps don't freeze.
- `editSubAgent`, `deleteServer`, `deleteSubAgentBy` removed (the
  edit form had no UI; the helpers were never wired up).
- DO schema migration 3 backfills `parts` from legacy columns and
  drops `tool_calls`, `tool_results`, `parts_html`, `generation_json`.
  Read path simplified: SELECTs and `MessageRow` no longer carry
  `toolCalls`/`toolResults`. `applyToolCall` /`applyToolResult` /
  `applyToolOutput` now operate only on `parts` (the canonical
  timeline).
- `OpenAILLM` now `console.warn`s on throw-after-`done` instead of
  silently swallowing — surfaces real bugs without double-emitting
  the error event.

P3 / deferred:
- §1.10 — theme cache invalidation only fires in the saving isolate.
  Acceptable for single-user; documented in code comment.
- §1.14 — `OpenAILLM`'s `flattenToText` still drops non-text user
  blocks. Audit flagged this for a wider OpenAI-compat input refactor;
  deferred.
- §0.10 — `agent.ts` belt-and-braces allowed-tools enforcement
  (filter-at-registration AND check-at-execute). Defensive, retained.
- Bootstrap tree-shake — cosmetic.
- Shiki language splitting — only if bundle hits the cap.
- Tests print noisy `WebSocket peer disconnected` lines from incomplete
  reader teardown in `subscribe()` tests. Run still passes 333/333.

---

## 1. Findings (original)

The original audit findings are preserved below for context. Per
finding, see §0 for the resolution.

### 1.1 Token usage shape — visible UI bug (**P0 → fixed**)

`MetaPanel.svelte` read `snapshot.usage?.promptTokens`,
`completionTokens`, `promptTokensDetails.cachedTokens`,
`completionTokensDetails.reasoningTokens`. The DO writes `Usage` from
`LLM.ts` — `inputTokens`, `outputTokens`, `cacheReadInputTokens`,
`thinkingTokens`. Two type declarations described `usage` and they
didn't agree. Result: prompt-tokens, completion-tokens, cached-tokens,
reasoning-tokens always rendered as `—`.

### 1.2 Test suite broken on cold checkout (**P0 → fixed**)

`tsconfig.json` extends `./.svelte-kit/tsconfig.json`, which is
generated by `svelte-kit sync`. `package.json`'s `test` script ran
`vitest run` with no sync prefix. After `npx svelte-kit sync`, all
333 tests passed.

### 1.3 Provider stream not cancelled on abort (**P1 → fixed**)

`#generate` called `llm.chat({...})` with no `signal`. The adapter
side was ready (`AnthropicLLM.ts`, `OpenAILLM.ts`, `agent.ts`,
`sandbox.ts` all forwarded `request.signal`); the DO never built an
`AbortController` to feed any of them.

### 1.4 `routeLLM` regression: SDK client per call (**P1 → fixed**)

Round 1 fixed this; the providers-table refactor reintroduced it.
`route.ts` always used the config-overload constructor, recreating
the SDK client per chat / compaction / title turn.

### 1.5 `compactHistory` not exercisable through DO test seam (**P1 → fixed**)

`compactHistory` accepted `deps.llm`; the DO didn't pass it. Wired
through `#routeLLM` so `__setLLMOverride` covers compaction too.

### 1.6 Title generation consumed `__setLLMOverride` script turns (**P2 → fixed**)

Title-gen and main generation shared the same script queue, so a
test setting one turn for the assistant message saw the title-gen
task either steal turn 2 or fall through to its catch-block fallback.
Title-gen now has a separate `__setTitleLLMOverride` seam.

### 1.7 `abortGeneration` lost meta snapshot (**P2 → fixed**)

The cut-short row was updated to `complete` without writing
`started_at` / `first_token_at` / `last_chunk_json` / `usage_json`.
`MetaPanel` for an aborted message showed nothing. Hoisted those
fields onto `#inProgress` so `abortGeneration` writes them.

### 1.10 Theme cache invalidation per-isolate (**P3 → deferred**)

Acceptable for a smart-placed single-user deployment.

### 1.11 `addPresetProvider` didn't pre-check id collisions (**P3 → fixed**)

D1's unique constraint surfaced as a 500. Now returns 400 with a
helpful message.

### 1.12 Sandbox SSH key cache missed key rotation (**P3 → fixed**)

`sshKeyInjected: Set<string>` keyed only on conversation id, so
rotating `SANDBOX_SSH_KEY` left every existing conversation pinned to
the old key. Cache key now includes a SHA-256 fingerprint of the key.

### 1.13 `+page.server.ts` `??` chain dead branch (**P3 → fixed**)

`m.contentHtml ?? null` when both `contentHtml` and `content` were
empty was always null. Simplified.

### 1.14 `OpenAILLM`'s `flattenToText` drops non-text user content (**P3 → deferred**)

Multi-modal user messages (image/file blocks) silently disappear on
the OpenAI-compat path. Anthropic faithfully maps; OpenAI drops.
Wider OpenAI-compat input refactor needed; deferred.

---

## 2. Architecture notes

### 2.1 Triple-storage retired

`messages.tool_calls`, `messages.tool_results`, `messages.parts_html`,
`messages.generation_json` all dropped in migration 3. `parts` is the
canonical timeline; HTML enrichment lives in the same column for
completed rows. `MessageRow` API no longer surfaces `toolCalls` /
`toolResults` separately — parts are the only source of truth.

### 2.2 Reactive state hot path

`+page.svelte` still allocates a fresh outer `messages` array per
delta via `patchMessage`. The mutate-trailing-part trick at
`appendDeltaPart` cuts per-token part allocation. For a small
frontend the cost is invisible. Documented; not refactored.

### 2.3 Sub-agents

`agent.ts` propagates `result.citations` and `result.artifacts`,
threads `ctx.signal` through inner LLM calls and tool execute,
recursion guard remains. The defensive belt-and-braces allowed-tools
enforcement (filter at registration site + runtime check) is retained
as defense-in-depth.

### 2.4 D1 / DO ownership

D1 owns `conversations`, `settings`, `mcp_servers`, `sub_agents`,
`providers`, `provider_models`. DO owns `messages`, `artifacts`,
`_meta`. Per-DO 30-second `ConversationContext` cache covers
read-heavy paths. Settings saves don't propagate cross-isolate; the
TTL bounds the staleness window.

### 2.5 `csrf.trustedOrigins: []`

Correct under Cloudflare Access.

### 2.6 Service worker

Deliberately a stake-out for iOS PWA installability; no fetch handler.

---

## 3. Testability

- `vitest-pool-workers` integration with stub worker + applied D1
  migrations remains rock solid.
- `FakeLLM` fixture + `__setLLMOverride` / `__setTitleLLMOverride`
  RPCs cover deterministic generation and title testing.
- 333 tests pass, including the new schema-version assertion that
  migration 3 dropped the legacy columns.
- Pure helpers are tested in isolation.
- `ConversationContext` cache timing isn't covered by tests yet —
  worth a small test that asserts a stale cache returns the cached
  value within TTL and a fresh fetch after.
- `MetaPanel` still has no snapshot test. With the type alignment in
  place and a snapshot test, the §1.1 P0 wouldn't have shipped.

---

## 4. Smaller items / nits

- `worker-configuration.d.ts` is checked in at 504 KB; regenerated
  via `npm run cf-typegen` when bindings change.
- `marked-katex-paren.ts` is a small, tested custom extension.
- `vitest.config.mts:16` `logLevel: 'error'` silences vite's
  source-map warnings; also masks any other vite warnings.
- `OpenAILLM.ts` `stream_options: { include_usage: true }` is
  OpenAI-specific; tolerated by OpenRouter, Together, etc. Worth a
  defensive try/catch if a strict OpenAI-compat server starts
  rejecting it.
- `renderArtifactCode` runs Shiki on `lang === 'text'`; a fast path
  would skip the tokenise pass.

---

## 5. Things deliberately not refactored

- Bootstrap tree-shake (cosmetic).
- Shiki language splitting (only if bundle hits cap).
- YNAB tool factory consolidation (works, churn-prone, low payoff).
- `OpenAILLM` `flattenToText` multi-modal support (deferred per §1.14).

---

*Audit prepared on branch `claude/audit-performance-architecture-kUkXH`.*

# Interface — PRD: Path to claude.ai Feature Parity

**Status:** Draft · **Owner:** @piperswe · **Last updated:** 2026-05-03

## 1. Overview

**Interface** is a self-hosted AI chat application running on Cloudflare's developer platform (Workers + Durable Objects + D1). It already provides streaming chat, conversation persistence, and multi-model selection through OpenRouter. This PRD describes the work required to expand Interface into a daily-driver replacement for [claude.ai](https://claude.ai), while preserving its provider-agnostic posture and self-hosted operating model.

The product hypothesis is that the chat surface itself is commoditized — what's valuable is owning the agentic layer (web search, code execution, tools, MCP, artifacts) so that the operator chooses the model independently of the capabilities. Interface treats provider SDKs as model adapters, not feature platforms.

## 2. Goals & Non-Goals

### Goals
- Reach feature parity with claude.ai's chat experience for the operator's daily workflows.
- Remain provider-agnostic: OpenRouter is the default; direct provider SDKs are optional and used *only* when they unlock capabilities OpenRouter cannot expose (e.g. extended-thinking blocks, prompt caching, native tool formats).
- Build all auxiliary capabilities (search, code exec, artifacts, tools, MCP) inside Interface or via integrations to external services — not via provider built-in features.
- Stay deployable as personal infra on a single Cloudflare account.
- Keep the data model multi-user-ready from day one, even though v1 ships single-user.

### Non-Goals
- Provider vendor-specific "computer use" features. (The closest in-scope equivalent is a Cloudflare Sandbox container the agent can shell into.)
- Provider vendor-specific built-in web search. (Web search is implemented inside Interface with pluggable backends, starting with Kagi.)
- Real-time multi-user collaborative editing of a single conversation in v1.
- Native mobile apps (mobile is addressed via responsive web + PWA).
- On-device / offline LLM inference.
- A managed multi-tenant SaaS offering. (Multi-user phase exists, but for self-hosted small groups, not as a hosted product.)

## 3. Personas

| Persona | Today | Notes |
|---|---|---|
| **Owner** | Single operator running Interface on their own Cloudflare account against personal API keys. | Primary user for v1. Has admin access to settings, secrets, and infrastructure. |
| **End user** *(future)* | Authenticated user with scoped data on a multi-user deployment. | Unblocked by the deferred multi-user phase. Schema is ready from v1. |
| **Guest** *(future)* | Read-only viewer of a shared conversation link. | No account required. |

## 4. Current State (verified)

| Area | Status | Reference |
|---|---|---|
| Stack | Cloudflare Workers, React 19 SSR, esbuild | `wrangler.jsonc`, `package.json` |
| Routing | `/`, `/conversations` (POST), `/c/:id`, `/c/:id/messages` (POST), `/c/:id/events` (SSE), `/dist/*` | `src/index.ts:14-89` |
| Generation | OpenRouter via `OpenRouterLLM`, streamed through `ConversationDurableObject` | `src/durable_objects/ConversationDurableObject.ts:24-387` |
| Storage | D1 `conversations` table + per-DO SQLite `messages` table | `migrations/0001_init.sql` |
| Streaming | SSE events: `delta`, `meta`, `sync`, `refresh` (+ ping keep-alive) | `src/frontend/hooks/useConversationStream.ts:46-97` |
| LLM abstraction | `LLM` interface exists with one impl (`OpenRouterLLM`) | `src/llm/LLM.ts`, `src/llm/OpenRouterLLM.ts` |
| Frontend | Conversation list, conversation page, compose form, message, meta panel | `src/frontend/pages/**`, `src/frontend/components/**` |
| Markdown | `marked` (no syntax highlighting, no LaTeX) | `src/frontend/markdown.ts` |
| Auth | None | — |
| Files / R2 | None | — |
| Sandbox / AI / Vectorize bindings | None | `wrangler.jsonc` |

The foundation is clean (no TODOs, no FIXMEs) and well-suited to incremental expansion.

## 5. Architecture Direction

### 5.1 LLM provider layer

Expand `LLM` (`src/llm/LLM.ts`) so adapters express:
- Tool calls (request and result blocks).
- Thinking blocks (Anthropic / DeepSeek style; ignored when unsupported).
- File/image inputs (per-message attachments).
- Per-message feature flags (e.g. `cache_control`, `thinking_budget`).
- Streaming events richer than text deltas (tool-call deltas, thinking deltas, citations).

Adapters:
- `OpenRouterLLM` (default; existing).
- `AnthropicLLM` (extended thinking, prompt caching, native tool format).
- `OpenAILLM` (native tool format, structured output).
- `GoogleLLM` (long-context, native tool format).
- `DeepseekLLM` (reasoning models, thinking blocks).

Per-message routing: model id → provider adapter, with operator-curated mapping. OpenRouter remains the catch-all.

### 5.2 Storage

- **D1**: Add tables for `users`, `projects`, `attachments`, `shares`, `memories`, `settings`, `mcp_servers`, `styles`. Add `user_id` columns (nullable in v1) to `conversations`.
- **R2**: New binding `ATTACHMENTS` for file/image/PDF uploads.
- **KV**: New binding `SESSIONS` (lands with the auth phase).
- **Vectorize**: Deferred binding `MEMORY_INDEX` for semantic memory and conversation search.
- **Durable Object SQLite (`messages`)**: Add columns `provider`, `thinking`, `tool_calls`, `tool_results`, `attachments`, `cache_metadata`, `parent_id` (for edit/branch).

### 5.3 Sandbox

Add Cloudflare Sandbox binding `SANDBOX`. Used for:
- Code execution tool (per-conversation ephemeral container).
- Stdio-transport MCP servers.
- Future "agent shell" use cases.

Persistence model is an [Open Question](#9-open-questions).

### 5.4 Web search

Internal `WebSearch` interface with pluggable backends. First implementation: `KagiSearchBackend`. Designed to allow Brave / Tavily / Exa swap-in. Search results render as inline cards in the message stream and are surfaced as citations in assistant text.

### 5.5 Artifacts

- Server-rendered + client-hydrated side panel.
- Artifact types: code (syntax-highlighted), markdown document, HTML/JS (sandboxed `<iframe srcdoc>` with strict CSP), SVG, Mermaid diagram.
- Version history per artifact (each model edit = new version).
- Stored in DO SQLite alongside the message that produced them.

### 5.6 MCP

First-class MCP client inside the worker:
- HTTP/SSE transports run inside the worker request lifetime.
- Stdio transports run inside the Sandbox container.
- Tool calls flow through the same generation pipeline as built-in tools.
- Per-conversation and per-project MCP server selection.

### 5.7 Auth (deferred multi-user phase)

- Passkey (WebAuthn) primary; email magic link as fallback.
- Sessions in KV.
- `user_id` columns added to D1 from v1, nullable now, required after migration.
- Single-user mode reserves `user_id = 1` so that the upgrade is a backfill plus a `NOT NULL` migration.

## 6. Data Model Deltas

### D1 (current)
```sql
conversations(id, title, created_at, updated_at)
```

### D1 (target)

| Table | Purpose |
|---|---|
| `users` | Account records (lands with auth phase; pre-seeded with `id=1` in v1). |
| `conversations` | Adds `user_id`, `project_id`, `style_id`, `pinned_at`, `archived_at`. |
| `projects` | Grouping. Has `system_prompt`, `name`, `description`. |
| `project_files` | Many-to-many: project ↔ attachment, persistent project context. |
| `attachments` | R2 keys + metadata (`mime`, `bytes`, `extracted_text`, `sha256`). |
| `shares` | Public-link slug → conversation snapshot id. |
| `memories` | Per-user memory entries with type, content, source. |
| `settings` | Per-user (key, value) bag for theme, default model, etc. |
| `mcp_servers` | Operator-configured MCP servers (transport, url/cmd, env, auth). |
| `styles` | Named system-prompt presets. |

### Durable Object SQLite — `messages`

| Current columns | Added columns |
|---|---|
| `id, role, content, model, status, error, created_at, started_at, first_token_at, last_chunk_json, usage_json, generation_json` | `provider`, `thinking`, `tool_calls`, `tool_results`, `attachments` (JSON), `cache_metadata`, `parent_id` (for edit/regenerate branching), `artifact_ids` (JSON) |

A new sibling table `artifacts(id, message_id, type, name, version, content, created_at)` lives in the same Durable Object.

## 7. Feature Requirements

For each feature: **description**, **acceptance criteria**, **affected code**, **data-model deltas**, **open questions**.

### 7.1 P0 — Foundation parity

These are the table stakes for "useful daily driver."

#### P0.1 Mobile-responsive layout
- Replace fixed 720px max-width, add breakpoints, collapse sidebar to drawer on mobile, make compose form keyboard-aware.
- **Acceptance:** Lighthouse mobile score ≥ 90. Compose form usable on iOS Safari with keyboard open. Sidebar reachable via tap target ≥ 44×44px.
- **Affects:** `src/frontend/styles.css`, `src/frontend/pages/conversation/Page.tsx`, `src/frontend/pages/index/server.tsx`.
- **Data model:** None.

#### P0.2 Settings UI
- Pages for: appearance (theme), model defaults, system prompt default, provider API keys (per-provider), search backend config, MCP server registry.
- **Acceptance:** All settings persist across reloads. Provider keys stored encrypted. Settings reachable from a global nav element.
- **Affects:** New `src/frontend/pages/settings/**`, new `/settings` and `/settings/*` routes in `src/index.ts`.
- **Data model:** `settings` table (D1).
- **Open questions:** Where to encrypt provider keys (Worker secrets vs. envelope-encrypted in D1)?

#### P0.3 Per-message actions
- Copy, edit-and-resubmit, regenerate, delete on each message. Edit creates a new branch via `parent_id`; UI shows a branch picker if multiple branches exist.
- **Acceptance:** Edit-and-resubmit produces a new assistant response without losing the prior branch. Regenerate replaces the current assistant message in place. Delete is soft (recoverable from a "Recently deleted" view).
- **Affects:** `src/durable_objects/ConversationDurableObject.ts`, `src/frontend/components/Message.tsx`, new SSE event types.
- **Data model:** Add `parent_id`, `deleted_at` to `messages`.

#### P0.4 Conversation rename, delete, search, pin, archive
- Sidebar: list of conversations grouped by recency. Inline rename. Delete to trash. Pin to top. Archive to hide.
- Search: token-prefix search over titles + (later) message bodies.
- **Acceptance:** Rename takes effect without full reload. Search returns results in <100ms for a 1k-conversation corpus.
- **Affects:** `src/conversations.ts`, `src/index.ts`, `src/frontend/pages/index/**`, new sidebar component.
- **Data model:** Add `pinned_at`, `archived_at`, `deleted_at` to `conversations`. Add full-text index (D1 FTS5) on titles in v1; messages in v2.

#### P0.5 Syntax highlighting + LaTeX
- Highlight code blocks via Shiki (or `highlight.js` for lower bundle cost). Render `$...$` and `$$...$$` via KaTeX.
- **Acceptance:** Common languages (TS, Py, Rust, SQL, Bash, JSON, Markdown) highlighted. Math renders inline and block.
- **Affects:** `src/frontend/markdown.ts`, build pipeline.
- **Data model:** None.

#### P0.6 File / image / PDF attachments
- Multipart upload to `/c/:id/attachments` → R2. PDF text extraction in worker (`pdf-parse` or similar wasm). Vision-capable models receive image inputs natively; non-vision models receive extracted text + a notice.
- **Acceptance:** Upload up to 25 MB per file. PDF text round-trips into the assistant context. Image attachments render as thumbnails with click-to-expand.
- **Affects:** New upload route in `src/index.ts`, `wrangler.jsonc` (R2 binding), DO message schema, `ComposeForm.tsx`.
- **Data model:** `attachments` table; `attachments` JSON column on `messages`.
- **Open questions:** Per-provider attachment limits and which adapters auto-downscale images.

#### P0.7 Custom system prompts ("Styles")
- Named presets that override the default system prompt for a conversation. Selectable at conversation creation and per-message.
- **Acceptance:** Operator can save, edit, delete styles. Each conversation records the active style id.
- **Affects:** New `/settings/styles` page, `ComposeForm.tsx`, DO schema.
- **Data model:** `styles` table; `style_id` on `conversations`.

#### P0.8 Artifacts
- Side panel that opens when the assistant emits an artifact. Types: code, markdown document, HTML/JS, SVG, Mermaid. Sandboxed iframe with strict CSP for HTML/JS; no network, no parent access.
- Each edit produces a new version; users can scrub through versions.
- **Acceptance:** HTML/JS artifact cannot exfiltrate the parent origin's cookies or storage. Versions are persisted with the conversation.
- **Affects:** New `Artifact` component, `ConversationDurableObject` (artifact persistence), Page.tsx layout split.
- **Data model:** `artifacts` table inside the Durable Object SQLite; `artifact_ids` on `messages`.
- **Open questions:** Whether HTML/JS artifacts should be served from a separate origin (e.g. `*.artifacts.<host>`) for stronger isolation.

#### P0.9 Projects
- Grouping construct: shared system prompt + persistent attached files + own conversation list.
- **Acceptance:** Operator can create/rename/delete projects. Conversation can be moved between projects. Project files automatically attached to every conversation in the project.
- **Affects:** New `/projects/:id` route, sidebar grouping, ConversationDurableObject (read project context at generation start).
- **Data model:** `projects`, `project_files`; `project_id` on `conversations`.

#### P0.10 Multi-user-ready schema
- Add `user_id` to every user-owned table (`conversations`, `projects`, `attachments`, `memories`, `settings`, `styles`, `mcp_servers`).
- v1: `user_id` is nullable; single-user mode writes `1`.
- v2 migration backfills and adds `NOT NULL`.
- **Acceptance:** Schema review confirms every user-data table carries `user_id`. Backfill path is documented.

### 7.2 P1 — Claude-class capabilities

#### P1.1 Extended thinking
- Anthropic adapter exposes `thinking` budget and surfaces thinking blocks in the UI as a collapsible section above the assistant response. DeepSeek reasoning models reuse the same UI.
- **Acceptance:** Operator can set per-conversation thinking budget. Thinking blocks render as collapsed by default. Models without thinking show no section (no empty placeholder).
- **Affects:** `LLM` interface, `AnthropicLLM`, new SSE `thinking_delta` event, `Message.tsx`.
- **Data model:** `thinking` column on DO `messages`.

#### P1.2 Tool use + MCP
- Built-in tools: `web_search`, `code_execution`, `fetch_url`. Plus per-conversation MCP server selection.
- Tool calls and tool results render as structured cards in the message stream (collapsible).
- **Acceptance:** Multi-step tool chains work end-to-end (agent calls tool → result streamed back → agent continues). MCP servers can be added/removed without redeploy.
- **Affects:** New `src/tools/**`, new `src/mcp/**`, `LLM` interface, `ConversationDurableObject` (tool execution loop), `Message.tsx`.
- **Data model:** `tool_calls`, `tool_results` on DO `messages`. `mcp_servers` table.

#### P1.3 Web search (Kagi)
- `WebSearch` interface, `KagiSearchBackend` first implementation. Surfaced as a `web_search` tool to the model. Inline result cards. Cited URLs link out and survive in the rendered message.
- **Acceptance:** Operator configures Kagi API key in Settings. Cited URLs render as clickable footnotes. Backend is swappable behind the interface.
- **Affects:** `src/tools/web_search.ts`, `src/search/**`, settings page.
- **Open questions:** Citation render style — inline `[1]` footnotes vs. trailing source list vs. both.

#### P1.4 Code execution (Cloudflare Sandbox)
- `code_execution` tool runs in a per-conversation ephemeral Sandbox container. Languages: Python, Node, Bash. Results stream back into the message.
- **Acceptance:** Container spins up <2s. Stdout/stderr stream in real time. Container is torn down when the conversation is idle for N minutes.
- **Affects:** New `src/sandbox/**`, `wrangler.jsonc` (Sandbox binding).
- **Open questions:** Container persistence — fully ephemeral per execution vs. persistent for the conversation lifetime vs. per-project workspace.

#### P1.5 Memory
- Per-user memory entries (D1 `memories` table). Operator can curate manually; assistant can suggest entries via a tool. Active memories injected into system prompt at generation start.
- **Acceptance:** Memory entries are visible and editable in Settings. Suggested memories require approval before they're added.
- **Affects:** `src/memory/**`, `ConversationDurableObject` (system prompt assembly), settings page.
- **Open questions:** Storage strategy — D1 rows only, Vectorize embeddings, or both. Whether memory should be per-project or global.

#### P1.6 Conversation sharing
- Public read-only links: slug → static snapshot of the conversation at the moment of sharing. No streaming, no continuation by guests.
- **Acceptance:** Anyone with the link can view; nobody can post. Operator can revoke a share.
- **Affects:** New `/s/:slug` route, `shares` table, sidebar share action.
- **Data model:** `shares` table.

#### P1.7 Export
- Markdown, JSON, PDF download per conversation. PDF rendered via Cloudflare Browser Rendering or a wasm renderer.
- **Acceptance:** Markdown round-trips losslessly (re-import would reconstruct the conversation). JSON includes all metadata. PDF is print-clean.

#### P1.8 Prompt caching
- Anthropic adapter sets `cache_control` on system prompts and project context blocks. Cache metadata stored on the message for the meta panel.
- **Acceptance:** Cache hit rate visible in the meta panel. Cost panel reflects cache savings.
- **Affects:** `AnthropicLLM`, `MetaPanel.tsx`, DO `messages` schema (`cache_metadata`).

### 7.3 P2 — Polish and stretch

| Feature | Notes |
|---|---|
| Voice input / output | STT via OpenAI Whisper API or browser SpeechRecognition; TTS via OpenAI / browser SpeechSynthesis. |
| PWA / offline shell | Service worker; offline mode is read-only (cached conversations + outbox). |
| Multi-user phase | Passkey auth, scoped data, account-to-account sharing, basic admin UI. Schema is already ready (see P0.10). |
| Real-time multi-user collab | Two operators in the same conversation simultaneously. Reuses existing SSE broadcast; needs presence + conflict resolution on edits. |
| Agent shell | Long-running agent with shell access to the Sandbox container. Closest in-scope analogue to provider "computer use." |
| Vectorize-backed semantic search | Index conversations + memories. Replace token-prefix search with hybrid lexical + vector. |

## 8. Out-of-Scope (re-stated)

- Provider vendor-specific "computer use" features.
- Provider vendor-specific built-in web search.
- On-device / offline LLM inference.
- Native mobile apps.
- Real-time collaborative editing of a single conversation in v1.
- A managed multi-tenant SaaS offering.

## 9. Open Questions

1. **Auth provider** at the multi-user phase: passkeys-only, email magic link, OAuth, or all three?
2. **Generation engine**: keep `Durable Object` per conversation, or move to `Workflows` once tool execution and MCP introduce long-running, retriable steps? Durable Objects work today; the question is whether they remain the right fit when an agent loop can take 10+ minutes.
3. **Sandbox persistence model**: ephemeral per execution vs. persistent for the conversation vs. per-project workspace.
4. **Memory storage**: D1 only, Vectorize only, or both with hybrid retrieval?
5. **Provider API key storage**: Worker secrets, or envelope-encrypted in D1?
6. **Artifact iframe origin**: same-origin sandbox attribute, or a dedicated `*.artifacts.<host>` origin for stronger isolation?
7. **Citation render style** for web search results: inline footnotes, trailing source list, or both?
8. **Model catalog curation**: surface OpenRouter's full catalog or curate a shorter "recommended" list with an "advanced" reveal?
9. **Billing / quotas** at the multi-user phase: BYO-key only, shared-key with metering, or both?

## 10. Success Metrics

- **Daily-driver checklist** — binary pass/fail on the operator's real workflows: chat, file Q&A, code-artifact generation, multi-step tool use, web research, project-scoped work. Target: 100% pass before declaring v1.
- **No regressions on existing telemetry** — TTFT and tokens/sec from the meta panel hold steady or improve as features land. The streaming experience must not get worse.
- **Cold-start render** — SSR HTML byte size and TTFB stay within +20% of the current baseline despite the larger feature surface.
- **Operator self-report** — at the close of each phase, the operator answers "would I switch off claude.ai today?" with yes/no + reason.

## 11. Appendix — Code References

- Routing: `src/index.ts:14-89`
- Generation engine: `src/durable_objects/ConversationDurableObject.ts:24-387`
- LLM abstraction: `src/llm/LLM.ts`, `src/llm/OpenRouterLLM.ts`
- OpenRouter model catalog: `src/openrouter/models.ts`
- Conversation list page: `src/frontend/pages/index/server.tsx:13-47`
- Conversation page: `src/frontend/pages/conversation/Page.tsx:14-40`
- Streaming hook: `src/frontend/hooks/useConversationStream.ts:46-97`
- UI components: `src/frontend/components/ComposeForm.tsx`, `Message.tsx`, `MetaPanel.tsx`
- Markdown rendering: `src/frontend/markdown.ts`
- Schema: `migrations/0001_init.sql`
- Bindings: `wrangler.jsonc`

# Interface

A SvelteKit app deployed to Cloudflare Workers. Conversations are backed by a
SQLite-backed Durable Object; the conversation list, settings, and MCP server
registry live in D1. Live updates from the Durable Object stream to the
browser over Server-Sent Events.

## Architecture

| Layer | Where it lives |
|---|---|
| HTTP / SSR | SvelteKit (`src/routes/`) |
| Server-only modules (DB, LLMs, tools) | `src/lib/server/` |
| Mutations & form actions | SvelteKit **Remote Functions** (`src/lib/*.remote.ts`) |
| Durable Object | `src/lib/server/durable_objects/ConversationDurableObject.ts` |
| SSE stream | `src/routes/c/[id]/events/+server.ts` |
| Custom Worker entry | postbuild append to `.svelte-kit/cloudflare/_worker.js` |

### Remote functions

We use `query` / `command` / `form` from `$app/server` everywhere we'd
otherwise reach for `fetch('/api/...')`. Forms (`form()`) are
progressively-enhanced — they post and redirect even with JS disabled, and
become async fetches when JS is available.

- `src/lib/conversations.remote.ts` — `createNewConversation`, `sendMessage`,
  `regenerateTitle`, `setThinkingBudget`.
- `src/lib/settings.remote.ts` — `saveSetting`, `addMcpServer`,
  `removeMcpServer`. The Settings page binds them via `saveSetting.for(key)`
  so each section keeps its own progressive-enhancement state.

Loaders (`+page.server.ts`, `+layout.server.ts`) cover the read path.

### Tips: "A form object can only be attached to a single `<form>` element"

This error means the same `form.for(key)` instance is being spread onto two
separate `<form>` elements at the same time. Common causes:

1. **Sidebar + main page collision** — You render a form in the sidebar list
   AND in the main content for the same entity (e.g. an archive button in the
   sidebar and an archive button on `/c/[id]`). Both use `archive.for(c.id)`,
   which returns the same cached form object.
   
   **Fix:** Namespace the sidebar forms: `archive.for('nav-' + c.id)` instead
   of `archive.for(c.id)`. The key is only for client-side pending-state
   isolation; the server still receives the same POST data.

2. **Keyed loops with dynamic data** — A `{#each}` block with keyed items
   reorders or removes items, but SvelteKit's form object is still cached for
   that key. When the item reappears or the component remounts, the old form
   object thinks it's already attached.
   
   **Fix:** Use a unique prefix per context (sidebar, modal, page) or use
   different keys per render location.

3. **Conditional rendering** — The same `.for(key)` is used in an `{#if}` block
   that toggles. When the form unmounts and remounts, SvelteKit sees the same
   form object being attached to a new element.
   
   **Fix:** Use a stable unique key per mount point, or track the DOM element
   lifecycle more carefully.

**Rule of thumb:** If you call `someForm.for(id)` in two different places
(sidebar + page, or two modals), those two places MUST use different keys.
Prefixing is the safest approach.

### Durable Objects on SvelteKit

`@sveltejs/adapter-cloudflare` emits `_worker.js` with only a default export.
A postbuild step (`scripts/postbuild.mjs`) appends a re-export of
`ConversationDurableObject` so wrangler picks the class up at deploy time.
This is the simplest known approach until the adapter ships native DO support
(see https://github.com/sveltejs/kit/issues/13062).

`wrangler.jsonc` `main` points at `.svelte-kit/cloudflare/_worker.js`. The
postbuild script is idempotent, so repeated `npm run build` calls are safe.

`src/app.d.ts` re-types `Cloudflare.Env.CONVERSATION_DURABLE_OBJECT` with
the typed namespace because `wrangler types` can't resolve the DO from the
SvelteKit-bundled worker file.

### Tests

`vitest-pool-workers` needs a real Worker script to bundle. We use
`wrangler.test.jsonc` which points main at `test/worker-entry.ts` (a stub
that re-exports the DO and 404s for HTTP). Unit tests target the modules
under `src/lib/server/` directly; component behaviour goes through the DO
end-to-end test in `src/lib/server/durable_objects/`.

#### Bug fixes must include a regression test

Every PR that fixes a bug must add at least one test that fails on the
old code and passes on the new. The point isn't proving the fix works
once — it's making sure the same bug can't sneak back in next quarter.

Practical guidance:
- Pick the smallest scope that reproduces the bug. A pure helper test
  against an extracted function is better than a sprawling end-to-end
  flow that's slow and brittle.
- If the buggy code path isn't testable in its current shape, refactor
  it just enough to make a regression test possible (e.g. pull a pure
  helper out of a SvelteKit `+server.ts` and import it from a sibling
  `server.test.ts` — see `routes/c/[id]/preview/[port]/[...path]/`
  for the pattern).
- Reference the bug in a comment on the test. Future readers should
  understand *why* this assertion exists, not just what it asserts.
  A one-line "Regression: ..." comment is enough.
- For UI/integration concerns where a unit test is genuinely impossible,
  document the manual smoke-test steps in the PR description and call it
  out — but assume the reviewer will push back on this.

## Commands

| Command | Purpose |
|---------|---------|
| `npm run dev` | SvelteKit dev server |
| `npm run build` | Production build (vite + postbuild for DO export) |
| `npm run preview` | `wrangler dev` against the production bundle |
| `npm run deploy` | Build and `wrangler deploy` |
| `npm run check` | Type-check (`svelte-check`) |
| `npm run test` | Run vitest |
| `npx wrangler types` | Refresh `worker-configuration.d.ts` after binding changes |

`vite dev` does not run the Workers runtime — it uses `getPlatformProxy` from
the cloudflare adapter, which connects to a real workerd. DO RPC has limited
support in proxy mode; for end-to-end DO behaviour, `npm run preview`.

## Sandbox SSH key

If the `SANDBOX` binding is present, an optional Wrangler secret
`SANDBOX_SSH_KEY` can be set to a private SSH key. The key is injected
lazily into every sandbox container on the first `sandbox_exec` or
`sandbox_run_code` call:

- `~/.ssh/sandbox_key` — the private key (`chmod 600`)
- `~/.ssh/config` — an SSH config that points `github.com` to that key
  with `IdentitiesOnly yes` and `StrictHostKeyChecking accept-new`

This lets the agent `git clone`, `git push`, etc. without manual setup.
Use `scripts/setup-sandbox-ssh.sh` to generate an Ed25519 key pair and
upload the private half as the secret. After running it, add the printed
public key to your GitHub account.

## Workspace R2 mount (production)

The sandbox `/workspace` directory is backed by the `WORKSPACE_BUCKET` R2
bucket so files persist across container/DO cycles and surface in the
file browser. **In production you must configure these three secrets,**
otherwise files written in the sandbox will not sync to R2:

| Secret | Value |
|---|---|
| `R2_ACCOUNT_ID` (or `R2_ENDPOINT`) | Cloudflare account id, used to derive `https://{id}.r2.cloudflarestorage.com`. Set `R2_ENDPOINT` directly if you use a custom hostname. |
| `R2_ACCESS_KEY_ID` | R2 API token access key id. Generate at R2 → Manage R2 API Tokens. |
| `R2_SECRET_ACCESS_KEY` | R2 API token secret. |

When all three are set, the sandbox mounts `/workspace` via s3fs-FUSE
inside the container, so writes go straight to R2. Without them the
mount falls back to the SDK's `localBucket` mode which only works under
`wrangler dev` — Cloudflare evicts the Sandbox DO before its background
sync loops can run, and container→R2 uploads silently never happen.
Override `R2_WORKSPACE_BUCKET_NAME` only if you renamed the bucket from
the `bucket_name` declared in `wrangler.jsonc`.

# Cloudflare Workers

STOP. Your knowledge of Cloudflare Workers APIs and limits may be outdated. Always retrieve current documentation before any Workers, KV, R2, D1, Durable Objects, Queues, Vectorize, AI, or Agents SDK task.

## Docs

- https://developers.cloudflare.com/workers/
- SvelteKit on Cloudflare: https://svelte.dev/docs/kit/adapter-cloudflare
- Remote functions: https://svelte.dev/docs/kit/remote-functions
- MCP: `https://docs.mcp.cloudflare.com/mcp`

For all limits and quotas, retrieve from the product's `/platform/limits/` page. eg. `/workers/platform/limits`

## Node.js Compatibility

https://developers.cloudflare.com/workers/runtime-apis/nodejs/

## Errors

- **Error 1102** (CPU/Memory exceeded): Retrieve limits from `/workers/platform/limits/`
- **All errors**: https://developers.cloudflare.com/workers/observability/errors/

## Product Docs

Retrieve API references and limits from:
`/kv/` · `/r2/` · `/d1/` · `/durable-objects/` · `/queues/` · `/vectorize/` · `/workers-ai/` · `/agents/`

## Best Practices (conditional)

If the application uses Durable Objects or Workflows, refer to the relevant best practices:

- Durable Objects: https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/
- Workflows: https://developers.cloudflare.com/workflows/build/rules-of-workflows/

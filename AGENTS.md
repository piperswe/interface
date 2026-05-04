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

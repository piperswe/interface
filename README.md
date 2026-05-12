# Interface

A self-hosted AI chat app running entirely on Cloudflare's developer platform — your own daily-driver alternative to claude.ai.

## Features

- **Multi-provider LLM support** — OpenRouter (default), Anthropic, OpenAI, Google, and DeepSeek. Switch models per conversation.
- **Extended thinking** — First-class support for Anthropic's extended thinking blocks, with configurable token budgets.
- **Live streaming** — Messages stream over Server-Sent Events with real-time markdown and syntax highlighting.
- **Artifacts** — Code and markdown artifacts are captured, versioned, and displayed in a side panel.
- **MCP servers** — Connect any [Model Context Protocol](https://modelcontextprotocol.io/) server via HTTP/SSE transport.
- **Sub-agents** — Define specialized agents with custom system prompts, models, and tool access; the main conversation can delegate to them.
- **Built-in tools** — Web search (Kagi), URL fetch, and sandboxed code execution.
- **Conversation management** — Archive, restore, and search conversations.
- **Styles & memories** — Reusable system-prompt styles and persistent memory snippets.
- **Progressive enhancement** — Core flows work without JavaScript.

## Stack

| Layer | Technology |
|---|---|
| Framework | SvelteKit 2 + Svelte 5 |
| Deployment | Cloudflare Workers |
| Conversation state | Durable Objects (SQLite) |
| Persistent data | D1 (SQLite) |
| Streaming | Server-Sent Events |
| Markdown | marked + Shiki + KaTeX |
| Type checking | TypeScript (strict) |
| Tests | Vitest + `vitest-pool-workers` |

## Project Structure

```
src/
├── routes/
│   ├── +layout.svelte          # Root layout — sidebar, navigation
│   ├── +page.svelte            # Home / new conversation
│   ├── c/[id]/                 # Conversation page
│   │   ├── +page.svelte
│   │   ├── +page.server.ts
│   │   └── events/+server.ts   # SSE stream endpoint
│   ├── settings/               # Settings UI
│   └── archive/                # Archived conversations
│
├── lib/
│   ├── server/
│   │   ├── durable_objects/
│   │   │   └── ConversationDurableObject.ts   # Core generation engine
│   │   ├── llm/                # Provider adapters (Anthropic, OpenRouter, …)
│   │   ├── tools/              # Built-in tools (web_search, fetch_url, …)
│   │   ├── conversations.ts    # D1 queries
│   │   ├── settings.ts
│   │   ├── mcp_servers.ts
│   │   └── sub_agents.ts
│   │
│   ├── conversations.remote.ts # Remote functions — sendMessage, createConversation, …
│   ├── settings.remote.ts      # Remote functions — saveSetting, addMcpServer, …
│   └── components/             # Svelte UI components
│
migrations/                     # D1 SQL migrations (auto-applied on deploy)
scripts/postbuild.mjs           # Appends DO export to _worker.js after Vite build
```

## Getting Started

### Prerequisites

- Node.js 18+
- A [Cloudflare account](https://dash.cloudflare.com/) with Workers and D1 enabled
- `wrangler` CLI — installed automatically via `npm install`

### Install

```bash
git clone https://github.com/piperswe/interface
cd interface
npm install
```

### Configure

Create a D1 database and paste its ID into `wrangler.jsonc`:

```bash
npx wrangler d1 create interface
```

Set your API keys as Worker secrets:

```bash
# Required — default LLM provider
npx wrangler secret put OPENROUTER_KEY

# Optional — direct provider integrations
npx wrangler secret put ANTHROPIC_KEY
npx wrangler secret put OPENAI_KEY
npx wrangler secret put GOOGLE_KEY
npx wrangler secret put DEEPSEEK_KEY

# Optional — built-in tools
npx wrangler secret put KAGI_KEY      # web search
npx wrangler secret put YNAB_TOKEN    # budget integration
```

Apply database migrations:

```bash
npx wrangler d1 migrations apply interface
```

### Develop

```bash
npm run dev       # SvelteKit dev server — fast iteration, no real Workers runtime
npm run preview   # wrangler dev — full Workers + Durable Objects support
```

> Durable Object RPC has limited support in `vite dev` proxy mode. Use `npm run preview` for end-to-end DO behaviour.

### Test

```bash
npm run test
```

### Deploy

```bash
npm run deploy    # vite build → postbuild → wrangler deploy
```

## Architecture Notes

### Durable Objects

Each conversation is backed by a `ConversationDurableObject`. It owns a SQLite database with `messages` and `artifacts` tables, runs the LLM generation loop, executes tools, and publishes SSE events to all connected clients.

The SvelteKit adapter emits a plain `_worker.js` with only a `default` export. A postbuild script (`scripts/postbuild.mjs`) appends a named `ConversationDurableObject` export so Wrangler can bind the class. This is idempotent — repeated `npm run build` calls are safe.

### Remote Functions

Mutations use SvelteKit [Remote Functions](https://svelte.dev/docs/kit/remote-functions) (`query` / `command` / `form` from `$app/server`) instead of hand-rolled API routes. `form()` functions are progressively enhanced — they work as plain HTML form posts with JS disabled and become async fetches when JS is available.

### SSE Streaming

The `/c/[id]/events` endpoint returns a `ReadableStream` sourced from `ConversationDurableObject.subscribe()`. The client parses events:

| Event | Meaning |
|---|---|
| `sync` | Full state snapshot (used on reconnect) |
| `delta` | Append text to the current assistant message |
| `thinking_delta` | Append text to the current thinking block |
| `tool_call` / `tool_result` | Tool invocation and result |
| `artifact` | New or updated artifact |
| `meta` | Token usage and cache metadata |
| `refresh` | Signal client to reload (edge cases) |

### LLM Abstraction

All providers implement a common `LLM` interface:

```ts
interface LLM {
  model: string;
  providerID: string;
  chat(request: ChatRequest): AsyncIterable<StreamEvent>;
}
```

`routeLLM(modelSlug)` maps a model identifier to the right adapter factory. Adding a new provider means implementing this interface and registering its model slugs.

## Commands Reference

| Command | Purpose |
|---|---|
| `npm run dev` | SvelteKit dev server |
| `npm run build` | Production build (Vite + postbuild) |
| `npm run preview` | `wrangler dev` against the production bundle |
| `npm run deploy` | Build and deploy to Cloudflare |
| `npm run check` | Type-check with `svelte-check` |
| `npm run test` | Run Vitest |
| `npx wrangler types` | Regenerate `worker-configuration.d.ts` after binding changes |

## License

interface, a chat-bot
Copyright (C) 2026 Piper McCorkle

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program.  If not, see <https://www.gnu.org/licenses/>.

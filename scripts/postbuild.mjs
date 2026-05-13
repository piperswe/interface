// SvelteKit's adapter-cloudflare emits `_worker.js` with only a default
// export — the SvelteKit fetch handler. Cloudflare requires Durable Object
// classes to be named exports of the deployed Worker script. We append a
// re-export so wrangler picks the class up at deploy time. Idempotent: skips
// if the export is already present.
//
// Path is relative to the worker file's location:
//   .svelte-kit/cloudflare/_worker.js → ../../src/lib/server/durable_objects/...

import { readFileSync, writeFileSync } from 'node:fs';

const WORKER_PATH = '.svelte-kit/cloudflare/_worker.js';

const DO_EXPORT =
	"\nexport { default as ConversationDurableObject } from '../../src/lib/server/durable_objects/ConversationDurableObject.ts';\n" +
	"export { default as SchedulerDurableObject } from '../../src/lib/server/durable_objects/SchedulerDurableObject.ts';\n" +
	"export { Sandbox } from '@cloudflare/sandbox';\n";

const content = readFileSync(WORKER_PATH, 'utf8');
if (content.includes('SchedulerDurableObject')) {
	process.exit(0);
}
// Drop the legacy single-DO append (if present from a previous build) and
// rewrite. Idempotent across re-builds.
const stripped = content.replace(
	/\nexport \{ default as ConversationDurableObject \}.*\nexport \{ Sandbox \} from '@cloudflare\/sandbox';\n$/s,
	'',
);
writeFileSync(WORKER_PATH, stripped + DO_EXPORT);
console.log('postbuild: appended Conversation + Scheduler DO and Sandbox exports to _worker.js');

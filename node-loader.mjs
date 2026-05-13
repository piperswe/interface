// Node.js custom ESM loader that stubs out `cloudflare:*` imports during the
// Vite SSR build step (Node.js can't load these Worker-runtime modules).

const stubs = {
	'cloudflare:test': `export const env = {};
export function runDurableObjectAlarm() {}
export function runInDurableObject() {}
`,
	'cloudflare:workers': `export class DurableObject {}
export class WorkerEntrypoint {}
export class DurableObjectState {}
export class DurableObjectNamespace {}
export class WebSocketPair {}
export class Request {}
export class Response {}
`,
};

export async function resolve(specifier, context, nextResolve) {
	if (stubs[specifier]) {
		return { shortCircuit: true, url: `stub:${specifier}` };
	}
	return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
	if (url.startsWith('stub:')) {
		const specifier = url.slice(5);
		return {
			format: 'module',
			shortCircuit: true,
			source: stubs[specifier],
		};
	}
	return nextLoad(url, context);
}

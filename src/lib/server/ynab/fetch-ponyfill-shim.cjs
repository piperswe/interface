// Shim for `fetch-ponyfill` aliased in vite/vitest config. The `ynab` SDK's
// runtime calls `require("fetch-ponyfill")()` at module load, which would
// otherwise pull `node-fetch` and its Node-only stream/url/zlib chain into
// the Worker bundle. Workers already provide a spec-compliant `fetch`, so
// we return the globals directly.
module.exports = function fetchPonyfillShim() {
	return {
		fetch: globalThis.fetch.bind(globalThis),
		Headers: globalThis.Headers,
		Request: globalThis.Request,
		Response: globalThis.Response,
	};
};

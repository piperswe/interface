// In-container HTTP reverse proxy that maps fly's public traffic to the
// process running inside the sandbox on a specific localhost port.
//
// Fly's HTTP service is statically declared in fly.toml to listen on
// public 80/443 and forward to internal port 8080 (this proxy). Inbound
// requests carry a Host header of the form
//   `${port}-${conversationId}-${token}.${appHostname}`
// (the same template `@cloudflare/sandbox` uses for its preview URLs).
// We parse the leading `${port}-` off the host, then forward to
// 127.0.0.1:${port}, preserving method/headers/body.
//
// Health: `GET /__sandbox/health` returns 200 regardless of Host so the
// fly proxy's health checks succeed before any preview port is exposed.

import http from 'node:http';

const PORT = Number(process.env.PREVIEW_PROXY_PORT || 8080);

// Set by the fly machine config (`lifecycle.ts:defaultMachineConfig`). If
// present, the proxy refuses requests whose Host segment doesn't match
// — defense-in-depth against requests that bypass the Worker (which
// constructs the Host server-side) and land here directly via fly's
// edge without a `fly-prefer-instance-id` header pinning them to this
// machine.
const OWNER_CONVERSATION_ID = process.env.SANDBOX_CONVERSATION_ID || null;

// Parse `{port}-{conversationId}-{token}.{appHostname}`. Returns the
// port number when the host is well-formed AND (if `OWNER_CONVERSATION_ID`
// is configured) the embedded conversation id matches this machine's
// owner. Returns null otherwise.
function parsePortFromHost(host) {
	if (!host) return null;
	// Strip any port suffix from the Host header (`example.com:8080`).
	const bare = host.split(':')[0];
	// Pull off the leading subdomain — that's where the
	// port-convid-token tuple lives.
	const subdomain = bare.split('.')[0];
	const m = subdomain.match(/^(\d+)-([^-]+(?:-[^-]+)*)-([^-]+)$/);
	if (!m) return null;
	const p = Number(m[1]);
	if (!Number.isInteger(p) || p <= 0 || p > 65535) return null;
	// Refuse to forward back to ourselves.
	if (p === PORT) return null;
	if (OWNER_CONVERSATION_ID && m[2] !== OWNER_CONVERSATION_ID) return null;
	return p;
}

function copyHeaders(src) {
	const headers = {};
	for (const [k, v] of Object.entries(src)) {
		if (v === undefined) continue;
		headers[k] = v;
	}
	return headers;
}

const server = http.createServer((req, res) => {
	if (req.url === '/__sandbox/health') {
		res.writeHead(200, { 'content-type': 'text/plain' });
		res.end('ok');
		return;
	}

	// Defense-in-depth: fly's HTTP service proxy is documented to
	// preserve the Host header so subdomain-based routing works, but
	// honor `x-forwarded-host` as a fallback in case fly rewrites Host
	// in a future change. The backend's `fetch()` sets Host already; if
	// fly preserves it we use it, otherwise the original host from CF
	// gets stamped onto `x-forwarded-host` by fly's edge.
	const xfh = req.headers['x-forwarded-host'];
	const xfhFirst = Array.isArray(xfh) ? xfh[0] : xfh;
	const port = parsePortFromHost(req.headers.host) ?? parsePortFromHost(xfhFirst);
	if (port === null) {
		res.writeHead(404, { 'content-type': 'text/plain' });
		res.end(`preview proxy: unrecognized host "${req.headers.host ?? ''}"`);
		return;
	}

	const upstream = http.request(
		{
			headers: copyHeaders(req.headers),
			host: '127.0.0.1',
			method: req.method,
			path: req.url,
			port,
		},
		(upstreamRes) => {
			res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
			upstreamRes.pipe(res);
		},
	);

	upstream.on('error', (err) => {
		if (!res.headersSent) {
			res.writeHead(502, { 'content-type': 'text/plain' });
			res.end(`preview proxy: upstream localhost:${port} unreachable (${err.message})`);
		} else {
			res.destroy(err);
		}
	});

	req.pipe(upstream);
});

server.listen(PORT, '0.0.0.0', () => {
	console.log(`[fly-preview-proxy] listening on :${PORT}`);
});

server.on('error', (err) => {
	console.error('[fly-preview-proxy] server error:', err);
	process.exit(1);
});

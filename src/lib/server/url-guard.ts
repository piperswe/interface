// Reject URLs that aren't HTTPS or that point at loopback / RFC 1918 /
// link-local / cloud-metadata addresses. Shared by anywhere we accept an
// operator-supplied URL that the worker will then fetch server-side
// (MCP discovery, provider endpoints).
//
// Lives under `src/lib/server` rather than `src/lib` so it can't be bundled
// into client code. Exported names start with `assert*` (throw) rather than
// `is*` (boolean) — the throwing form forces callers to handle the failure
// at the input boundary.

// Whether an IPv4 dotted-quad represented as its first two octets falls in
// loopback / RFC 1918 / link-local / multicast / reserved space. The IPv4
// branch and the IPv4-mapped IPv6 branch share this predicate so they can't
// drift.
function ipv4OctetsArePrivate(a: number, b: number): boolean {
	return (
		a === 127 || // loopback
		a === 10 || // RFC 1918
		(a === 172 && b >= 16 && b <= 31) || // RFC 1918
		(a === 192 && b === 168) || // RFC 1918
		(a === 169 && b === 254) || // link-local incl. 169.254.169.254
		a === 0 ||
		a >= 224 // multicast / reserved
	);
}

// IPv4-mapped IPv6 addresses (`::ffff:a.b.c.d`) are valid dual-stack
// representations of IPv4 — the WHATWG URL parser normalises them to the
// hex form (`::ffff:HHHH:HHHH`), so the bare IPv6 prefix checks miss them.
// Return the first two IPv4 octets so the same private-range predicate can
// run on them.
export function _ipv4MappedOctets(bareIPv6: string): [number, number] | null {
	const m = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(bareIPv6);
	if (!m) return null;
	const h1 = parseInt(m[1], 16);
	return [(h1 >> 8) & 0xff, h1 & 0xff];
}

export function assertPublicHttpsUrl(value: string): void {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error(`Invalid URL: ${value}`);
	}
	if (url.protocol !== 'https:') {
		throw new Error(`URL must use https:// (got ${url.protocol}//)`);
	}
	if (url.username || url.password) {
		throw new Error('URL must not contain credentials in userinfo');
	}
	const host = url.hostname.toLowerCase();
	if (host === 'localhost' || host === 'localhost.localdomain' || host.endsWith('.local')) {
		// `.local` is mDNS / Bonjour and rarely resolves on cloud workers, but
		// match the sibling fetch_url guard so all three SSRF predicates have
		// identical hostname coverage.
		throw new Error('URL must not target localhost');
	}
	// IPv4 literal? Check for loopback / RFC 1918 / link-local / metadata.
	const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
	if (v4 && ipv4OctetsArePrivate(Number(v4[1]), Number(v4[2]))) {
		throw new Error(`URL must not target a private/reserved IP (${host})`);
	}
	// IPv6 literal — workerd surfaces these as bracketed.
	if (host.startsWith('[') || host.includes(':')) {
		const bare = host.replace(/^\[/, '').replace(/\]$/, '');
		if (
			bare === '::1' ||
			bare === '::' ||
			bare.startsWith('fc') ||
			bare.startsWith('fd') || // fc00::/7 unique-local
			bare.startsWith('fe80:') // link-local
		) {
			throw new Error(`URL must not target a private/reserved IPv6 (${host})`);
		}
		const mapped = _ipv4MappedOctets(bare);
		if (mapped && ipv4OctetsArePrivate(mapped[0], mapped[1])) {
			throw new Error(`URL must not target a private/reserved IP (${host})`);
		}
	}
}

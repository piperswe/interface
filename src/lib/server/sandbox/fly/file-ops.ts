// Shell-mediated file I/O for the fly backend.
//
// Fly's Machines API does not expose direct file read/write endpoints, so
// each operation runs a shell command via `execMachine`. All paths are
// single-quoted via `shellQuote` (no interpolation) and option parsing is
// terminated with `--` before the user-supplied path.

import { execMachine, type FlyConfig } from './machines-api';
import type { ReadFileResult } from '../backend';

// Single-quote a string for safe use in a POSIX shell command. Embedded
// single quotes are escaped by closing-quote, escaped quote, reopening
// quote: 'foo' + \' + 'bar'  →  'foo'\''bar'.
export function shellQuote(s: string): string {
	return `'${s.replaceAll("'", `'\\''`)}'`;
}

async function execShell(
	cfg: FlyConfig,
	machineId: string,
	script: string,
	stdin?: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const resp = await execMachine(cfg, machineId, {
		cmd: ['bash', '-c', script],
		...(stdin !== undefined ? { stdin } : {}),
	});
	return {
		exitCode: resp.exit_code,
		stdout: resp.stdout ?? '',
		stderr: resp.stderr ?? '',
	};
}

export async function readFileShell(
	cfg: FlyConfig,
	machineId: string,
	path: string,
): Promise<ReadFileResult> {
	const p = shellQuote(path);
	// 1) Verify the file exists & is a regular file.
	// 2) Detect encoding via `file --mime-encoding` (text vs binary).
	// 3) Emit content as base64 unconditionally — the caller decodes when
	//    encoding === 'utf8'. base64 keeps the protocol byte-clean and
	//    lets the server skip any guess-the-encoding logic.
	const script = `set -e
if [ ! -e -- ${p} ]; then echo "no such file: ${path}" >&2; exit 2; fi
if [ ! -f -- ${p} ]; then echo "not a regular file: ${path}" >&2; exit 2; fi
ENC=$(file --mime-encoding -b -- ${p} 2>/dev/null || echo unknown)
echo "ENC:$ENC"
base64 -w0 -- ${p}`;
	const r = await execShell(cfg, machineId, script);
	if (r.exitCode !== 0) {
		throw new Error(`readFile failed for ${path}: ${r.stderr || r.stdout || `exit ${r.exitCode}`}`);
	}
	// Parse first line (ENC:…) then base64 payload (which is the rest).
	const nl = r.stdout.indexOf('\n');
	if (nl < 0) throw new Error(`readFile: malformed response for ${path}`);
	const encLine = r.stdout.slice(0, nl);
	const b64 = r.stdout.slice(nl + 1).trim();
	const enc = encLine.startsWith('ENC:') ? encLine.slice(4).trim() : 'unknown';
	const isText = enc !== 'binary' && enc !== 'unknown' && !enc.startsWith('application/');
	if (isText) {
		// Decode base64 → utf8 string. Worker runtime has atob; we then
		// turn the binary string into a real Uint8Array and TextDecode.
		try {
			const bin = atob(b64);
			const bytes = new Uint8Array(bin.length);
			for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
			return { content: new TextDecoder('utf-8', { fatal: false }).decode(bytes), encoding: 'utf8' };
		} catch {
			// Fall through to base64 if decoding hiccups.
		}
	}
	return { content: b64, encoding: 'base64' };
}

export async function writeFileShell(
	cfg: FlyConfig,
	machineId: string,
	path: string,
	content: string,
): Promise<void> {
	const p = shellQuote(path);
	// Encode content as base64 on the client side, pipe via stdin to
	// `base64 -d` on the server. This avoids any shell-escaping or
	// chunking concerns with arbitrary file contents.
	const bytes = new TextEncoder().encode(content);
	let bin = '';
	const CHUNK = 0x8000;
	for (let i = 0; i < bytes.length; i += CHUNK) {
		bin += String.fromCharCode.apply(
			null,
			Array.from(bytes.subarray(i, i + CHUNK)),
		);
	}
	const b64 = btoa(bin);
	const script = `set -e
mkdir -p -- "$(dirname -- ${p})"
base64 -d > ${p}`;
	const r = await execShell(cfg, machineId, script, b64);
	if (r.exitCode !== 0) {
		throw new Error(`writeFile failed for ${path}: ${r.stderr || r.stdout || `exit ${r.exitCode}`}`);
	}
}

export async function deleteFileShell(
	cfg: FlyConfig,
	machineId: string,
	path: string,
): Promise<void> {
	const p = shellQuote(path);
	const r = await execShell(cfg, machineId, `rm -f -- ${p}`);
	if (r.exitCode !== 0) {
		throw new Error(`deleteFile failed for ${path}: ${r.stderr || `exit ${r.exitCode}`}`);
	}
}

export async function mkdirShell(
	cfg: FlyConfig,
	machineId: string,
	path: string,
	recursive: boolean,
): Promise<void> {
	const p = shellQuote(path);
	const flag = recursive ? '-p' : '';
	const r = await execShell(cfg, machineId, `mkdir ${flag} -- ${p}`);
	if (r.exitCode !== 0) {
		throw new Error(`mkdir failed for ${path}: ${r.stderr || `exit ${r.exitCode}`}`);
	}
}

export async function existsShell(
	cfg: FlyConfig,
	machineId: string,
	path: string,
): Promise<{ exists: boolean }> {
	const p = shellQuote(path);
	// Return 0 with stdout "1"/"0" so we don't confuse the test result with
	// other errors (a missing path is not a failure).
	const r = await execShell(cfg, machineId, `if [ -e -- ${p} ]; then echo 1; else echo 0; fi`);
	if (r.exitCode !== 0) {
		throw new Error(`exists failed for ${path}: ${r.stderr || `exit ${r.exitCode}`}`);
	}
	return { exists: r.stdout.trim() === '1' };
}

export async function runCodeShell(
	cfg: FlyConfig,
	machineId: string,
	code: string,
	language: 'python' | 'javascript' | 'typescript',
	timeoutMs?: number,
): Promise<{
	stdout: string;
	stderr: string;
	exitCode: number;
}> {
	const ext = language === 'python' ? 'py' : language === 'javascript' ? 'js' : 'ts';
	const runner =
		language === 'python'
			? 'python3'
			: language === 'javascript'
				? 'node'
				: 'tsx';
	// Random-ish file name to avoid collisions across concurrent calls.
	const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
	const file = `/tmp/run-${nonce}.${ext}`;
	const p = shellQuote(file);
	// Encode code via base64 to avoid any shell-escaping pitfalls with
	// quotes, dollar signs, backticks, etc.
	const bytes = new TextEncoder().encode(code);
	let bin = '';
	const CHUNK = 0x8000;
	for (let i = 0; i < bytes.length; i += CHUNK) {
		bin += String.fromCharCode.apply(
			null,
			Array.from(bytes.subarray(i, i + CHUNK)),
		);
	}
	const b64 = btoa(bin);
	const script = `set -e
echo ${shellQuote(b64)} | base64 -d > ${p}
${runner} ${p}
RC=$?
rm -f ${p}
exit $RC`;
	const resp = await execMachine(cfg, machineId, {
		cmd: ['bash', '-c', script],
		...(timeoutMs ? { timeout: Math.ceil(timeoutMs / 1000) } : {}),
	});
	return {
		stdout: resp.stdout ?? '',
		stderr: resp.stderr ?? '',
		exitCode: resp.exit_code,
	};
}

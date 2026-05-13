import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
	vi.restoreAllMocks();
});

import type { FlyConfig } from './client';
import { deleteFileShell, existsShell, mkdirShell, readFileShell, runCodeShell, shellQuote, writeFileShell } from './file-ops';

// Shell quoting must survive every adversarial path we throw at it: a
// stray $(...) substitution, a leading dash that could be confused for a
// flag, embedded single quotes, embedded newlines. The combination of
// `shellQuote` + the `--` option terminator in every script is what
// keeps the fly file-ops shell-injection-safe.

describe('shellQuote', () => {
	it('wraps simple strings in single quotes', () => {
		expect(shellQuote('hello')).toBe(`'hello'`);
	});

	it('escapes embedded single quotes', () => {
		// Regression: a quote inside the path used to terminate the wrapper
		// and let the rest of the path execute as shell.
		expect(shellQuote(`it's`)).toBe(`'it'\\''s'`);
	});

	it('preserves command-substitution syntax as literal', () => {
		// A path containing `$(rm -rf /)` must not execute the command —
		// single-quoting prevents the shell from expanding $(.
		const quoted = shellQuote(`/tmp/$(rm -rf /)`);
		expect(quoted).toBe(`'/tmp/$(rm -rf /)'`);
	});

	it('preserves newlines', () => {
		expect(shellQuote(`a\nb`)).toBe(`'a\nb'`);
	});

	it('preserves backslashes and dollar signs', () => {
		expect(shellQuote(`$HOME\\foo`)).toBe(`'$HOME\\foo'`);
	});
});

// File-ops integration: drive against a mocked Machines API to verify the
// shell scripts are well-formed and route the right exit code back.

const CFG: FlyConfig = { appHostname: 'a.fly.dev', appName: 'a', token: 't' };

function mockMachineExec(handler: (req: unknown) => unknown) {
	return vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
		const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
		const out = handler(body);
		return new Response(JSON.stringify(out), {
			headers: { 'content-type': 'application/json' },
			status: 200,
		});
	});
}

describe('file-ops shell scripts', () => {
	it('mkdirShell passes `--` to terminate option parsing', async () => {
		let seenScript = '';
		mockMachineExec((req) => {
			const r = req as { command: string[] };
			seenScript = r.command.join(' ');
			return { exit_code: 0, stderr: '', stdout: '' };
		});
		// A path beginning with `-` could otherwise be parsed as a flag by mkdir.
		await mkdirShell(CFG, 'machine-1', '-rf', false);
		expect(seenScript).toContain('mkdir');
		expect(seenScript).toContain('--');
		expect(seenScript).toContain(`'-rf'`);
	});

	it('mkdirShell uses -p when recursive is true', async () => {
		let seenScript = '';
		mockMachineExec((req) => {
			seenScript = (req as { command: string[] }).command.join(' ');
			return { exit_code: 0, stderr: '', stdout: '' };
		});
		await mkdirShell(CFG, 'machine-1', '/a/b/c', true);
		expect(seenScript).toMatch(/mkdir\s+-p\s+--/);
	});

	it('existsShell reports false when the test command prints 0', async () => {
		mockMachineExec(() => ({ exit_code: 0, stderr: '', stdout: '0\n' }));
		const result = await existsShell(CFG, 'machine-1', '/missing');
		expect(result).toEqual({ exists: false });
	});

	it('existsShell reports true when the test command prints 1', async () => {
		mockMachineExec(() => ({ exit_code: 0, stderr: '', stdout: '1\n' }));
		const result = await existsShell(CFG, 'machine-1', '/present');
		expect(result).toEqual({ exists: true });
	});

	it('existsShell uses `test -e` not `[ -e -- ... ]`', async () => {
		// Regression: `[` / `test` does not recognise `--` as an option
		// terminator, so `[ -e -- "$P" ]` is a malformed 3-arg test that
		// always returns exit 2 (treated as false). The path comes from
		// shellQuote and is already safe; we don't need (and must not use)
		// `--` inside the test builtin.
		let seenScript = '';
		mockMachineExec((req) => {
			seenScript = (req as { command: string[] }).command[2] ?? '';
			return { exit_code: 0, stderr: '', stdout: '1\n' };
		});
		await existsShell(CFG, 'machine-1', '/some/path');
		expect(seenScript).toContain('test -e');
		expect(seenScript).not.toMatch(/\[\s*-e\s+--/);
	});

	it('deleteFileShell surfaces stderr on non-zero exit', async () => {
		mockMachineExec(() => ({ exit_code: 1, stderr: 'permission denied', stdout: '' }));
		await expect(deleteFileShell(CFG, 'machine-1', '/root/file')).rejects.toThrow(/permission denied/);
	});

	it('readFileShell never lets the raw path into a double-quoted echo', async () => {
		// Regression: the error-path echos used to interpolate
		// `${path}` (JS template) inside `"no such file: ${path}"`,
		// which bash evaluates — so a malicious-looking path like
		// `/tmp/$(whoami)` would execute. The shell-quoted form
		// (`${p}`, single-quoted) must be used instead, concatenated
		// with the literal prefix.
		let seenScript = '';
		mockMachineExec((req) => {
			seenScript = (req as { command: string[] }).command[2] ?? '';
			return { exit_code: 0, stderr: '', stdout: `ENC:us-ascii\n${btoa('x')}` };
		});
		await readFileShell(CFG, 'machine-1', '/tmp/$(whoami)');
		expect(seenScript).not.toContain('$(whoami)"'); // not inside a "...$()..."
		// The single-quoted form preserves the literal text.
		expect(seenScript).toContain(`'/tmp/$(whoami)'`);
	});

	it('readFileShell uses `test -e`/`test -f` not `[ -e -- ... ]`', async () => {
		// Regression — same bash-test malformedness as existsShell.
		let seenScript = '';
		mockMachineExec((req) => {
			seenScript = (req as { command: string[] }).command[2] ?? '';
			// Emit a fake ENC: line + base64 payload so the parser succeeds.
			return { exit_code: 0, stderr: '', stdout: `ENC:us-ascii\n${btoa('hello')}` };
		});
		const result = await readFileShell(CFG, 'machine-1', '/some/path');
		expect(seenScript).toContain('test -e');
		expect(seenScript).toContain('test -f');
		expect(seenScript).not.toMatch(/\[\s*!?\s*-[ef]\s+--/);
		expect(result.content).toBe('hello');
	});

	it('runCodeShell turns set -e off around the runner so cleanup runs on failure', async () => {
		// Regression: with `set -e` covering the runner, a non-zero exit
		// from python3/node/tsx skipped the `rm -f` and leaked the temp
		// file. The script must disable -e around the runner so the
		// cleanup always runs.
		let seenScript = '';
		mockMachineExec((req) => {
			seenScript = (req as { command: string[] }).command[2] ?? '';
			return { exit_code: 1, stderr: 'boom', stdout: '' };
		});
		await runCodeShell(CFG, 'machine-1', 'print(1/0)', 'python');
		expect(seenScript).toContain('set +e');
		// The rm + exit must come after the runner invocation.
		expect(seenScript).toMatch(/python3 [^\n]+\nRC=\$\?\nrm -f/);
	});

	it('writeFileShell base64-encodes content as stdin', async () => {
		let seenBody: unknown = null;
		mockMachineExec((req) => {
			seenBody = req;
			return { exit_code: 0, stderr: '', stdout: '' };
		});
		await writeFileShell(CFG, 'machine-1', '/tmp/x', 'hello world');
		const body = seenBody as { command: string[]; stdin?: string };
		expect(body.command[0]).toBe('bash');
		expect(body.command[1]).toBe('-c');
		expect(body.command[2]).toMatch(/base64 -d/);
		// stdin is the base64 encoding of "hello world".
		expect(body.stdin).toBe(btoa('hello world'));
	});
});

import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
	vi.restoreAllMocks();
});
import { shellQuote } from './file-ops';
import { existsShell, mkdirShell, deleteFileShell, writeFileShell } from './file-ops';
import type { FlyConfig } from './machines-api';

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

const CFG: FlyConfig = { token: 't', appName: 'a', appHostname: 'a.fly.dev' };

function mockMachineExec(handler: (req: unknown) => unknown) {
	return vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
		const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
		const out = handler(body);
		return new Response(JSON.stringify(out), {
			status: 200,
			headers: { 'content-type': 'application/json' },
		});
	});
}

describe('file-ops shell scripts', () => {
	it('mkdirShell passes `--` to terminate option parsing', async () => {
		let seenScript = '';
		mockMachineExec((req) => {
			const r = req as { cmd: string[] };
			seenScript = r.cmd.join(' ');
			return { exit_code: 0, stdout: '', stderr: '' };
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
			seenScript = (req as { cmd: string[] }).cmd.join(' ');
			return { exit_code: 0, stdout: '', stderr: '' };
		});
		await mkdirShell(CFG, 'machine-1', '/a/b/c', true);
		expect(seenScript).toMatch(/mkdir\s+-p\s+--/);
	});

	it('existsShell reports false when the test command prints 0', async () => {
		mockMachineExec(() => ({ exit_code: 0, stdout: '0\n', stderr: '' }));
		const result = await existsShell(CFG, 'machine-1', '/missing');
		expect(result).toEqual({ exists: false });
	});

	it('existsShell reports true when the test command prints 1', async () => {
		mockMachineExec(() => ({ exit_code: 0, stdout: '1\n', stderr: '' }));
		const result = await existsShell(CFG, 'machine-1', '/present');
		expect(result).toEqual({ exists: true });
	});

	it('deleteFileShell surfaces stderr on non-zero exit', async () => {
		mockMachineExec(() => ({ exit_code: 1, stdout: '', stderr: 'permission denied' }));
		await expect(deleteFileShell(CFG, 'machine-1', '/root/file')).rejects.toThrow(/permission denied/);
	});

	it('writeFileShell base64-encodes content as stdin', async () => {
		let seenBody: unknown = null;
		mockMachineExec((req) => {
			seenBody = req;
			return { exit_code: 0, stdout: '', stderr: '' };
		});
		await writeFileShell(CFG, 'machine-1', '/tmp/x', 'hello world');
		const body = seenBody as { cmd: string[]; stdin?: string };
		expect(body.cmd[0]).toBe('bash');
		expect(body.cmd[1]).toBe('-c');
		expect(body.cmd[2]).toMatch(/base64 -d/);
		// stdin is the base64 encoding of "hello world".
		expect(body.stdin).toBe(btoa('hello world'));
	});
});

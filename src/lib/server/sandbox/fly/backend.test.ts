import { describe, expect, it } from 'vitest';
import { _buildShellCommand } from './backend';

describe('buildShellCommand', () => {
	it('exports valid POSIX env var names with safely-quoted values', () => {
		const script = _buildShellCommand('whoami', {
			env: { FOO_BAR: 'baz', _UNDERSCORE: 'a "b" c' },
		});
		expect(script).toContain('export FOO_BAR="baz"');
		// JSON.stringify escapes the inner double quotes, so the
		// generated shell `export` is well-formed.
		expect(script).toContain('export _UNDERSCORE="a \\"b\\" c"');
		expect(script).toContain('\nwhoami');
	});

	it('cd is JSON-quoted so a path with spaces is preserved', () => {
		const script = _buildShellCommand('ls', { cwd: '/tmp/with space' });
		expect(script).toContain('cd "/tmp/with space"');
	});

	it('rejects env keys that contain shell metacharacters', () => {
		// Regression: a key like `FOO;rm -rf /` would otherwise be
		// interpolated raw, producing `export FOO;rm -rf /="bar"` —
		// arbitrary command execution. POSIX env var names don't allow
		// semicolons, so reject locally instead of paying a round-trip
		// to fly only to fail there (or worse, succeed silently).
		expect(() => _buildShellCommand('echo', { env: { 'FOO;rm -rf /': 'bar' } })).toThrow(
			/Invalid env var name/,
		);
	});

	it('rejects env keys starting with a digit', () => {
		expect(() => _buildShellCommand('echo', { env: { '1FOO': 'bar' } })).toThrow(
			/Invalid env var name/,
		);
	});

	it('rejects env keys with a dollar sign', () => {
		expect(() => _buildShellCommand('echo', { env: { FOO$BAR: 'baz' } })).toThrow(
			/Invalid env var name/,
		);
	});
});

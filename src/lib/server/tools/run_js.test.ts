import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { runJsTool } from './run_js';

const ctx = { env, conversationId: 'c', assistantMessageId: 'a', modelId: 'p/m' };

describe('run_js tool', () => {
	it('rejects missing code', async () => {
		const result = await runJsTool.execute(ctx, {});
		expect(result.isError).toBe(true);
		expect(result.errorCode).toBe('invalid_input');
		expect(result.content).toMatch(/code/);
	});

	it('returns the value of the snippet', async () => {
		const result = await runJsTool.execute(ctx, { code: 'return 2 + 3;' });
		expect(result.isError).toBeFalsy();
		expect(result.content).toContain('--- result ---');
		expect(result.content).toContain('5');
	});

	it('captures console output and returns a JSON-serialized object', async () => {
		const result = await runJsTool.execute(ctx, {
			code: "console.log('hello'); console.warn('careful'); return { a: 1, b: [2, 3] };",
		});
		expect(result.isError).toBeFalsy();
		expect(result.content).toContain('--- console ---');
		expect(result.content).toContain('hello');
		expect(result.content).toContain('[warn] careful');
		expect(result.content).toContain('--- result ---');
		expect(result.content).toContain('"a": 1');
		expect(result.content).toContain('"b"');
	});

	it('supports top-level await', async () => {
		const result = await runJsTool.execute(ctx, {
			code: 'const x = await Promise.resolve(7); return x * 6;',
		});
		expect(result.isError).toBeFalsy();
		expect(result.content).toContain('42');
	});

	it('reports thrown errors as tool errors', async () => {
		const result = await runJsTool.execute(ctx, {
			code: "throw new Error('boom');",
		});
		expect(result.isError).toBe(true);
		expect(result.errorCode).toBe('execution_failure');
		expect(result.content).toContain('--- error ---');
		expect(result.content).toMatch(/Error: boom/);
	});

	it('reports "(no output)" when nothing is logged or returned', async () => {
		const result = await runJsTool.execute(ctx, { code: 'const x = 1;' });
		expect(result.isError).toBeFalsy();
		expect(result.content).toBe('(no output)');
	});

	it('rejects when the loader binding is missing', async () => {
		const ctxWithoutLoader = {
			...ctx,
			env: { ...ctx.env, RUN_JS_LOADER: undefined } as unknown as typeof ctx.env,
		};
		const result = await runJsTool.execute(ctxWithoutLoader, { code: 'return 1;' });
		expect(result.isError).toBe(true);
		expect(result.content).toMatch(/RUN_JS_LOADER/);
	});
});

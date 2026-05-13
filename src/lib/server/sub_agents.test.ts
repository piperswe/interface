import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { assertDefined } from '../../../test/assert-defined';
import {
	createSubAgent,
	deleteSubAgent,
	getSubAgent,
	getSubAgentByName,
	isValidSubAgentName,
	listSubAgents,
	setSubAgentEnabled,
	updateSubAgent,
} from './sub_agents';

afterEach(async () => {
	await env.DB.prepare('DELETE FROM sub_agents').run();
});

describe('sub_agents', () => {
	const baseInput = {
		description: 'Research a topic',
		name: 'researcher',
		systemPrompt: 'You are a research specialist.',
	};

	it('createSubAgent returns an id and listSubAgents reads the row back', async () => {
		const id = await createSubAgent(env, baseInput);
		expect(id).toBeGreaterThan(0);
		const rows = await listSubAgents(env);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			allowedTools: null,
			description: 'Research a topic',
			enabled: true,
			maxIterations: null,
			model: null,
			name: 'researcher',
			systemPrompt: 'You are a research specialist.',
		});
	});

	it('persists optional fields (model, maxIterations, allowedTools)', async () => {
		const id = await createSubAgent(env, {
			...baseInput,
			allowedTools: ['web_search', 'fetch_url'],
			maxIterations: 8,
			model: 'anthropic/claude-haiku-4.5',
		});
		const row = await getSubAgent(env, id);
		expect(row).toMatchObject({
			allowedTools: ['web_search', 'fetch_url'],
			maxIterations: 8,
			model: 'anthropic/claude-haiku-4.5',
		});
	});

	it('rejects invalid names', async () => {
		await expect(createSubAgent(env, { ...baseInput, name: 'Bad Name' })).rejects.toThrow();
		await expect(createSubAgent(env, { ...baseInput, name: '1starts-with-digit' })).rejects.toThrow();
		await expect(createSubAgent(env, { ...baseInput, name: '' })).rejects.toThrow();
	});

	it('isValidSubAgentName accepts snake_case and kebab-case', () => {
		expect(isValidSubAgentName('researcher')).toBe(true);
		expect(isValidSubAgentName('code_reviewer')).toBe(true);
		expect(isValidSubAgentName('pr-watcher')).toBe(true);
		expect(isValidSubAgentName('a')).toBe(true);
		expect(isValidSubAgentName('A')).toBe(false);
		expect(isValidSubAgentName('1bad')).toBe(false);
		expect(isValidSubAgentName('')).toBe(false);
		expect(isValidSubAgentName('has space')).toBe(false);
	});

	it('rejects empty description and system prompt', async () => {
		await expect(createSubAgent(env, { ...baseInput, description: '' })).rejects.toThrow();
		await expect(createSubAgent(env, { ...baseInput, systemPrompt: '   ' })).rejects.toThrow();
	});

	it('getSubAgentByName resolves by user_id + name', async () => {
		await createSubAgent(env, baseInput, 1);
		const row = await getSubAgentByName(env, 'researcher', 1);
		expect(row?.name).toBe('researcher');
		expect(await getSubAgentByName(env, 'researcher', 2)).toBeNull();
		expect(await getSubAgentByName(env, 'unknown', 1)).toBeNull();
	});

	it('updateSubAgent patches fields without disturbing others', async () => {
		const id = await createSubAgent(env, { ...baseInput, model: 'm-1' });
		await updateSubAgent(env, id, { description: 'New description' });
		const row = await getSubAgent(env, id);
		expect(row?.description).toBe('New description');
		expect(row?.model).toBe('m-1');
		expect(row?.systemPrompt).toBe(baseInput.systemPrompt);
	});

	it('updateSubAgent can clear allowedTools by passing null', async () => {
		const id = await createSubAgent(env, { ...baseInput, allowedTools: ['web_search'] });
		await updateSubAgent(env, id, { allowedTools: null });
		const row = await getSubAgent(env, id);
		expect(row?.allowedTools).toBeNull();
	});

	it('setSubAgentEnabled toggles the enabled flag', async () => {
		const id = await createSubAgent(env, baseInput);
		await setSubAgentEnabled(env, id, false);
		const row = await getSubAgent(env, id);
		expect(row?.enabled).toBe(false);
	});

	it('deleteSubAgent removes the row, scoped by user_id', async () => {
		const id = await createSubAgent(env, baseInput, 1);
		await deleteSubAgent(env, id, 2); // wrong user — should not delete
		expect(await listSubAgents(env, 1)).toHaveLength(1);
		await deleteSubAgent(env, id, 1);
		expect(await listSubAgents(env, 1)).toHaveLength(0);
	});

	it('isolates rows per user_id', async () => {
		await createSubAgent(env, { ...baseInput, name: 'a' }, 1);
		await createSubAgent(env, { ...baseInput, name: 'b' }, 2);
		expect((await listSubAgents(env, 1)).map((r) => r.name)).toEqual(['a']);
		expect((await listSubAgents(env, 2)).map((r) => r.name)).toEqual(['b']);
	});

	it('UNIQUE (user_id, name) prevents duplicate names per user', async () => {
		await createSubAgent(env, baseInput, 1);
		await expect(createSubAgent(env, baseInput, 1)).rejects.toThrow();
		// But the same name in a different user is fine.
		await expect(createSubAgent(env, baseInput, 2)).resolves.toBeGreaterThan(0);
	});

	it('createSubAgent treats an empty allowedTools array as null', async () => {
		// Empty array isn't meaningful — the schema allows null only.
		const id = await createSubAgent(env, { ...baseInput, allowedTools: [] });
		const row = await getSubAgent(env, id);
		expect(row?.allowedTools).toBeNull();
	});

	it('rowToSubAgent filters non-string entries out of allowedTools', async () => {
		// Write tools_json directly with a mix of types — the row mapper should
		// keep only the string entries when reading back.
		const id = await createSubAgent(env, baseInput);
		await env.DB.prepare('UPDATE sub_agents SET tools_json = ? WHERE id = ?')
			.bind(JSON.stringify([1, 'web_search', null, 'fetch_url', { ignored: true }]), id)
			.run();
		const row = await getSubAgent(env, id);
		expect(row?.allowedTools).toEqual(['web_search', 'fetch_url']);
	});

	it('rowToSubAgent treats non-array tools_json as null', async () => {
		const id = await createSubAgent(env, baseInput);
		await env.DB.prepare('UPDATE sub_agents SET tools_json = ? WHERE id = ?').bind('"not-an-array"', id).run();
		const row = await getSubAgent(env, id);
		expect(row?.allowedTools).toBeNull();
	});

	it('rowToSubAgent treats malformed JSON as null (does not throw)', async () => {
		const id = await createSubAgent(env, baseInput);
		await env.DB.prepare('UPDATE sub_agents SET tools_json = ? WHERE id = ?').bind('this-is-not-json', id).run();
		const row = await getSubAgent(env, id);
		expect(row?.allowedTools).toBeNull();
	});

	it('rowToSubAgent returns null when the array contains no strings', async () => {
		const id = await createSubAgent(env, baseInput);
		await env.DB.prepare('UPDATE sub_agents SET tools_json = ? WHERE id = ?')
			.bind(JSON.stringify([1, 2, 3]), id)
			.run();
		const row = await getSubAgent(env, id);
		expect(row?.allowedTools).toBeNull();
	});

	it('updateSubAgent ignores names that fail validation, even mid-patch', async () => {
		const id = await createSubAgent(env, baseInput);
		await expect(updateSubAgent(env, id, { description: 'changed', name: 'BAD NAME' })).rejects.toThrow();
		// Description should NOT have been applied because the call threw before issuing the UPDATE.
		const row = await getSubAgent(env, id);
		expect(row?.description).toBe('Research a topic');
	});

	it('updateSubAgent is a no-op when only invalid fields are passed', async () => {
		const id = await createSubAgent(env, baseInput, 1);
		// Wrong user_id — early return without throwing or updating.
		await updateSubAgent(env, id, { description: 'leaked' }, 2);
		const row = await getSubAgent(env, id);
		expect(row?.description).toBe('Research a topic');
	});

	it('updateSubAgent bumps updated_at when at least one field changes', async () => {
		const id = await createSubAgent(env, baseInput);
		const before = await getSubAgent(env, id);
		await new Promise((r) => setTimeout(r, 5));
		await updateSubAgent(env, id, { description: 'newer' });
		const after = await getSubAgent(env, id);
		assertDefined(after);
		assertDefined(before);
		expect(after.updatedAt).toBeGreaterThan(before.updatedAt);
	});

	it('updateSubAgent with empty patch does not bump updated_at', async () => {
		const id = await createSubAgent(env, baseInput);
		const before = await getSubAgent(env, id);
		await new Promise((r) => setTimeout(r, 5));
		await updateSubAgent(env, id, {});
		const after = await getSubAgent(env, id);
		assertDefined(after);
		assertDefined(before);
		expect(after.updatedAt).toBe(before.updatedAt);
	});

	it('persists empty-array allowedTools update as null', async () => {
		const id = await createSubAgent(env, { ...baseInput, allowedTools: ['web_search'] });
		await updateSubAgent(env, id, { allowedTools: [] });
		const row = await getSubAgent(env, id);
		expect(row?.allowedTools).toBeNull();
	});

	it('isValidSubAgentName has a 64-character upper limit', async () => {
		// 1 + 63 = 64 chars (start letter + 63 of [a-z0-9_-]).
		expect(isValidSubAgentName(`a${'b'.repeat(63)}`)).toBe(true);
		expect(isValidSubAgentName(`a${'b'.repeat(64)}`)).toBe(false);
	});

	it('isValidSubAgentName rejects names containing only the start char repeated past the cap', () => {
		expect(isValidSubAgentName('aa'.repeat(40))).toBe(false);
	});

	it('isValidSubAgentName rejects names containing dots, slashes, or @ signs', () => {
		expect(isValidSubAgentName('a.b')).toBe(false);
		expect(isValidSubAgentName('a/b')).toBe(false);
		expect(isValidSubAgentName('a@b')).toBe(false);
	});
});

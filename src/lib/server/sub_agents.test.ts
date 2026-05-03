import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
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
		name: 'researcher',
		description: 'Research a topic',
		systemPrompt: 'You are a research specialist.',
	};

	it('createSubAgent returns an id and listSubAgents reads the row back', async () => {
		const id = await createSubAgent(env, baseInput);
		expect(id).toBeGreaterThan(0);
		const rows = await listSubAgents(env);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			name: 'researcher',
			description: 'Research a topic',
			systemPrompt: 'You are a research specialist.',
			enabled: true,
			model: null,
			maxIterations: null,
			allowedTools: null,
		});
	});

	it('persists optional fields (model, maxIterations, allowedTools)', async () => {
		const id = await createSubAgent(env, {
			...baseInput,
			model: 'anthropic/claude-haiku-4.5',
			maxIterations: 8,
			allowedTools: ['web_search', 'fetch_url'],
		});
		const row = await getSubAgent(env, id);
		expect(row).toMatchObject({
			model: 'anthropic/claude-haiku-4.5',
			maxIterations: 8,
			allowedTools: ['web_search', 'fetch_url'],
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
		expect((await listSubAgents(env, 1))).toHaveLength(1);
		await deleteSubAgent(env, id, 1);
		expect((await listSubAgents(env, 1))).toHaveLength(0);
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
});

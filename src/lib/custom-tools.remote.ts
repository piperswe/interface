import { form, getRequestEvent } from '$app/server';
import { error, redirect } from '@sveltejs/kit';
import {
	createCustomTool,
	deleteCustomTool,
	setCustomToolEnabled,
	updateCustomTool,
} from '$lib/server/custom_tools';

function getEnv(): Env {
	const event = getRequestEvent();
	if (!event.platform) error(500, 'Cloudflare platform bindings unavailable');
	return event.platform.env;
}

const DEFAULT_SOURCE = `import { WorkerEntrypoint } from 'cloudflare:workers';

export default class extends WorkerEntrypoint {
  async run(input) {
    // input is the JSON object the caller passed (matches input_schema below)
    // this.env contains the secrets you registered for this tool
    return { ok: true, echo: input };
  }
}
`;

const DEFAULT_INPUT_SCHEMA = JSON.stringify(
	{ type: 'object', properties: {}, additionalProperties: true },
	null,
	2,
);

export const addCustomTool = form(
	'unchecked',
	async (data: { name?: unknown; description?: unknown }) => {
		const name = String(data.name ?? '').trim();
		const description = String(data.description ?? '').trim();
		if (!name) error(400, 'Name is required.');
		if (!description) error(400, 'Description is required.');
		let id: number;
		try {
			id = await createCustomTool(getEnv(), {
				name,
				description,
				source: DEFAULT_SOURCE,
				inputSchema: DEFAULT_INPUT_SCHEMA,
				secretsJson: null,
			});
		} catch (e) {
			error(400, e instanceof Error ? e.message : String(e));
		}
		redirect(303, `/settings/tools/${id}`);
	},
);

export const saveCustomTool = form(
	'unchecked',
	async (data: {
		id?: unknown;
		name?: unknown;
		description?: unknown;
		source?: unknown;
		input_schema?: unknown;
		secrets_json?: unknown;
	}) => {
		const id = Number.parseInt(String(data.id ?? ''), 10);
		if (!Number.isFinite(id) || id <= 0) error(400, 'Invalid id.');
		const name = String(data.name ?? '').trim();
		const description = String(data.description ?? '').trim();
		const source = String(data.source ?? '');
		const inputSchema = String(data.input_schema ?? '').trim();
		const secretsRaw = String(data.secrets_json ?? '').trim();
		if (!name) error(400, 'Name is required.');
		if (!description) error(400, 'Description is required.');
		if (!source.trim()) error(400, 'Source is required.');
		if (!inputSchema) error(400, 'Input schema is required.');
		try {
			await updateCustomTool(getEnv(), id, {
				name,
				description,
				source,
				inputSchema,
				secretsJson: secretsRaw || null,
			});
		} catch (e) {
			error(400, e instanceof Error ? e.message : String(e));
		}
		redirect(303, `/settings/tools/${id}`);
	},
);

export const removeCustomTool = form('unchecked', async (data: { id?: unknown }) => {
	const id = Number.parseInt(String(data.id ?? ''), 10);
	if (!Number.isFinite(id) || id <= 0) error(400, 'Invalid id.');
	await deleteCustomTool(getEnv(), id);
	redirect(303, '/settings');
});

export const toggleCustomTool = form(
	'unchecked',
	async (data: { id?: unknown; enabled?: unknown }) => {
		const id = Number.parseInt(String(data.id ?? ''), 10);
		if (!Number.isFinite(id) || id <= 0) error(400, 'Invalid id.');
		const enabled = String(data.enabled ?? '') === 'true';
		await setCustomToolEnabled(getEnv(), id, enabled);
		redirect(303, '/settings');
	},
);

import { error, redirect } from '@sveltejs/kit';
import { z } from 'zod';
import { form, getRequestEvent } from '$app/server';
import { createCustomTool, deleteCustomTool, setCustomToolEnabled, updateCustomTool } from '$lib/server/custom_tools';
import { positiveIntFromString, trimmedNonEmpty } from '$lib/server/remote-schemas';

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

const DEFAULT_INPUT_SCHEMA = JSON.stringify({ additionalProperties: true, properties: {}, type: 'object' }, null, 2);

export const addCustomTool = form(
	z.object({
		description: trimmedNonEmpty('Description is required.'),
		name: trimmedNonEmpty('Name is required.'),
	}),
	async ({ name, description }) => {
		let id: number;
		try {
			id = await createCustomTool(getEnv(), {
				description,
				inputSchema: DEFAULT_INPUT_SCHEMA,
				name,
				secretsJson: null,
				source: DEFAULT_SOURCE,
			});
		} catch (e) {
			error(400, e instanceof Error ? e.message : String(e));
		}
		redirect(303, `/settings/tools/${id}`);
	},
);

export const saveCustomTool = form(
	z.object({
		description: trimmedNonEmpty('Description is required.'),
		id: positiveIntFromString,
		input_schema: trimmedNonEmpty('Input schema is required.'),
		name: trimmedNonEmpty('Name is required.'),
		secrets_json: z.string().optional().default(''),
		source: z.string().refine((s) => s.trim().length > 0, 'Source is required.'),
	}),
	async ({ id, name, description, source, input_schema, secrets_json }) => {
		const secretsRaw = secrets_json.trim();
		try {
			await updateCustomTool(getEnv(), id, {
				description,
				inputSchema: input_schema,
				name,
				secretsJson: secretsRaw || null,
				source,
			});
		} catch (e) {
			error(400, e instanceof Error ? e.message : String(e));
		}
		redirect(303, `/settings/tools/${id}`);
	},
);

export const removeCustomTool = form(z.object({ id: positiveIntFromString }), async ({ id }) => {
	await deleteCustomTool(getEnv(), id);
	redirect(303, '/settings');
});

export const toggleCustomTool = form(
	z.object({
		enabled: z.string().optional(),
		id: positiveIntFromString,
	}),
	async ({ id, enabled }) => {
		await setCustomToolEnabled(getEnv(), id, enabled === 'true');
		redirect(303, '/settings');
	},
);

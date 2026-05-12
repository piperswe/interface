import { form, getRequestEvent } from '$app/server';
import { error, redirect } from '@sveltejs/kit';
import { z } from 'zod';
import {
	createCustomTool,
	deleteCustomTool,
	setCustomToolEnabled,
	updateCustomTool,
} from '$lib/server/custom_tools';
import {
	positiveIntFromString,
	trimmedNonEmpty,
} from '$lib/server/remote-schemas';

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
	z.object({
		name: trimmedNonEmpty('Name is required.'),
		description: trimmedNonEmpty('Description is required.'),
	}),
	async ({ name, description }) => {
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
	z.object({
		id: positiveIntFromString,
		name: trimmedNonEmpty('Name is required.'),
		description: trimmedNonEmpty('Description is required.'),
		source: z.string().refine((s) => s.trim().length > 0, 'Source is required.'),
		input_schema: trimmedNonEmpty('Input schema is required.'),
		secrets_json: z.string().optional().default(''),
	}),
	async ({ id, name, description, source, input_schema, secrets_json }) => {
		const secretsRaw = secrets_json.trim();
		try {
			await updateCustomTool(getEnv(), id, {
				name,
				description,
				source,
				inputSchema: input_schema,
				secretsJson: secretsRaw || null,
			});
		} catch (e) {
			error(400, e instanceof Error ? e.message : String(e));
		}
		redirect(303, `/settings/tools/${id}`);
	},
);

export const removeCustomTool = form(
	z.object({ id: positiveIntFromString }),
	async ({ id }) => {
		await deleteCustomTool(getEnv(), id);
		redirect(303, '/settings');
	},
);

export const toggleCustomTool = form(
	z.object({
		id: positiveIntFromString,
		enabled: z.string().optional(),
	}),
	async ({ id, enabled }) => {
		await setCustomToolEnabled(getEnv(), id, enabled === 'true');
		redirect(303, '/settings');
	},
);

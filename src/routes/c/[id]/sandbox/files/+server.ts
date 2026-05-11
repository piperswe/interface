import { error, json } from '@sveltejs/kit';
import { CONVERSATION_ID_PATTERN } from '$lib/conversation-id';
import type { RequestHandler } from './$types';

// Lists entries directly under `path` inside the conversation's workspace,
// reading from the R2 bucket the sandbox's /workspace mount is backed by.
// `path` is a /workspace-rooted absolute path (e.g. "/workspace" or
// "/workspace/foo"); R2 keys live under `conversations/{id}/...`, with the
// /workspace prefix stripped.
export const GET: RequestHandler = async ({ params, url, platform }) => {
	if (!platform) error(500, 'Cloudflare platform bindings unavailable');
	const conversationId = params.id;
	if (!CONVERSATION_ID_PATTERN.test(conversationId)) error(404, 'not found');

	const bucket = platform.env.WORKSPACE_BUCKET;
	if (!bucket) error(503, 'workspace bucket not configured');

	const path = url.searchParams.get('path') ?? '/workspace';
	if (path !== '/workspace' && !path.startsWith('/workspace/')) {
		error(400, 'invalid path');
	}
	// Defense-in-depth against `..` segments — R2 doesn't normalise paths
	// today, but a future backend swap could turn this into a cross-conversation
	// read primitive otherwise.
	if (path.split('/').includes('..')) error(400, 'invalid path');

	// "/workspace" -> "" ; "/workspace/foo/bar" -> "foo/bar/"
	const subPath = path.slice('/workspace'.length).replace(/^\//, '');
	const conversationPrefix = `conversations/${conversationId}/`;
	const listPrefix = subPath ? `${conversationPrefix}${subPath}/` : conversationPrefix;

	type FileNode = { path: string; type: 'file' | 'directory' };
	const out: FileNode[] = [];
	let cursor: string | undefined;
	do {
		const page = await bucket.list({
			prefix: listPrefix,
			delimiter: '/',
			cursor,
		});
		for (const sub of page.delimitedPrefixes ?? []) {
			// "conversations/{id}/foo/bar/" -> "/workspace/foo/bar"
			const rel = sub.slice(conversationPrefix.length).replace(/\/$/, '');
			out.push({ path: `/workspace/${rel}`, type: 'directory' });
		}
		for (const obj of page.objects) {
			const rel = obj.key.slice(conversationPrefix.length);
			// s3fs writes directory-marker objects whose keys end in "/";
			// those render as files with an empty name in the UI. Skip them.
			if (rel === '' || rel.endsWith('/')) continue;
			out.push({ path: `/workspace/${rel}`, type: 'file' });
		}
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);

	out.sort((a, b) => a.path.localeCompare(b.path));
	return json(out);
};

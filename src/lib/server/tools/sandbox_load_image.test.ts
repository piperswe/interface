import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { createSandboxLoadImageTool } from './sandbox';
import type { ProviderModel } from '../providers/types';
import type { ToolContext } from './registry';

const CONV_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const bucket = env.WORKSPACE_BUCKET!;

afterEach(async () => {
	const list = await bucket.list({ prefix: `conversations/${CONV_ID}/` });
	for (const obj of list.objects) {
		await bucket.delete(obj.key);
	}
});

function model(overrides: Partial<ProviderModel> = {}): ProviderModel {
	return {
		id: 'm1',
		providerId: 'p1',
		name: 'Test Model',
		description: null,
		maxContextLength: 128_000,
		reasoningType: null,
		inputCostPerMillionTokens: null,
		outputCostPerMillionTokens: null,
		supportsImageInput: false,
		sortOrder: 0,
		createdAt: 0,
		updatedAt: 0,
		...overrides,
	};
}

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
	return {
		env,
		conversationId: CONV_ID,
		assistantMessageId: 'a-1',
		modelId: 'p1/m1',
		...overrides,
	};
}

describe('sandbox_load_image tool', () => {
	it('exposes the documented definition shape', () => {
		const tool = createSandboxLoadImageTool({ getModels: () => [] });
		expect(tool.definition.name).toBe('sandbox_load_image');
		expect(tool.definition.description).toMatch(/multimodal|vision|image/i);
	});

	it('rejects missing path', async () => {
		const tool = createSandboxLoadImageTool({ getModels: () => [model({ supportsImageInput: true })] });
		const result = await tool.execute(ctx(), {});
		expect(result.isError).toBe(true);
		expect(result.errorCode).toBe('invalid_input');
	});

	it('rejects paths outside /workspace/', async () => {
		const tool = createSandboxLoadImageTool({ getModels: () => [model({ supportsImageInput: true })] });
		const result = await tool.execute(ctx(), { path: '/etc/passwd' });
		expect(result.isError).toBe(true);
		expect(result.errorCode).toBe('invalid_input');
	});

	// Regression: defense-in-depth — even though R2 keys are opaque flat
	// strings today, reject `..` segments so the surface isn't fragile under
	// any backend that normalises path components.
	it('rejects paths containing `..` segments', async () => {
		const tool = createSandboxLoadImageTool({ getModels: () => [model({ supportsImageInput: true })] });
		const a = await tool.execute(ctx(), { path: '/workspace/../etc/passwd.png' });
		expect(a.isError).toBe(true);
		expect(a.errorCode).toBe('invalid_input');
		const b = await tool.execute(ctx(), { path: '/workspace/foo/../../bar.png' });
		expect(b.isError).toBe(true);
		expect(b.errorCode).toBe('invalid_input');
	});

	// Regression: `.webp` was historically mapped to `image/jpeg` in the
	// raw-passthrough branch (no IMAGES binding). Vision providers reject
	// the request when bytes don't match the declared MIME, so WEBP uploads
	// silently failed. The map must use `image/webp` so the raw bytes ship
	// with the correct content-type.
	it('returns image/webp for .webp files when no IMAGES binding is configured', async () => {
		const tool = createSandboxLoadImageTool({
			getModels: () => [model({ supportsImageInput: true })],
		});
		const bytes = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]); // 'RIFF....WEBP'
		await bucket.put(`conversations/${CONV_ID}/uploads/icon.webp`, bytes);
		const result = await tool.execute(ctx(), { path: '/workspace/uploads/icon.webp' });
		expect(result.isError).toBeFalsy();
		const blocks = result.content as Array<{ type: string; mimeType?: string }>;
		const img = blocks.find((b) => b.type === 'image');
		expect(img).toBeDefined();
		expect(img!.mimeType).toBe('image/webp');
	});

	it('rejects unsupported file extensions', async () => {
		const tool = createSandboxLoadImageTool({ getModels: () => [model({ supportsImageInput: true })] });
		const result = await tool.execute(ctx(), { path: '/workspace/note.pdf' });
		expect(result.isError).toBe(true);
		expect(result.errorCode).toBe('invalid_input');
		expect(result.content).toMatch(/sandbox_read_file|sandbox_exec/);
	});

	it('returns 404 errorCode when the R2 object is missing', async () => {
		const tool = createSandboxLoadImageTool({ getModels: () => [model({ supportsImageInput: true })] });
		const result = await tool.execute(ctx(), { path: '/workspace/missing.png' });
		expect(result.isError).toBe(true);
		expect(result.errorCode).toBe('not_found');
	});

	it('returns text fallback when the model does not support image input', async () => {
		const tool = createSandboxLoadImageTool({
			getModels: () => [model({ supportsImageInput: false })],
		});
		// Place a real file so the size-cap check passes and we reach the gate.
		await bucket.put(`conversations/${CONV_ID}/uploads/photo.png`, new Uint8Array([1, 2, 3]));
		const result = await tool.execute(ctx(), { path: '/workspace/uploads/photo.png' });
		expect(result.isError).toBeFalsy();
		expect(typeof result.content).toBe('string');
		expect(result.content as string).toMatch(/does not accept image input/);
		expect(result.content as string).toMatch(/sandbox_read_file|sandbox_exec/);
	});

	it('returns image content array for vision models', async () => {
		const tool = createSandboxLoadImageTool({
			getModels: () => [model({ supportsImageInput: true })],
		});
		const bytes = new Uint8Array([1, 2, 3, 4, 5]);
		await bucket.put(`conversations/${CONV_ID}/uploads/photo.png`, bytes);
		const result = await tool.execute(ctx(), { path: '/workspace/uploads/photo.png' });
		expect(result.isError).toBeFalsy();
		expect(Array.isArray(result.content)).toBe(true);
		const blocks = result.content as Array<{ type: 'text'; text: string } | { type: 'image'; mimeType: string; data: string }>;
		expect(blocks).toHaveLength(2);
		expect(blocks[0]).toMatchObject({ type: 'text' });
		expect((blocks[0] as { type: 'text'; text: string }).text).toMatch(/photo\.png/);
		expect(blocks[1]).toMatchObject({ type: 'image', mimeType: 'image/png' });
		const data = (blocks[1] as { type: 'image'; data: string }).data;
		// btoa of [1,2,3,4,5] -> 'AQIDBAU='
		expect(data).toBe('AQIDBAU=');
	});

	it('returns a text guidance error when the file exceeds the 3.5MB cap and no IMAGES binding', async () => {
		const tool = createSandboxLoadImageTool({
			getModels: () => [model({ supportsImageInput: true })],
		});
		const bytes = new Uint8Array(6 * 1024 * 1024);
		await bucket.put(`conversations/${CONV_ID}/uploads/big.png`, bytes);
		// ctx() uses env which has no IMAGES binding — must fall back to error
		const result = await tool.execute(ctx(), { path: '/workspace/uploads/big.png' });
		expect(result.isError).toBe(true);
		expect(typeof result.content).toBe('string');
		expect(result.content as string).toMatch(/too large/);
	});

	it('resizes via IMAGES binding instead of erroring when file exceeds the 3.5MB cap', async () => {
		// Regression: large images should be fed through Cloudflare Image Resizing
		// rather than returning a "too large" error when the IMAGES binding is present.
		const fakeResizedBytes = new Uint8Array([0x01, 0x02, 0x03]);
		const mockImages: ImagesBinding = {
			input(_stream) {
				return {
					transform() { return this; },
					draw() { return this; },
					output() {
						return Promise.resolve({
							response: () => new Response(fakeResizedBytes),
						// eslint-disable-next-line @typescript-eslint/no-explicit-any
						} as any);
					},
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				} as any;
			},
			info: () => Promise.resolve({ format: 'image/jpeg', fileSize: fakeResizedBytes.length, width: 100, height: 100 }),
			hosted: {} as ImagesBinding['hosted'],
		};

		const tool = createSandboxLoadImageTool({ getModels: () => [model({ supportsImageInput: true })] });
		const bigBytes = new Uint8Array(6 * 1024 * 1024);
		await bucket.put(`conversations/${CONV_ID}/uploads/big.png`, bigBytes);
		const result = await tool.execute(ctx({ env: { ...env, IMAGES: mockImages } }), {
			path: '/workspace/uploads/big.png',
		});
		expect(result.isError).toBeFalsy();
		const blocks = result.content as Array<{ type: string; mimeType?: string; data?: string }>;
		expect(Array.isArray(blocks)).toBe(true);
		const imageBlock = blocks.find((b) => b.type === 'image');
		expect(imageBlock).toBeDefined();
		expect(imageBlock!.mimeType).toBe('image/jpeg');
		const expectedBase64 = btoa(String.fromCharCode(...fakeResizedBytes));
		expect(imageBlock!.data).toBe(expectedBase64);
	});

	it('resizes via IMAGES binding and returns image/jpeg when binding is present', async () => {
		// Regression: large images stored as raw base64 in the parts TEXT column
		// hit the DO SQLite 2 MB per-value limit (SQLITE_TOOBIG). When the IMAGES
		// binding is configured the tool must resize and re-encode as JPEG.
		const fakeWebPBytes = new Uint8Array([0x52, 0x49, 0x46, 0x46]); // 'RIFF' prefix
		const mockImages: ImagesBinding = {
			input(_stream) {
				return {
					transform() { return this; },
					draw() { return this; },
					output() {
						return Promise.resolve({
							response: () => new Response(fakeWebPBytes),
						// eslint-disable-next-line @typescript-eslint/no-explicit-any
						} as any);
					},
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				} as any;
			},
			info: () => Promise.resolve({ format: 'image/webp', fileSize: fakeWebPBytes.length, width: 4, height: 1 }),
			hosted: {} as ImagesBinding['hosted'],
		};

		const tool = createSandboxLoadImageTool({ getModels: () => [model({ supportsImageInput: true })] });
		await bucket.put(`conversations/${CONV_ID}/uploads/photo.png`, new Uint8Array([1, 2, 3, 4, 5]));
		const result = await tool.execute(ctx({ env: { ...env, IMAGES: mockImages } }), {
			path: '/workspace/uploads/photo.png',
		});
		expect(result.isError).toBeFalsy();
		const blocks = result.content as Array<{ type: string; mimeType?: string; data?: string }>;
		expect(Array.isArray(blocks)).toBe(true);
		const imageBlock = blocks.find((b) => b.type === 'image');
		expect(imageBlock).toBeDefined();
		expect(imageBlock!.mimeType).toBe('image/jpeg');
		// Verify it's the resized bytes, not the raw upload
		const expectedBase64 = btoa(String.fromCharCode(...fakeWebPBytes));
		expect(imageBlock!.data).toBe(expectedBase64);
	});

	it('surfaces the IMAGES binding error instead of advising sandbox_exec', async () => {
		// Regression: previously the catch block returned a "too large, use sandbox_exec"
		// error whenever IMAGES.transform threw, which misled agents into pre-resizing
		// via convert when the binding was actually misconfigured/throwing.
		const failingImages: ImagesBinding = {
			input(_stream) {
				return {
					transform() { return this; },
					draw() { return this; },
					output() {
						return Promise.reject(new Error('IMAGES_TRANSFORM_ERROR 9402: simulated'));
					},
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				} as any;
			},
			info: () => Promise.resolve({ format: 'image/jpeg', fileSize: 0, width: 0, height: 0 }),
			hosted: {} as ImagesBinding['hosted'],
		};
		const tool = createSandboxLoadImageTool({ getModels: () => [model({ supportsImageInput: true })] });
		await bucket.put(`conversations/${CONV_ID}/uploads/big.jpeg`, new Uint8Array(6 * 1024 * 1024));
		const result = await tool.execute(ctx({ env: { ...env, IMAGES: failingImages } }), {
			path: '/workspace/uploads/big.jpeg',
		});
		expect(result.isError).toBe(true);
		expect(typeof result.content).toBe('string');
		expect(result.content as string).toMatch(/9402|simulated/);
		expect(result.content as string).not.toMatch(/sandbox_exec/);
		expect(result.content as string).not.toMatch(/convert .*-resize/);
	});

	it('uses the live (post-switch) model from ctx.modelId', async () => {
		const tool = createSandboxLoadImageTool({
			getModels: () => [model({ id: 'no-vision', supportsImageInput: false }), model({ id: 'has-vision', supportsImageInput: true })],
		});
		await bucket.put(`conversations/${CONV_ID}/uploads/photo.png`, new Uint8Array([1, 2, 3]));
		const noVisionResult = await tool.execute(ctx({ modelId: 'p1/no-vision' }), {
			path: '/workspace/uploads/photo.png',
		});
		expect(typeof noVisionResult.content).toBe('string');
		const hasVisionResult = await tool.execute(ctx({ modelId: 'p1/has-vision' }), {
			path: '/workspace/uploads/photo.png',
		});
		expect(Array.isArray(hasVisionResult.content)).toBe(true);
	});
});

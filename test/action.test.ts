import type { INodeExecutionData } from 'n8n-workflow';
import { NodeApiError } from 'n8n-workflow';

import { Transglot } from '../nodes/Transglot/Transglot.node';
import { buildPushRequestOptions } from '../nodes/shared/GenericFunctions';

// No `/api` segment: the API applies its own `v1` prefix (see GenericFunctions).
const BASE_URL = 'https://api.example.com';

describe('buildPushRequestOptions', () => {
	const buffer = Buffer.from('{"greeting":"hello"}');

	it('POSTs multipart/form-data to /v1/push with file, format and locale', () => {
		const opts = buildPushRequestOptions(BASE_URL, {
			buffer,
			fileName: 'en.json',
			format: 'json_nested',
			locale: 'en',
			syncRemovals: false,
			mimeType: 'application/json',
		});

		expect(opts.method).toBe('POST');
		expect(opts.url).toBe(`${BASE_URL}/v1/push`);
		// The body is FormData, never JSON: json:false stops n8n serializing it, and
		// the multipart boundary is written by the HTTP layer (mirrors the CLI).
		expect(opts.json).toBe(false);
		expect(opts.body).toBeInstanceOf(FormData);

		const form = opts.body as FormData;
		expect(form.get('format')).toBe('json_nested');
		expect(form.get('locale')).toBe('en');
		expect(form.get('mode')).toBeNull();

		const file = form.get('file') as File;
		expect(file).toBeInstanceOf(File);
		expect(file.name).toBe('en.json');
		expect(file.type).toBe('application/json');
	});

	it('adds mode=sync_removals only when syncRemovals is set', () => {
		const opts = buildPushRequestOptions(BASE_URL, {
			buffer,
			fileName: 'fr.json',
			format: 'json_flat',
			locale: 'fr',
			syncRemovals: true,
		});

		expect((opts.body as FormData).get('mode')).toBe('sync_removals');
	});

	it('trims a trailing slash on baseUrl so the URL never doubles up', () => {
		const opts = buildPushRequestOptions('https://api.example.com/', {
			buffer,
			fileName: 'de.yaml',
			format: 'yaml',
			locale: 'de',
			syncRemovals: false,
		});

		expect(opts.url).toBe('https://api.example.com/v1/push');
	});

	it('falls back to application/octet-stream when no mimeType is given', () => {
		const opts = buildPushRequestOptions(BASE_URL, {
			buffer,
			fileName: 'x',
			format: 'yaml',
			locale: 'de',
			syncRemovals: false,
		});

		expect((opts.body as FormData).get('file') as File).toHaveProperty(
			'type',
			'application/octet-stream',
		);
	});
});

interface PushItemSpec {
	resource?: string;
	operation?: string;
	binaryPropertyName?: string;
	format?: string;
	locale?: string;
	minState?: string;
	pushOptions?: Record<string, unknown>;
	binary: { fileName?: string; mimeType?: string; buffer: Buffer };
}

describe('Pull response format', () => {
	it('requests text explicitly so JSON files remain downloadable text with a parsed preview', async () => {
		const content = '{ "welcome": "Bon retour" }\n';
		const { ctx, http } = makeExecuteContext({
			items: [{ resource: 'project', operation: 'pull', format: 'json', locale: 'fr', binary: { buffer: Buffer.alloc(0) } }],
			httpResponse: content,
		});
		const result = await new Transglot().execute.call(ctx as any);
		expect(http.mock.calls[0][1]).toMatchObject({ method: 'GET', encoding: 'text', json: false });
		expect(result[0][0].json).toMatchObject({ content, parsed: { welcome: 'Bon retour' } });
	});
});

function makeExecuteContext(opts: {
	items: PushItemSpec[];
	httpImpl?: (name: string, requestOptions: any) => Promise<unknown>;
	httpResponse?: unknown;
	continueOnFail?: boolean;
}) {
	const http = opts.httpImpl
		? jest.fn(opts.httpImpl)
		: jest.fn().mockResolvedValue(opts.httpResponse);

	const ctx = {
		getInputData: () => opts.items.map(() => ({ json: {}, binary: { data: {} } })),
		getNodeParameter: jest.fn((name: string, i: number, fallback?: unknown) => {
			const spec = opts.items[i] as unknown as Record<string, unknown>;
			const defaults: Record<string, unknown> = {
				resource: 'project',
				operation: 'push',
				binaryPropertyName: 'data',
			};
			if (name in spec && spec[name] !== undefined) {
				return spec[name];
			}
			if (name in defaults) {
				return defaults[name];
			}
			return fallback;
		}),
		getNode: () => ({ name: 'transglot', type: 'transglot', typeVersion: 1 }),
		continueOnFail: () => opts.continueOnFail ?? false,
		getCredentials: jest.fn().mockResolvedValue({ baseUrl: BASE_URL, apiToken: 'tgl_secret' }),
		helpers: {
			assertBinaryData: (i: number, _name: string) => {
				const b = opts.items[i].binary;
				return { fileName: b.fileName, mimeType: b.mimeType ?? 'application/octet-stream', data: '' };
			},
			getBinaryDataBuffer: async (i: number, _name: string) => opts.items[i].binary.buffer,
			httpRequestWithAuthentication: http,
			returnJsonArray: (data: any) =>
				(Array.isArray(data) ? data : [data]).map((json: any) => ({ json })),
			constructExecutionMetaData: (data: INodeExecutionData[], _meta: any) => data,
		},
	};

	return { ctx, http };
}

const DIFF = {
	keys_created: 3,
	keys_deleted: 0,
	source_updated: 1,
	translations_written: 0,
	conflicts: [],
	unknown_keys: [],
	warnings: [],
	batch: null,
	quota_exceeded: false,
};

describe('Transglot project:push', () => {
	const node = new Transglot();

    it('preserves HTTP context when reporting an API failure in n8n', async () => {
        const { ctx } = makeExecuteContext({
            items: [{ resource: 'project', operation: 'get', binary: { buffer: Buffer.alloc(0) } }],
            httpImpl: async () => { throw { message: 'Unauthorized', statusCode: 401 }; },
        });
        await expect(node.execute.call(ctx as any)).rejects.toBeInstanceOf(NodeApiError);
    });

    it('links a continued failure to its original input item', async () => {
        const { ctx } = makeExecuteContext({
            items: [{ resource: 'project', operation: 'get', binary: { buffer: Buffer.alloc(0) } }],
            continueOnFail: true,
            httpImpl: async () => { throw new Error('Unavailable'); },
        });
        await expect(node.execute.call(ctx as any)).resolves.toEqual([[{
            json: { error: 'Unavailable' }, pairedItem: { item: 0 },
        }]]);
    });

	it('uploads the binary as multipart and returns the diff', async () => {
		const { ctx, http } = makeExecuteContext({
			items: [
				{
					locale: 'en',
					format: 'json_nested',
					binary: { fileName: 'en.json', mimeType: 'application/json', buffer: Buffer.from('{"a":"b"}') },
				},
			],
			httpResponse: DIFF,
		});

		const result = await node.execute.call(ctx as any);

		expect(http).toHaveBeenCalledTimes(1);
		const [credName, requestOptions] = http.mock.calls[0];
		expect(credName).toBe('transglotApi');
		expect(requestOptions.method).toBe('POST');
		expect(requestOptions.url).toBe(`${BASE_URL}/v1/push`);

		const form = requestOptions.body as FormData;
		expect(form.get('format')).toBe('json_nested');
		expect(form.get('locale')).toBe('en');
		expect((form.get('file') as File).name).toBe('en.json');

		expect(result).toEqual([[{ json: DIFF }]]);
	});

	it('sends mode=sync_removals when the option is enabled', async () => {
		const { ctx, http } = makeExecuteContext({
			items: [
				{
					locale: 'fr',
					format: 'json_flat',
					pushOptions: { syncRemovals: true },
					binary: { fileName: 'fr.json', mimeType: 'application/json', buffer: Buffer.from('{}') },
				},
			],
			httpResponse: DIFF,
		});

		await node.execute.call(ctx as any);

		const form = http.mock.calls[0][1].body as FormData;
		expect(form.get('mode')).toBe('sync_removals');
	});

	it('expands a {locale} placeholder in the File Name override', async () => {
		const { ctx, http } = makeExecuteContext({
			items: [
				{
					locale: 'pt-BR',
					format: 'json_nested',
					pushOptions: { fileName: 'strings.{locale}.json' },
					binary: { fileName: 'ignored.json', mimeType: 'application/json', buffer: Buffer.from('{}') },
				},
			],
			httpResponse: DIFF,
		});

		await node.execute.call(ctx as any);

		const form = http.mock.calls[0][1].body as FormData;
		expect((form.get('file') as File).name).toBe('strings.pt-BR.json');
	});

	it('throws the {locale}-collision guard when one file is pushed for two locales', async () => {
		const { ctx, http } = makeExecuteContext({
			items: [
				{
					locale: 'en',
					format: 'json_nested',
					binary: { fileName: 'strings.json', mimeType: 'application/json', buffer: Buffer.from('a') },
				},
				{
					locale: 'fr',
					format: 'json_nested',
					binary: { fileName: 'strings.json', mimeType: 'application/json', buffer: Buffer.from('b') },
				},
			],
			httpResponse: DIFF,
		});

		await expect(node.execute.call(ctx as any)).rejects.toThrow(/pushed for both en and fr/);
		// The first, legitimate upload happened; the duplicate second one was blocked.
		expect(http).toHaveBeenCalledTimes(1);
	});

	it('captures the collision as a per-item error under continueOnFail', async () => {
		const { ctx } = makeExecuteContext({
			items: [
				{
					locale: 'en',
					format: 'json_nested',
					binary: { fileName: 'strings.json', mimeType: 'application/json', buffer: Buffer.from('a') },
				},
				{
					locale: 'fr',
					format: 'json_nested',
					binary: { fileName: 'strings.json', mimeType: 'application/json', buffer: Buffer.from('b') },
				},
			],
			httpResponse: DIFF,
			continueOnFail: true,
		});

		const result = await node.execute.call(ctx as any);
		const flat = result[0];
		expect(flat).toHaveLength(2);
		expect(flat[0].json).toEqual(DIFF);
		expect((flat[1].json as { error: string }).error).toMatch(/pushed for both en and fr/);
	});
});

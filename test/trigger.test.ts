import { createHmac } from 'crypto';
import { TransglotTrigger } from '../nodes/TransglotTrigger/TransglotTrigger.node';
import { buildRequestOptions } from '../nodes/shared/GenericFunctions';

// No `/api` segment: the API moved to its own host and routes/api.php applies its own
// `v1` prefix, so `/api/v1/...` 404s. #105 updated the expectations below to `/v1/...`
// but left this fixture (and the credential defaults) carrying `/api`, which is what
// made `strips a trailing slash` fail — the input and the expectation disagreed.
const BASE_URL = 'https://api.example.com';
const WEBHOOK_URL = 'https://n8n.example.com/webhook/abc-123';

/**
 * Build a fake IHookFunctions-ish `this` whose httpRequestWithAuthentication is a jest
 * mock, so we can assert on the exact request the hook methods build. `staticData` is a
 * live object shared across the returned context (mirrors n8n's per-node static data).
 */
function makeHookContext(options: {
	staticData?: Record<string, unknown>;
	event?: string;
	httpResponse?: unknown;
	httpImpl?: (name: string, requestOptions: any) => Promise<unknown>;
}) {
	const staticData = options.staticData ?? {};
	const httpRequestWithAuthentication = options.httpImpl
		? jest.fn(options.httpImpl)
		: jest.fn().mockResolvedValue(options.httpResponse);

	const ctx = {
		getNode: jest.fn().mockReturnValue({ name: 'Transglot Trigger', type: 'transglotTrigger', typeVersion: 1, position: [0, 0], parameters: {} }),
		getCredentials: jest.fn().mockResolvedValue({ baseUrl: BASE_URL, apiToken: 'tgl_secret' }),
		getNodeWebhookUrl: jest.fn().mockReturnValue(WEBHOOK_URL),
		getNodeParameter: jest.fn().mockReturnValue(options.event ?? 'batch.completed'),
		getWorkflowStaticData: jest.fn().mockReturnValue(staticData),
		helpers: {
			httpRequestWithAuthentication,
			returnJsonArray: (data: any) =>
				(Array.isArray(data) ? data : [data]).map((json: any) => ({ json })),
		},
	};

	return { ctx, staticData, httpRequestWithAuthentication };
}

describe('buildRequestOptions', () => {
	it('joins baseUrl + resource and defaults to JSON', () => {
		const opts = buildRequestOptions(BASE_URL, 'GET', '/v1/project');
		expect(opts).toEqual({ method: 'GET', url: `${BASE_URL}/v1/project`, json: true });
	});

	it('strips a trailing slash on baseUrl so the URL never doubles up', () => {
		const opts = buildRequestOptions('https://api.example.com/', 'GET', '/v1/webhooks');
		expect(opts.url).toBe('https://api.example.com/v1/webhooks');
	});

	it('keeps a sub-path in baseUrl, trimming only the trailing slash', () => {
		// A self-hosted install can sit under a prefix. The join must not eat it —
		// this is the case whose input and expectation disagreed after #105.
		expect(buildRequestOptions('https://self.example.com/transglot/', 'GET', '/v1/project').url).toBe(
			'https://self.example.com/transglot/v1/project',
		);
	});

	it('includes body only when non-empty', () => {
		expect(buildRequestOptions(BASE_URL, 'POST', '/v1/webhooks', {}).body).toBeUndefined();
		expect(
			buildRequestOptions(BASE_URL, 'POST', '/v1/webhooks', { url: WEBHOOK_URL }).body,
		).toEqual({ url: WEBHOOK_URL });
	});

	it('carries a query string only when non-empty', () => {
		expect(buildRequestOptions(BASE_URL, 'GET', '/v1/pull', undefined, {}).qs).toBeUndefined();
		expect(
			buildRequestOptions(BASE_URL, 'GET', '/v1/pull', undefined, { locale: 'fr' }).qs,
		).toEqual({ locale: 'fr' });
	});
});

describe('TransglotTrigger webhook lifecycle', () => {
	const node = new TransglotTrigger();

	it('create → POST /v1/webhooks with {url, events:[event]} and stores the id', async () => {
		const { ctx, staticData, httpRequestWithAuthentication } = makeHookContext({
			event: 'batch.completed',
			httpResponse: { id: 42, url: WEBHOOK_URL, events: ['batch.completed'], active: true, secret: 'whsec_fixture_only' },
		});

		const result = await node.webhookMethods.default.create.call(ctx as any);

		expect(result).toBe(true);
		expect(httpRequestWithAuthentication).toHaveBeenCalledTimes(1);
		const [credName, requestOptions] = httpRequestWithAuthentication.mock.calls[0];
		expect(credName).toBe('transglotApi');
		expect(requestOptions).toMatchObject({
			method: 'POST',
			url: `${BASE_URL}/v1/webhooks`,
			body: { url: WEBHOOK_URL, events: ['batch.completed'] },
			json: true,
		});
		// The returned subscription id is persisted for delete().
		expect(staticData.webhookId).toBe(42);
		expect(staticData.webhookSecret).toBe('whsec_fixture_only');
	});

	it('delete → DELETE /v1/webhooks/{id} and clears the stored id', async () => {
		const { ctx, staticData, httpRequestWithAuthentication } = makeHookContext({
			staticData: { webhookId: 42, webhookSecret: 'whsec_fixture_only' },
			httpResponse: undefined,
		});

		const result = await node.webhookMethods.default.delete.call(ctx as any);

		expect(result).toBe(true);
		const [, requestOptions] = httpRequestWithAuthentication.mock.calls[0];
		expect(requestOptions).toMatchObject({
			method: 'DELETE',
			url: `${BASE_URL}/v1/webhooks/42`,
		});
		expect(staticData.webhookId).toBeUndefined();
		expect(staticData.webhookSecret).toBeUndefined();
	});

	it('delete is a no-op when nothing was subscribed', async () => {
		const { ctx, httpRequestWithAuthentication } = makeHookContext({ staticData: {} });

		const result = await node.webhookMethods.default.delete.call(ctx as any);

		expect(result).toBe(true);
		expect(httpRequestWithAuthentication).not.toHaveBeenCalled();
	});

	it('checkExists matches the current webhook URL and records the id', async () => {
		const { ctx, staticData } = makeHookContext({
			staticData: { webhookId: 99, webhookSecret: 'whsec_fixture_only' },
			httpResponse: {
				data: [
					{ id: 7, url: 'https://other/webhook/x' },
					{ id: 99, url: WEBHOOK_URL, events: ['batch.completed'] },
				],
			},
		});

		const exists = await node.webhookMethods.default.checkExists.call(ctx as any);

		expect(exists).toBe(true);
		expect(staticData.webhookId).toBe(99);
	});

	it('checkExists returns false when no subscription matches', async () => {
		const { ctx } = makeHookContext({
			httpResponse: { data: [{ id: 7, url: 'https://other/webhook/x' }] },
		});

		expect(await node.webhookMethods.default.checkExists.call(ctx as any)).toBe(false);
	});

	it('replaces a legacy subscription without its reveal-once secret before activation', async () => {
		const { ctx, staticData, httpRequestWithAuthentication } = makeHookContext({
			staticData: { webhookId: 99 },
			httpImpl: async (_name, options) => {
				if (options.method === 'GET') return { data: [{ id: 99, url: WEBHOOK_URL, events: ['batch.completed'] }] };
				if (options.method === 'POST') return { id: 100, secret: 'whsec_new_fixture' };
				return undefined;
			},
		});
		expect(await node.webhookMethods.default.checkExists.call(ctx as any)).toBe(false);
		expect(await node.webhookMethods.default.create.call(ctx as any)).toBe(true);
		expect(httpRequestWithAuthentication.mock.calls.map((call) => call[1].method)).toEqual(['GET', 'DELETE', 'POST']);
		expect(staticData).toEqual({ webhookId: 100, webhookSecret: 'whsec_new_fixture' });
	});

	it('does not pair a secret with a different subscription ID', async () => {
		const { ctx, staticData } = makeHookContext({
			staticData: { webhookId: 98, webhookSecret: 'whsec_other_subscription' },
			httpResponse: { data: [{ id: 99, url: WEBHOOK_URL, events: ['batch.completed'] }] },
		});
		expect(await node.webhookMethods.default.checkExists.call(ctx as any)).toBe(false);
		expect(staticData.webhookSecret).toBeUndefined();
	});

	it('recreates a subscription if the selected event changed', async () => {
		const { ctx } = makeHookContext({
			staticData: { webhookId: 99, webhookSecret: 'whsec_fixture' },
			event: 'batch.failed',
			httpResponse: { data: [{ id: 99, url: WEBHOOK_URL, events: ['batch.completed'] }] },
		});
		expect(await node.webhookMethods.default.checkExists.call(ctx as any)).toBe(false);
	});

	it('removes a newly created subscription that lacks a signing secret and fails activation', async () => {
		const { ctx, staticData, httpRequestWithAuthentication } = makeHookContext({ httpResponse: { id: 42 } });
		await expect(node.webhookMethods.default.create.call(ctx as any)).rejects.toThrow('signing secret');
		expect(httpRequestWithAuthentication.mock.calls[1][1]).toMatchObject({ method: 'DELETE', url: BASE_URL + '/v1/webhooks/42' });
		expect(staticData.webhookId).toBeUndefined();
		expect(staticData.webhookSecret).toBeUndefined();
	});

	it('treats an already removed subscription as deleted and clears its secret', async () => {
		const { ctx, staticData } = makeHookContext({
			staticData: { webhookId: 42, webhookSecret: 'whsec_fixture' },
			httpImpl: async () => { throw { httpCode: '404' }; },
		});
		expect(await node.webhookMethods.default.delete.call(ctx as any)).toBe(true);
		expect(staticData).toEqual({});
	});
});

describe('TransglotTrigger loadOptions.getEvents', () => {
	const node = new TransglotTrigger();

	it('maps the catalog into option {name,value,description}', async () => {
		const { ctx } = makeHookContext({
			httpResponse: {
				data: [
					{
						event: 'batch.completed',
						label: 'Batch completed',
						description: 'A batch finished',
					},
				],
			},
		});

		const options = await node.methods.loadOptions.getEvents.call(ctx as any);

		expect(options).toEqual([
			{ name: 'Batch completed', value: 'batch.completed', description: 'A batch finished' },
		]);
	});

	it('falls back to the known event set when the catalog is empty', async () => {
		const { ctx } = makeHookContext({ httpResponse: { data: [] } });

		const options = await node.methods.loadOptions.getEvents.call(ctx as any);

		expect(options.length).toBeGreaterThan(0);
		expect(options.map((o) => o.value)).toContain('source_drift.repaired');
	});
});

describe('TransglotTrigger webhook()', () => {
	const node = new TransglotTrigger();

	it('emits the delivered POST body verbatim as workflow data', async () => {
		const body = {
			event: 'batch.completed',
			delivered_at: '2026-07-08T09:41:00+00:00',
			project: { id: 12, slug: 'acme-web' },
			batch: { id: 4821, status: 'completed' },
		};

		const rawBody = Buffer.from(JSON.stringify(body, null, 2));
		const timestamp = String(Math.floor(Date.now() / 1000));
		const signature = 'sha256=' + createHmac('sha256', 'whsec_fixture_only').update(timestamp + '.').update(rawBody).digest('hex');
		const ctx = {
			getBodyData: jest.fn().mockReturnValue(body),
			getHeaderData: () => ({ 'x-transglot-timestamp': timestamp, 'x-transglot-signature': signature }),
			getWorkflowStaticData: () => ({ webhookSecret: 'whsec_fixture_only' }),
			getRequestObject: () => ({ rawBody }),
			getNodeParameter: () => 'batch.completed',
			helpers: {
				returnJsonArray: (data: any) =>
					(Array.isArray(data) ? data : [data]).map((json: any) => ({ json })),
			},
		};

		const result = await node.webhook.call(ctx as any);

		expect(result).toEqual({ workflowData: [[{ json: body }]] });
	});
});

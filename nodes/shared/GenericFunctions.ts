import type {
	IDataObject,
	IExecuteFunctions,
	IHookFunctions,
	IHttpRequestMethods,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	IWebhookFunctions,
} from 'n8n-workflow';

export const CREDENTIALS_NAME = 'transglotApi';

type TransglotFunctions =
	| IExecuteFunctions
	| IHookFunctions
	| ILoadOptionsFunctions
	| IWebhookFunctions;

/**
 * Build the request options for a transglot API call.
 *
 * Kept as a pure function (no `this`) so it is unit-testable and so the hook methods
 * that must assert on the exact request object can inspect it directly. `resource` is
 * a path under the API root, e.g. `/v1/webhooks`, so the final URL is
 * `{baseUrl}{resource}`. `baseUrl` no longer carries an `/api` segment: the API moved
 * to its own host and `routes/api.php` applies its own `v1` prefix, so `/api/v1/...`
 * 404s. Only a trailing slash is trimmed — whatever path the user configured is kept.
 */
export function buildRequestOptions(
	baseUrl: string,
	method: IHttpRequestMethods,
	resource: string,
	body?: IDataObject,
	qs?: IDataObject,
	overrides: Partial<IHttpRequestOptions> = {},
): IHttpRequestOptions {
	const options: IHttpRequestOptions = {
		method,
		url: `${baseUrl.replace(/\/+$/, '')}${resource}`,
		json: true,
		...overrides,
	};

	if (body !== undefined && Object.keys(body).length > 0) {
		options.body = body;
	}
	if (qs !== undefined && Object.keys(qs).length > 0) {
		options.qs = qs;
	}

	return options;
}

/**
 * Make an authenticated request to the transglot API. The credential's generic
 * bearer `authenticate` block injects the Authorization header; here we only supply the
 * base URL (read from the same credential) and the path/verb/body.
 */
export async function transglotApiRequest(
	this: TransglotFunctions,
	method: IHttpRequestMethods,
	resource: string,
	body?: IDataObject,
	qs?: IDataObject,
	overrides: Partial<IHttpRequestOptions> = {},
): Promise<unknown> {
	const credentials = await this.getCredentials(CREDENTIALS_NAME);
	const options = buildRequestOptions(
		credentials.baseUrl as string,
		method,
		resource,
		body,
		qs,
		overrides,
	);

	return this.helpers.httpRequestWithAuthentication.call(this, CREDENTIALS_NAME, options);
}

/** A source file to upload to `POST /v1/push`, mirroring the CLI push contract. */
export interface PushUpload {
	buffer: Buffer;
	fileName: string;
	format: string;
	locale: string;
	syncRemovals: boolean;
	mimeType?: string;
}

/**
 * Build the request options for `POST /v1/push`.
 *
 * The push endpoint is `multipart/form-data` (it uploads one source file), so the body
 * is a `FormData` carrying the same fields the CLI sends: `file` (the bytes + filename),
 * `format`, `locale`, and `mode=sync_removals` only when removals should be synced.
 *
 * Two deliberate choices mirror the CLI:
 *   - `json: false` so the HTTP layer never JSON-serialises the FormData body.
 *   - no `Content-Type` header: the multipart boundary is written by the HTTP layer
 *     itself; setting it by hand would omit the boundary and corrupt the upload.
 */
export function buildPushRequestOptions(baseUrl: string, upload: PushUpload): IHttpRequestOptions {
	const form = new FormData();
	form.set(
		'file',
		new Blob([upload.buffer], { type: upload.mimeType ?? 'application/octet-stream' }),
		upload.fileName,
	);
	form.set('format', upload.format);
	form.set('locale', upload.locale);
	if (upload.syncRemovals) {
		form.set('mode', 'sync_removals');
	}

	return {
		method: 'POST',
		url: `${baseUrl.replace(/\/+$/, '')}/v1/push`,
		body: form,
		json: false,
	};
}

/**
 * Upload a source file to `POST /v1/push` with the deploy-token credential. Returns the
 * push diff. The credential's bearer `authenticate` block injects the Authorization
 * header, so here we only build the multipart request and send it.
 */
export async function transglotPushRequest(
	this: IExecuteFunctions,
	upload: PushUpload,
): Promise<unknown> {
	const credentials = await this.getCredentials(CREDENTIALS_NAME);
	const options = buildPushRequestOptions(credentials.baseUrl as string, upload);

	return this.helpers.httpRequestWithAuthentication.call(this, CREDENTIALS_NAME, options);
}

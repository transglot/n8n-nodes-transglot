import type {
	IDataObject,
    JsonObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import { transglotApiRequest, transglotPushRequest } from '../shared/GenericFunctions';

const TEXT_RESPONSE_OPTIONS = { json: false, encoding: 'text' as const };

/**
 * transglot action node.
 *
 * Talks to the deploy-token API ({baseUrl}/v1/...). The token IS the project, so no
 * node ever asks for a project id. Operations:
 *   - Project › Get        → GET  /v1/project
 *   - Project › Push Source → POST /v1/push        (multipart upload of one source file)
 *   - Project › Translate  → POST /v1/translate    (202, returns the batch handle)
 *   - Project › Pull       → GET  /v1/pull         (serialized locale file)
 *   - Batch   › Get        → GET  /v1/batches/{id}
 */
export class Transglot implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'transglot',
		name: 'transglot',
		icon: { light: 'file:transglot.svg', dark: 'file:transglot.svg' },
        usableAsTool: true,
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description: 'Run AI translation, pull localized files, and read project/batch status',
		defaults: {
			name: 'transglot',
		},
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'transglotApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{ name: 'Project', value: 'project' },
					{ name: 'Batch', value: 'batch' },
				],
				default: 'project',
			},

			// ----- Project operations -----
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['project'] } },
				options: [
					{
						name: 'Get',
						value: 'get',
						action: 'Get the project identity and configured locales',
						description: 'GET /v1/project',
					},
					{
						name: 'Push Source',
						value: 'push',
						action: 'Push a source file',
						description: 'POST /v1/push (multipart upload of one source file)',
					},
					{
						name: 'Translate',
						value: 'translate',
						action: 'Start an AI translation batch',
						description: 'POST /v1/translate',
					},
					{
						name: 'Pull',
						value: 'pull',
						action: 'Pull a localized file for one locale',
						description: 'GET /v1/pull',
					},
				],
				default: 'get',
			},

			// ----- Batch operations -----
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['batch'] } },
				options: [
					{
						name: 'Get',
						value: 'get',
						action: 'Get the status of a translation batch',
						description: 'GET /v1/batches/{ID}',
					},
				],
				default: 'get',
			},

			// ----- project:translate -----
			{
				displayName: 'Scope',
				name: 'scope',
				type: 'options',
				displayOptions: { show: { resource: ['project'], operation: ['translate'] } },
				options: [
					{ name: 'Missing', value: 'missing', description: 'Only untranslated values' },
					{ name: 'Stale', value: 'stale', description: 'Values whose source changed' },
					{ name: 'All', value: 'all', description: 'Re-translate everything' },
					{
						name: 'Selected',
						value: 'selected',
						description: 'Only the keys listed in Key IDs',
					},
				],
				default: 'missing',
				description: 'Which translations the AI batch should (re)generate',
			},
			{
				displayName: 'Additional Fields',
				name: 'translateOptions',
				type: 'collection',
				placeholder: 'Add Field',
				default: {},
				displayOptions: { show: { resource: ['project'], operation: ['translate'] } },
				options: [
					{
						displayName: 'Key IDs',
						name: 'keyIds',
						type: 'string',
						default: '',
						placeholder: '1024,1025,1026',
						description:
							'Comma-separated translation key IDs (used with the "Selected" scope). Max 2000.',
					},
					{
						displayName: 'Locales',
						name: 'locales',
						type: 'string',
						default: '',
						placeholder: 'fr,de,pt-BR',
						description:
							'Comma-separated target locales to limit the batch to. Empty means every configured target locale.',
					},
				],
			},

			// ----- project:push -----
			{
				displayName: 'Input Binary Field',
				name: 'binaryPropertyName',
				type: 'string',
				required: true,
				default: 'data',
				displayOptions: { show: { resource: ['project'], operation: ['push'] } },
				description:
					'Name of the binary property on the input item that holds the source file to upload',
			},

			// ----- project:pull + push (shared format / locale) -----
			{
				displayName: 'Format',
				name: 'format',
				type: 'options',
				displayOptions: { show: { resource: ['project'], operation: ['pull', 'push'] } },
				default: 'json_nested',
				description:
					'Serialization codec of the file (used to render the pulled file, or to parse an uploaded source on push)',
				options: [
					{ name: '.Resx', value: 'resx' },
					{ name: 'Android XML', value: 'android_xml' },
					{ name: 'CSV', value: 'csv' },
					{ name: 'Flutter ARB', value: 'flutter_arb' },
					{ name: 'Gettext .Po', value: 'gettext_po' },
					{ name: 'iOS .Strings', value: 'ios_strings' },
					{ name: 'iOS .Stringsdict', value: 'ios_stringsdict' },
					{ name: 'iOS .Xcstrings', value: 'ios_xcstrings' },
					{ name: 'Java .Properties', value: 'java_properties' },
					{ name: 'JSON (Flat)', value: 'json_flat' },
					{ name: 'JSON (Nested)', value: 'json_nested' },
					{ name: 'Laravel JSON', value: 'laravel_json' },
					{ name: 'Laravel PHP', value: 'laravel_php' },
					{ name: 'Markdown', value: 'markdown' },
					{ name: 'Unity CSV', value: 'unity_csv' },
					{ name: 'Unreal .Po', value: 'unreal_po' },
					{ name: 'XLIFF 1.2', value: 'xliff_12' },
					{ name: 'XLIFF 2.0', value: 'xliff_20' },
					{ name: 'XLSX', value: 'xlsx' },
					{ name: 'YAML', value: 'yaml' },
				],
			},
			{
				displayName: 'Locale',
				name: 'locale',
				type: 'string',
				required: true,
				default: '',
				placeholder: 'fr',
				displayOptions: { show: { resource: ['project'], operation: ['pull', 'push'] } },
				description:
					'A configured locale on the project. On pull, the locale to export; on push, the locale the uploaded file contains.',
			},
			{
				displayName: 'Minimum State',
				name: 'minState',
				type: 'options',
				default: '',
				displayOptions: { show: { resource: ['project'], operation: ['pull'] } },
				options: [
					{ name: 'Any', value: '' },
					{ name: 'Human Edited', value: 'human_edited' },
					{ name: 'Reviewed', value: 'reviewed' },
				],
				description: 'Only include translations at or above this workflow state',
			},

			// ----- project:push (options) -----
			{
				displayName: 'Additional Fields',
				name: 'pushOptions',
				type: 'collection',
				placeholder: 'Add Field',
				default: {},
				displayOptions: { show: { resource: ['project'], operation: ['push'] } },
				options: [
					{
						displayName: 'File Name',
						name: 'fileName',
						type: 'string',
						default: '',
						placeholder: 'strings.{locale}.json',
						description:
							'Override the uploaded file name (defaults to the binary field file name). A {locale} placeholder is replaced with the Locale, which keeps distinct locales from colliding on one name.',
					},
					{
						displayName: 'Sync Removals',
						name: 'syncRemovals',
						type: 'boolean',
						default: false,
						description:
							'Whether keys absent from the uploaded file are deleted from the project (sends mode=sync_removals). Off by default so a partial file never prunes keys.',
					},
				],
			},

			// ----- batch:get -----
			{
				displayName: 'Batch ID',
				name: 'batchId',
				type: 'string',
				required: true,
				default: '',
				displayOptions: { show: { resource: ['batch'], operation: ['get'] } },
				description: 'The batch ID returned by a Translate operation',
			},
			{
				displayName: 'Include Failures',
				name: 'includeFailures',
				type: 'boolean',
				default: false,
				displayOptions: { show: { resource: ['batch'], operation: ['get'] } },
				description: 'Whether to include the per-item failure list (key, locale, error)',
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		// Push collision guard (mirrors packages/cli push.ts): tracks which locale first
		// claimed each resolved source file name so the SAME file is never pushed under two
		// different locales in one execution (that would upload it twice). Keyed by the
		// resolved file name; the value is the locale that claimed it.
		const pushedFileLocales = new Map<string, string>();

		for (let i = 0; i < items.length; i++) {
			try {
				const resource = this.getNodeParameter('resource', i) as string;
				const operation = this.getNodeParameter('operation', i) as string;

				let responseData: IDataObject | IDataObject[];

				if (resource === 'project' && operation === 'get') {
					responseData = await transglotApiRequest.call(this, 'GET', '/v1/project') as IDataObject;
				} else if (resource === 'project' && operation === 'push') {
					const binaryPropertyName = this.getNodeParameter('binaryPropertyName', i) as string;
					const format = this.getNodeParameter('format', i) as string;
					const locale = (this.getNodeParameter('locale', i) as string).trim();
					const extra = this.getNodeParameter('pushOptions', i, {}) as IDataObject;
					const syncRemovals = extra.syncRemovals === true;

					const binaryData = this.helpers.assertBinaryData(i, binaryPropertyName);
					const fileName = resolvePushFileName(
						(extra.fileName as string) ?? '',
						binaryData.fileName,
						locale,
					);

					// {locale}-collision guard: the same source file pushed under two distinct
					// locales would upload it twice. The remedy is a {locale} placeholder in the
					// File Name so each locale gets its own name.
					const priorLocale = pushedFileLocales.get(fileName);
					if (priorLocale !== undefined && priorLocale !== locale) {
						throw new NodeOperationError(
							this.getNode(),
							`source file "${fileName}" is pushed for both ${priorLocale} and ${locale}; the same file would be uploaded twice. Add a {locale} placeholder to File Name or use distinct file names.`,
							{ itemIndex: i },
						);
					}
					pushedFileLocales.set(fileName, locale);

					const buffer = await this.helpers.getBinaryDataBuffer(i, binaryPropertyName);
					const raw = await transglotPushRequest.call(this, {
						buffer,
						fileName,
						format,
						locale,
						syncRemovals,
						mimeType: binaryData.mimeType,
					});

					responseData = asDiffObject(raw);
				} else if (resource === 'project' && operation === 'translate') {
					const scope = this.getNodeParameter('scope', i) as string;
					const extra = this.getNodeParameter('translateOptions', i, {}) as IDataObject;

					const body: IDataObject = { scope };
					const keyIds = parseCsvNumbers((extra.keyIds as string) ?? '');
					if (keyIds.length > 0) {
						body.key_ids = keyIds;
					}
					const locales = parseCsvStrings((extra.locales as string) ?? '');
					if (locales.length > 0) {
						body.locales = locales;
					}

					responseData = await transglotApiRequest.call(this, 'POST', '/v1/translate', body) as IDataObject;
				} else if (resource === 'project' && operation === 'pull') {
					const format = this.getNodeParameter('format', i) as string;
					const locale = this.getNodeParameter('locale', i) as string;
					const minState = this.getNodeParameter('minState', i, '') as string;

					const qs: IDataObject = { format, locale };
					if (minState) {
						qs.min_state = minState;
					}

					// The file body may be JSON or any text codec (.po, .strings, ...), so pull
					// raw and only parse when the codec is JSON-shaped.
					const raw = (await transglotApiRequest.call(
						this,
						'GET',
						'/v1/pull',
						undefined,
						qs,
						TEXT_RESPONSE_OPTIONS,
					)) as string;

					responseData = {
						format,
						locale,
						content: raw,
						parsed: tryParseJson(format, raw),
					} as IDataObject;
				} else if (resource === 'batch' && operation === 'get') {
					const batchId = (this.getNodeParameter('batchId', i) as string).trim();
					const includeFailures = this.getNodeParameter('includeFailures', i, false) as boolean;
					const qs: IDataObject = {};
					if (includeFailures) {
						qs.include = 'failures';
					}

					responseData = await transglotApiRequest.call(
						this,
						'GET',
						`/v1/batches/${encodeURIComponent(batchId)}`,
						undefined,
						qs,
					) as IDataObject;
				} else {
					throw new NodeOperationError(
						this.getNode(),
						`Unsupported operation "${resource}:${operation}"`,
						{ itemIndex: i },
					);
				}

				const executionData = this.helpers.constructExecutionMetaData(
					this.helpers.returnJsonArray(responseData as IDataObject | IDataObject[]),
					{ itemData: { item: i } },
				);
				returnData.push(...executionData);
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({
						json: { error: (error as Error).message },
						pairedItem: { item: i },
					});
					continue;
				}
				if (error instanceof NodeOperationError) {
                    throw new NodeOperationError(this.getNode(), error.message, { itemIndex: i });
                }
                throw new NodeApiError(this.getNode(), error as JsonObject, { itemIndex: i });
			}
		}

		return [returnData];
	}
}

function parseCsvNumbers(value: string): number[] {
	return value
		.split(',')
		.map((part) => part.trim())
		.filter((part) => part.length > 0)
		.map((part) => Number(part))
		.filter((n) => Number.isFinite(n));
}

function parseCsvStrings(value: string): string[] {
	return value
		.split(',')
		.map((part) => part.trim())
		.filter((part) => part.length > 0);
}

function tryParseJson(format: string, raw: string): unknown {
	if (!format.startsWith('json') && format !== 'flutter_arb' && format !== 'laravel_json') {
		return undefined;
	}
	try {
		return JSON.parse(raw);
	} catch {
		return undefined;
	}
}

/**
 * Resolve the file name sent in the multipart upload. A non-empty File Name override wins;
 * otherwise the binary property's own file name is used, falling back to a plain "source"
 * when the binary carries none. Any {locale} placeholder is replaced with the locale, which
 * is what lets one Push node fan out over several locales without a name collision.
 */
function resolvePushFileName(
	override: string,
	binaryFileName: string | undefined,
	locale: string,
): string {
	const template = override.trim() !== '' ? override.trim() : (binaryFileName ?? 'source');

	return template.replaceAll('{locale}', locale);
}

/**
 * The push endpoint returns a JSON diff. The request is sent with json:false (so the
 * multipart body is never re-serialized), which means the HTTP layer may hand back either
 * an already-parsed object or the raw JSON string. Normalize both to a plain object.
 */
function asDiffObject(response: unknown): IDataObject {
	if (typeof response === 'string') {
		try {
			return JSON.parse(response) as IDataObject;
		} catch {
			return { raw: response };
		}
	}

	return (response ?? {}) as IDataObject;
}

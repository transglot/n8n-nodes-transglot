import type {
	IDataObject,
    JsonObject,
	IHookFunctions,
	ILoadOptionsFunctions,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
	IWebhookFunctions,
	IWebhookResponseData,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import { transglotApiRequest } from '../shared/GenericFunctions';
import { verifyWebhookSignature } from '../shared/WebhookSignature';

/**
 * transglot trigger node (REST hooks).
 *
 * When the workflow is activated, n8n calls `create`, which subscribes one webhook on
 * the project via `POST /v1/webhooks` and stores the returned subscription id. When the
 * workflow is deactivated (or deleted), `delete` unsubscribes via
 * `DELETE /v1/webhooks/{id}`. Each delivery arrives as a POST whose body is
 * `{ event, delivered_at, project: { id, slug }, ...block }` and is emitted verbatim.
 *
 * Deliveries are HMAC-signed; see the README for the `X-Transglot-Signature` scheme.
 */
export class TransglotTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'transglot Trigger',
		name: 'transglotTrigger',
		icon: { light: 'file:transglot.svg', dark: 'file:transglot.svg' },
		group: ['trigger'],
		version: 1,
		subtitle: '=On: {{$parameter["event"]}}',
		description: 'Starts a workflow when a transglot project event fires',
		defaults: {
			name: 'transglot Trigger',
		},
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'transglotApi',
				required: true,
			},
		],
		webhooks: [
			{
				name: 'default',
				httpMethod: 'POST',
				responseMode: 'onReceived',
				path: 'webhook',
			},
		],
		properties: [
			{
				displayName: 'Event Name or ID',
				name: 'event',
				type: 'options',
				required: true,
				default: 'batch.completed',
				// The catalog is loaded live from GET /v1/webhooks/events so the dropdown can
				// never drift from what the emitter actually delivers.
				typeOptions: {
					loadOptionsMethod: 'getEvents',
				},
				description:
					'The project event to subscribe to. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},
		],
	};

	methods = {
		loadOptions: {
			async getEvents(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const response = (await transglotApiRequest.call(
					this,
					'GET',
					'/v1/webhooks/events',
				)) as { data?: Array<{ event: string; label?: string; description?: string }> };

				const events = response?.data ?? [];
				if (events.length === 0) {
					// Fall back to the known catalog if the endpoint returns nothing, so the node
					// is still configurable without a live connection.
					return FALLBACK_EVENTS;
				}

				return events.map((entry) => ({
					name: entry.label ?? entry.event,
					value: entry.event,
					description: entry.description,
				}));
			},
		},
	};

	webhookMethods = {
		default: {
			/**
			 * Called on activation to see whether our subscription already exists on the
			 * service (e.g. after an n8n restart) so `create` is not run twice. Matches by
			 * the n8n-issued delivery URL.
			 */
			async checkExists(this: IHookFunctions): Promise<boolean> {
				const webhookUrl = this.getNodeWebhookUrl('default');
				const webhookData = this.getWorkflowStaticData('node');

				const response = (await transglotApiRequest.call(this, 'GET', '/v1/webhooks')) as {
					data?: Array<{ id: number | string; url: string; events?: string[] }>;
				};

				const existing = (response?.data ?? []).find((hook) => hook.url === webhookUrl);
				if (existing !== undefined) {
					if (String(webhookData.webhookId) !== String(existing.id)) {
						delete webhookData.webhookSecret;
					}
					webhookData.webhookId = existing.id;
					return typeof webhookData.webhookSecret === 'string' &&
						webhookData.webhookSecret.length > 0 &&
						existing.events?.includes(this.getNodeParameter('event') as string) === true;
				}

				delete webhookData.webhookId;
				delete webhookData.webhookSecret;
				return false;
			},

			/** Subscribe: POST /v1/webhooks { url, events: [event] }; store the returned id. */
			async create(this: IHookFunctions): Promise<boolean> {
				const webhookUrl = this.getNodeWebhookUrl('default');
				const event = this.getNodeParameter('event') as string;
				const webhookData = this.getWorkflowStaticData('node');

				// Old releases did not retain the reveal-once secret. Replace only the
				// subscription matched to this workflow URL by checkExists above.
				if (webhookData.webhookId !== undefined) {
					await removeSubscription.call(this, webhookData.webhookId);
					delete webhookData.webhookId;
					delete webhookData.webhookSecret;
				}

				const body: IDataObject = {
					url: webhookUrl,
					events: [event],
				};

				const response = (await transglotApiRequest.call(
					this,
					'POST',
					'/v1/webhooks',
					body,
				)) as { id?: number | string; secret?: string };

				if (response?.id === undefined) {
					return false;
				}

				webhookData.webhookId = response.id;
				if (typeof response.secret !== 'string' || response.secret.length === 0) {
					await removeSubscription.call(this, response.id);
					delete webhookData.webhookId;
					throw new NodeOperationError(this.getNode(), 'Transglot did not return a webhook signing secret. The subscription was removed; activate the workflow again.');
				}
				webhookData.webhookSecret = response.secret;
				return true;
			},

			/** Unsubscribe: DELETE /v1/webhooks/{id}; clear the stored id. */
			async delete(this: IHookFunctions): Promise<boolean> {
				const webhookData = this.getWorkflowStaticData('node');

				if (webhookData.webhookId === undefined) {
					delete webhookData.webhookSecret;
					return true;
				}

				await removeSubscription.call(this, webhookData.webhookId);

				delete webhookData.webhookId;
				delete webhookData.webhookSecret;
				return true;
			},
		},
	};

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const headers = this.getHeaderData();
		const secret = this.getWorkflowStaticData('node').webhookSecret;
		if (!verifyWebhookSignature(secret, headers['x-transglot-timestamp'], headers['x-transglot-signature'], this.getRequestObject().rawBody)) {
			this.getResponseObject().status(401).send('Invalid webhook signature or timestamp').end();
			return { noWebhookResponse: true };
		}
		const body = this.getBodyData();
		if (body.event !== this.getNodeParameter('event')) {
			this.getResponseObject().status(400).send('Unexpected webhook event').end();
			return { noWebhookResponse: true };
		}

		return {
			workflowData: [this.helpers.returnJsonArray(body as IDataObject)],
		};
	}
}

async function removeSubscription(this: IHookFunctions, id: unknown): Promise<void> {
	try {
		await transglotApiRequest.call(this, 'DELETE', `/v1/webhooks/${encodeURIComponent(String(id))}`);
	} catch (error) {
		const response = error as { httpCode?: string | number; statusCode?: number };
		if (String(response.httpCode ?? response.statusCode) !== '404') {
			throw new NodeApiError(this.getNode(), error as JsonObject);
		}
	}
}

/**
 * The canonical transglot event set — mirrors WebhookEndpoint::EVENTS on the server.
 * Used only as a fallback when the live catalog endpoint is unreachable.
 */
const FALLBACK_EVENTS: INodePropertyOptions[] = [
	{ name: 'Batch Completed', value: 'batch.completed' },
	{ name: 'Batch Failed', value: 'batch.failed' },
	{ name: 'Keys Created', value: 'key.created' },
	{ name: 'Keys Updated', value: 'key.updated' },
	{ name: 'Keys Deleted', value: 'key.deleted' },
	{ name: 'Translations Updated', value: 'translation.updated' },
	{ name: 'Translations Reviewed', value: 'translation.reviewed' },
	{ name: 'Language Added', value: 'language.added' },
	{ name: 'Glossary Updated', value: 'glossary.updated' },
	{ name: 'QA Pass Completed', value: 'qa.completed' },
	{ name: 'Source Drift Repaired', value: 'source_drift.repaired' },
];

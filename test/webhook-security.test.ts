import { createHmac } from 'crypto';
import { verifyWebhookSignature } from '../nodes/shared/WebhookSignature';
import { TransglotTrigger } from '../nodes/TransglotTrigger/TransglotTrigger.node';

const secret = 'whsec_local_fixture_not_a_real_secret';
const now = 1_800_000_000_000;
const timestamp = String(now / 1000);
const rawBody = Buffer.from('{ "event": "batch.completed", "label": "Bon retour — مرحبا" }');
const sign = (body = rawBody, time = timestamp) =>
	'sha256=' + createHmac('sha256', secret).update(time + '.').update(body).digest('hex');

describe('Transglot delivery authentication', () => {
	it('accepts signed UTF-8 bytes without normalizing JSON whitespace', () => {
		expect(verifyWebhookSignature(secret, timestamp, sign(), rawBody, now)).toBe(true);
		expect(verifyWebhookSignature(secret, timestamp, sign(), Buffer.from(JSON.stringify(JSON.parse(rawBody.toString()))), now)).toBe(false);
	});

	it.each([
		['missing secret', undefined, timestamp, sign(), rawBody],
		['missing timestamp', secret, undefined, sign(), rawBody],
		['duplicate header', secret, [timestamp, timestamp], sign(), rawBody],
		['invalid timestamp', secret, '1e9', sign(), rawBody],
		['missing signature', secret, timestamp, undefined, rawBody],
		['truncated signature', secret, timestamp, 'sha256=00', rawBody],
		['forged signature', secret, timestamp, 'sha256=' + '0'.repeat(64), rawBody],
		['wrong secret', 'different_secret', timestamp, sign(), rawBody],
		['missing raw bytes', secret, timestamp, sign(), undefined],
		['parsed JSON instead of bytes', secret, timestamp, sign(), JSON.parse(rawBody.toString())],
		['altered body', secret, timestamp, sign(), Buffer.from('{"event":"batch.failed"}')],
	])('rejects %s', (_case, key, time, signature, body) => {
		expect(verifyWebhookSignature(key, time, signature, body, now)).toBe(false);
	});

	it.each([-301, 301])('rejects a correctly signed timestamp outside the five-minute window (%i seconds)', (offset) => {
		const time = String(now / 1000 + offset);
		expect(verifyWebhookSignature(secret, time, sign(rawBody, time), rawBody, now)).toBe(false);
	});

	it('returns 401 and emits no workflow items for an unsigned request', async () => {
		const response = { status: jest.fn(), send: jest.fn(), end: jest.fn() };
		response.status.mockReturnValue(response); response.send.mockReturnValue(response);
		const returnJsonArray = jest.fn();
		const context = {
			getHeaderData: () => ({}),
			getRequestObject: () => ({ rawBody }),
			getWorkflowStaticData: () => ({ webhookSecret: secret }),
			getResponseObject: () => response,
			helpers: { returnJsonArray },
		};
		expect(await new TransglotTrigger().webhook.call(context as any)).toEqual({ noWebhookResponse: true });
		expect(response.status).toHaveBeenCalledWith(401);
		expect(returnJsonArray).not.toHaveBeenCalled();
	});

	it('rejects a valid signed delivery for another selected event', async () => {
		const time = String(Math.floor(Date.now() / 1000));
		const response = { status: jest.fn(), send: jest.fn(), end: jest.fn() };
		response.status.mockReturnValue(response); response.send.mockReturnValue(response);
		const context = {
			getHeaderData: () => ({ 'x-transglot-timestamp': time, 'x-transglot-signature': sign(rawBody, time) }),
			getRequestObject: () => ({ rawBody }),
			getWorkflowStaticData: () => ({ webhookSecret: secret }),
			getResponseObject: () => response,
			getBodyData: () => JSON.parse(rawBody.toString()),
			getNodeParameter: () => 'batch.failed',
		};
		expect(await new TransglotTrigger().webhook.call(context as any)).toEqual({ noWebhookResponse: true });
		expect(response.status).toHaveBeenCalledWith(400);
	});
});

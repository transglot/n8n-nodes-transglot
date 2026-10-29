import { createHmac, timingSafeEqual } from 'crypto';

/** Verify the exact wire bytes; reserializing JSON would change the signed message. */
export function verifyWebhookSignature(
	secret: unknown,
	timestamp: unknown,
	signature: unknown,
	rawBody: unknown,
	now = Date.now(),
): boolean {
	if (
		typeof secret !== 'string' || secret.length === 0 ||
		typeof timestamp !== 'string' || !/^\d+$/.test(timestamp) ||
		typeof signature !== 'string' || !/^sha256=[a-f0-9]{64}$/i.test(signature) ||
		!Buffer.isBuffer(rawBody)
	) return false;

	const seconds = Number(timestamp);
	if (!Number.isSafeInteger(seconds) || Math.abs(now / 1000 - seconds) > 300) return false;

	const expected = createHmac('sha256', secret).update(timestamp).update('.').update(rawBody).digest();
	return timingSafeEqual(expected, Buffer.from(signature.slice(7), 'hex'));
}

import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Webhook payload signing (Issues #808, #810).
 *
 * `docs/webhooks.md` already told merchants to verify an HMAC-SHA256
 * signature, so this implements the scheme that document describes rather
 * than inventing one.
 *
 * # Why the timestamp is inside the signed string
 *
 * Signing only the body lets an attacker who captures one delivery replay it
 * forever. Binding a timestamp into the signed material, and having the
 * receiver reject old timestamps, bounds that window to the tolerance.
 */

/** Header carrying the timestamp and signature, Stripe-style. */
export const SIGNATURE_HEADER = "x-fluxapay-signature";
/** Header naming the event, so a receiver can route without parsing. */
export const EVENT_TYPE_HEADER = "x-fluxapay-event";
/** Header carrying the delivery id, for deduplication. */
export const DELIVERY_ID_HEADER = "x-fluxapay-delivery";

/** How far a delivery's timestamp may drift before a receiver should reject. */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

/**
 * Build the string that gets signed: `<timestamp>.<body>`.
 *
 * The separator matters. Concatenating without one makes
 * `("1", "23" + body)` and `("12", "3" + body)` produce identical signed
 * material, which is a signature collision an attacker controls.
 */
export function signedPayload(timestampSeconds: number, body: string): string {
  return `${timestampSeconds}.${body}`;
}

export function computeSignature(
  secret: string,
  timestampSeconds: number,
  body: string,
): string {
  return createHmac("sha256", secret)
    .update(signedPayload(timestampSeconds, body))
    .digest("hex");
}

/** Header value in the form `t=<unix>,v1=<hex>`. */
export function buildSignatureHeader(
  secret: string,
  body: string,
  timestampSeconds: number = Math.floor(Date.now() / 1000),
): string {
  const signature = computeSignature(secret, timestampSeconds, body);
  return `t=${timestampSeconds},v1=${signature}`;
}

export interface ParsedSignature {
  timestamp: number;
  signature: string;
}

export function parseSignatureHeader(header: string): ParsedSignature | null {
  const parts = header.split(",").map((p) => p.trim());
  let timestamp: number | null = null;
  let signature: string | null = null;

  for (const part of parts) {
    const [key, value] = part.split("=", 2);
    if (key === "t") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) timestamp = parsed;
    } else if (key === "v1") {
      signature = value ?? null;
    }
  }

  if (timestamp === null || !signature) return null;
  return { timestamp, signature };
}

/**
 * Verify a signature. Exported so the SDK and the docs can share one
 * implementation with the sender rather than describing it twice.
 */
export function verifySignature(
  secret: string,
  header: string,
  body: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
  toleranceSeconds: number = SIGNATURE_TOLERANCE_SECONDS,
): boolean {
  const parsed = parseSignatureHeader(header);
  if (!parsed) return false;

  if (Math.abs(nowSeconds - parsed.timestamp) > toleranceSeconds) {
    return false;
  }

  const expected = computeSignature(secret, parsed.timestamp, body);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(parsed.signature, "utf8");

  // Length check first: timingSafeEqual throws on a length mismatch, and a
  // plain `===` comparison would leak the position of the first wrong byte.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

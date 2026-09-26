# FluxaPay Webhook Integration Guide

This guide explains how merchants consume **off-chain webhook** notifications for payment lifecycle events. On-chain event catalogs live in [`docs/events.md`](events.md) and [`fluxapay/EVENTS.md`](../fluxapay/EVENTS.md). Webhooks are the REST-facing projection of those events for merchant backends.

---

## Overview

When a payment (or refund/dispute) transitions state, FluxaPay’s off-chain indexer delivers an HTTPS `POST` to your registered webhook URL. You should:

1. Verify the HMAC-SHA256 signature
2. Deduplicate with `payment_id` (or the event’s primary id)
3. Return `2xx` quickly; handle business logic asynchronously

---

## Event types

### Payment lifecycle

| Webhook event | Trigger | Typical on-chain source |
|---------------|---------|-------------------------|
| `payment.created` | Charge created | `PAYMENT/CREATED` |
| `payment.pending` | Awaiting on-chain confirmation | payment still `Pending` |
| `payment.confirmed` | Deposit verified | `PAYMENT/CONFIRMED` / verify |
| `payment.failed` | Expired or failed | `PAYMENT/EXPIRED` / failed status |
| `payment.settled` | Merchant settled | `PAYMENT/SETTLED` |

### Refund events (`REFUND/*`)

| Webhook event | Trigger | On-chain source |
|---------------|---------|-----------------|
| `refund.requested` | Refund filed | `REFUND/REQUESTED` |
| `refund.processed` | Refund completed | `REFUND/PROCESSED` / `COMPLETED` |
| `refund.rejected` | Refund rejected | `REFUND/REJECTED` |

### Dispute events (`DISPUTE/*`)

| Webhook event | Trigger | On-chain source |
|---------------|---------|-----------------|
| `dispute.created` | Dispute opened | `DISPUTE/CREATED` |
| `dispute.reviewed` | Moved under review | `DISPUTE/REVIEWED` |
| `dispute.resolved` | Resolution applied | `DISPUTE/RESOLVED` |
| `dispute.rejected` | Dispute rejected | `DISPUTE/REJECTED` |
| `dispute.escalated` | Deadline / escalation | `DISPUTE/ESCALATED` |
| `dispute.batch_created` | Bulk filing result | `DISPUTE/BATCH_CREATED` |

---

## Payload schema

All webhooks share a common envelope:

```json
{
  "id": "evt_01HXYZ...",
  "type": "payment.confirmed",
  "created_at": 1710000000,
  "api_version": "2024-01-01",
  "data": {
    "payment_id": "pay_abc123",
    "merchant_id": "G...",
    "amount": "10000000",
    "currency": "USDC",
    "status": "confirmed",
    "metadata": {
      "order_id": "ORD-9"
    }
  }
}
```

### Field reference

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique event delivery id (not the payment id) |
| `type` | string | Event name (see tables above) |
| `created_at` | number | Unix timestamp (seconds) |
| `api_version` | string | Payload schema version |
| `data.payment_id` | string | **Idempotency / dedup key** for payment events |
| `data.merchant_id` | string | Merchant Stellar address |
| `data.amount` | string | Amount in minor units (string to avoid JSON number precision issues) |
| `data.currency` | string | e.g. `USDC` |
| `data.status` | string | Current status snapshot |
| `data.metadata` | object\|null | Merchant metadata from create |

### Refund payload extras

```json
{
  "type": "refund.processed",
  "data": {
    "refund_id": "ref_...",
    "payment_id": "pay_...",
    "amount": "5000000",
    "status": "completed"
  }
}
```

Dedup key for refunds: prefer `refund_id`; fall back to `payment_id` + `type`.

### Dispute payload extras

```json
{
  "type": "dispute.created",
  "data": {
    "dispute_id": "dsp_...",
    "payment_id": "pay_...",
    "amount": "10000000",
    "status": "open",
    "reason": "Item not received"
  }
}
```

Dedup key for disputes: `dispute_id`.

---

## HMAC-SHA256 signature verification

Every request includes:

| Header | Description |
|--------|-------------|
| `X-FluxaPay-Signature` | Hex-encoded HMAC-SHA256 of `{timestamp}.{raw_body}` |
| `X-FluxaPay-Timestamp` | Unix seconds when the webhook was signed |
| `X-FluxaPay-Event` | Same as JSON `type` (convenience) |

### Algorithm

1. Read the **raw request body** (do not re-serialize JSON).
2. Build the signed payload: `` `${timestamp}.${rawBody}` ``
3. Compute `HMAC-SHA256(webhook_secret, signed_payload)` → hex digest.
4. Compare to `X-FluxaPay-Signature` using a **constant-time** compare.
5. Reject if `|now - timestamp| > 300` seconds (replay window).

Your webhook secret is issued in the merchant dashboard (or sandbox env). Never log the secret.

---

## Retry policy

If your endpoint does not return HTTP `2xx`:

| Attempt | Delay before retry |
|---------|--------------------|
| 1 (initial) | immediate |
| 2 | ~1s |
| 3 | ~2s |
| 4 (final) | ~4s |

- **Max retries:** 3 retries after the first delivery (**4 total attempts**).
- **Backoff:** exponential (base ~1s).
- After exhaustion, the event is marked failed; you can replay from the dashboard or indexer.

Return `200` as soon as the event is durably queued; do heavy work out-of-band.

---

## Idempotency

Deliveries can repeat (retries, at-least-once semantics).

**Recommended dedup key:** `payment_id` for payment events (as specified for merchant integrations). For refunds/disputes use `refund_id` / `dispute_id`, or composite `event_id` (`id` field) if you process many event types in one table.

Pseudo-flow:

```
if already_processed(payment_id, type):
    return 200
process(event)
mark_processed(payment_id, type)
return 200
```

Store processed keys for at least 7 days.

---

## Mapping on-chain → webhook

| On-chain `(namespace, action)` | Webhook `type` |
|--------------------------------|----------------|
| `PAYMENT/CREATED` | `payment.created` |
| (indexer pending state) | `payment.pending` |
| `PAYMENT/CONFIRMED` | `payment.confirmed` |
| `PAYMENT/EXPIRED` / failed | `payment.failed` |
| `PAYMENT/SETTLED` | `payment.settled` |
| `REFUND/REQUESTED` | `refund.requested` |
| `REFUND/PROCESSED` | `refund.processed` |
| `REFUND/REJECTED` | `refund.rejected` |
| `DISPUTE/CREATED` | `dispute.created` |
| `DISPUTE/REVIEWED` | `dispute.reviewed` |
| `DISPUTE/RESOLVED` | `dispute.resolved` |
| `DISPUTE/REJECTED` | `dispute.rejected` |
| `DISPUTE/ESCALATED` | `dispute.escalated` |
| `DISPUTE/BATCH_CREATED` | `dispute.batch_created` |

---

## Node.js (Express) example

```javascript
const express = require("express");
const crypto = require("crypto");

const app = express();
const WEBHOOK_SECRET = process.env.FLUXAPAY_WEBHOOK_SECRET;

// Must capture raw body for HMAC
app.post(
  "/webhooks/fluxapay",
  express.raw({ type: "application/json" }),
  (req, res) => {
    const signature = req.get("X-FluxaPay-Signature") || "";
    const timestamp = req.get("X-FluxaPay-Timestamp") || "";
    const rawBody = req.body.toString("utf8");

    const age = Math.abs(Date.now() / 1000 - Number(timestamp));
    if (!Number.isFinite(age) || age > 300) {
      return res.status(401).send("stale timestamp");
    }

    const expected = crypto
      .createHmac("sha256", WEBHOOK_SECRET)
      .update(`${timestamp}.${rawBody}`)
      .digest("hex");

    const a = Buffer.from(signature, "utf8");
    const b = Buffer.from(expected, "utf8");
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(401).send("invalid signature");
    }

    const event = JSON.parse(rawBody);
    const dedupKey = event.data.payment_id || event.data.dispute_id || event.id;

    // TODO: skip if dedupKey already processed
    console.log("received", event.type, dedupKey);

    res.status(200).json({ received: true });
  }
);

app.listen(3000);
```

---

## Python (FastAPI) example

```python
import hashlib
import hmac
import os
import time

from fastapi import FastAPI, Header, HTTPException, Request

app = FastAPI()
WEBHOOK_SECRET = os.environ["FLUXAPAY_WEBHOOK_SECRET"].encode()


@app.post("/webhooks/fluxapay")
async def fluxapay_webhook(
    request: Request,
    x_fluxapay_signature: str = Header(...),
    x_fluxapay_timestamp: str = Header(...),
):
    raw = await request.body()
    try:
        ts = int(x_fluxapay_timestamp)
    except ValueError as exc:
        raise HTTPException(401, "bad timestamp") from exc

    if abs(time.time() - ts) > 300:
        raise HTTPException(401, "stale timestamp")

    signed = f"{ts}.".encode() + raw
    expected = hmac.new(WEBHOOK_SECRET, signed, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, x_fluxapay_signature):
        raise HTTPException(401, "invalid signature")

    event = await request.json()
    payment_id = (event.get("data") or {}).get("payment_id")
    # TODO: idempotent upsert keyed by payment_id (or event["id"])
    return {"received": True, "payment_id": payment_id}
```

---

## Testing with the subscription daemon

[`scripts/subscription-daemon.js`](../scripts/subscription-daemon.js) polls due subscriptions and invokes `process_due_subscriptions`. Use it locally to generate recurring payment lifecycle traffic that your webhook stack can observe end-to-end.

### Setup

1. Copy `.env.example` → `.env` and set:

   ```bash
   STELLAR_RPC_URL=https://soroban-testnet.stellar.org
   CONTRACT_ID=C...
   OPERATOR_SECRET=S...
   POLL_INTERVAL_MS=60000
   NETWORK_PASSPHRASE=Test SDF Network ; September 2015
   SUBSCRIPTION_INDEX_PATH=/tmp/fluxapay_subscriptions.json
   ```

2. Ensure an off-chain index (or the JSON fallback file) lists active subscriptions.

3. Run:

   ```bash
   node scripts/subscription-daemon.js
   ```

4. Point your local Express/FastAPI webhook at a tunnel (e.g. ngrok) and register that URL in sandbox.

5. When the daemon bills a subscription, expect `payment.created` → `payment.confirmed` → (optionally) `payment.settled` deliveries.

### Manual signature check

```bash
BODY='{"id":"evt_test","type":"payment.created","created_at":1710000000,"api_version":"2024-01-01","data":{"payment_id":"pay_test","amount":"100"}}'
TS=$(date +%s)
SIG=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$FLUXAPAY_WEBHOOK_SECRET" | awk '{print $2}')
curl -X POST http://localhost:3000/webhooks/fluxapay \
  -H "Content-Type: application/json" \
  -H "X-FluxaPay-Timestamp: $TS" \
  -H "X-FluxaPay-Signature: $SIG" \
  -H "X-FluxaPay-Event: payment.created" \
  -d "$BODY"
```

---

## Security checklist

- [ ] Verify HMAC on **raw** body
- [ ] Enforce timestamp skew ≤ 5 minutes
- [ ] Deduplicate with `payment_id` (or entity id)
- [ ] Respond `2xx` only after durable accept
- [ ] Rotate webhook secrets without downtime (accept dual secrets briefly)
- [ ] Prefer HTTPS-only endpoints

---

## Related docs

- [On-chain event catalog](events.md)
- [Architecture & settlement webhooks](architecture.md)
- [SEP-6 / SEP-24 anchor callbacks](sep6-sep24-anchor-integration.md)
- [Local invoke recipes](local-invoke.md)

---

## Verifying your integration: `POST /v1/webhooks/test`

*(Issue #808)*

Before this endpoint existed, the only way to confirm your handler worked was
to put a real payment through. This sends a synthetic event to your registered
endpoint with **real HMAC signing**, so you can exercise your signature
verification without moving money.

```http
POST /v1/webhooks/test
Authorization: Bearer <merchant API key>
Content-Type: application/json

{ "endpoint_id": "wh_abc123", "event_type": "payment.confirmed" }
```

Response:

```json
{
  "delivery_id": "…",
  "event_type": "payment.confirmed",
  "livemode": false,
  "delivered": true,
  "http_status": 200,
  "duration_ms": 142,
  "response_body": "ok"
}
```

Things worth knowing:

- **`livemode` is `false`** and the payload uses `test_`-prefixed identifiers
  (`payment_id: "test_pay_000000000000"`). A handler that ignores the flag
  still cannot mistake the delivery for a real payment.
- **The signature is real**, computed with your endpoint's actual signing
  secret. If your verification passes here it will pass in production.
- **Unknown event types are rejected** with `400 UnsupportedEventType` rather
  than signed and sent, so a typo fails loudly instead of leaving you waiting
  for a delivery that will never match.
- **Rate limited to 5 test deliveries per endpoint per hour.** Exceeding it
  returns `429` with `Retry-After`.
- A `200` means *the test ran*; whether your endpoint accepted it is in
  `delivered` and `http_status`.

## Delivery history: `GET /v1/webhooks/{endpoint_id}/deliveries`

*(Issue #810)*

Every delivery attempt — live and test, success and failure — is logged.

```http
GET /v1/webhooks/wh_abc123/deliveries?payment_id=pay_123&limit=20
Authorization: Bearer <merchant API key>
```

```json
{
  "data": [
    {
      "id": "…",
      "endpoint_id": "wh_abc123",
      "event_type": "payment.confirmed",
      "payment_id": "pay_123",
      "attempt_number": 2,
      "delivered_at": "2026-09-26T10:31:00.000Z",
      "http_status": 500,
      "response_body": "Internal Server Error",
      "duration_ms": 3011,
      "success": false,
      "livemode": true
    }
  ],
  "next_before": "2026-09-26T10:31:00.000Z",
  "retention_days": 30
}
```

- **Paginate with `before`**, passing the previous page's `next_before`. This
  is keyset pagination rather than an offset, so deliveries arriving while you
  page cannot push a row you are hunting for past unseen.
- **`response_body` is truncated to 1 KB.** A failing endpoint often returns a
  full HTML error page; the first kilobyte carries the status line and any
  JSON error worth acting on.
- **Logs are purged after 30 days.** This is a debugging aid, not a ledger.
- A missing endpoint and an endpoint belonging to another merchant both return
  `404`, so endpoint ids cannot be enumerated.

### Signature scheme

The `x-fluxapay-signature` header is `t=<unix-seconds>,v1=<hex-hmac>`, and the
signed material is `<timestamp>.<raw-body>`. The timestamp is inside the
signature deliberately: signing the body alone would let anyone who captured a
delivery replay it indefinitely. Reject deliveries whose timestamp is more
than 5 minutes old, and compare signatures with a constant-time function.

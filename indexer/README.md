# FluxaPay Soroban Event Indexer

This directory contains the FluxaPay Soroban Event Indexer service that syncs events from all FluxaPay smart contracts into PostgreSQL and provides a read-only REST API.

## Features

- **Multi-Contract Event Indexing (#618)**: Subscribes simultaneously to events across all 5 FluxaPay contracts (`PaymentProcessor`, `RefundManager`, `MerchantRegistry`, `FXOracle`, `PaymentLinkManager`).
- **REST API Server (#616)**: HTTP API for querying payments, merchant payments (with pagination & status filter), disputes, refunds, events, and health status. Protected with API key authentication (`x-api-key` header or `Authorization: Bearer <API_KEY>`).
- **Scoped API Keys (#854)**: Restrict API keys to specific operations (`read:payments`, `write:payments`, `read:analytics`, `manage:webhooks`, `admin`). Requests without required scopes return `403 Insufficient Scope`.
- **Real-Time Payment Event Streaming (#855)**: Server-Sent Events (SSE) endpoint (`GET /v1/events/stream`) delivering real-time payment updates to merchant dashboards. Features SEP-10 JWT authentication, query-based event filtering (`?event_types=...`), a 5 concurrent connection cap per merchant (`429`), and 30-second ping keepalives.
- **Dead-Letter Queue & Automatic Retry (#617)**: Persists failed events to `dead_letter_events` with error tracking and retry counters. Includes an automatic retry worker and an authenticated `POST /admin/replay-dlq` manual replay endpoint.
- **Dispute Lifecycle Persistence (#615)**: Persists dispute status transitions (`RESOLVED`, `REJECTED`, `ESCALATED`) with `resolved_at` timestamps, idempotency, and safe unknown dispute handling.

## Real-Time SSE Stream (`GET /v1/events/stream`)

Subscribe to real-time events for a merchant dashboard:

```bash
curl -N -H "Authorization: Bearer <JWT_OR_API_KEY>" \
  "http://localhost:3000/v1/events/stream?merchant_id=G_MERCHANT&event_types=payment.confirmed,payment.failed"
```

Headers returned:
- `Content-Type: text/event-stream`
- `Cache-Control: no-cache`
- `Connection: keep-alive`

Keepalive pings (`event: ping`) are dispatched every 30 seconds.

## Quick Start


1. Install dependencies:
   ```bash
   npm install
   ```

2. Configure environment:
   ```bash
   cp .env.example .env
   ```

3. Run migrations:
   ```bash
   npm run migrate
   ```

4. Start indexer & REST API:
   ```bash
   npm start
   ```

5. Run test suite:
   ```bash
   npm test
   ```

See [`README_SERVICE.md`](./README_SERVICE.md) for full configuration, API endpoint documentation, DLQ operations, and multi-contract routing details.

/**
 * FluxaPay Indexer Database Module
 * Handles PostgreSQL connections and event persistence with idempotency
 */

import { Pool } from "pg";
import { ContractEvent, AnyEvent } from "./types";
import { SettlementRecord, SettlementStatus, SettlementStore } from "./settlement";

export class Database implements SettlementStore {
  private pool: Pool;
  private initialized = false;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  async initialize(): Promise<void> {
    try {
      const client = await this.pool.connect();
      await client.query("SELECT 1");
      client.release();
      this.initialized = true;
      console.log("Database connected successfully");
    } catch (error) {
      console.error("Failed to connect to database:", error);
      throw error;
    }
  }

  async storeEvent(event: AnyEvent): Promise<boolean> {
    if (!this.initialized) throw new Error("Database not initialized");

    const client = await this.pool.connect();
    try {
      // Check if event already exists (idempotency)
      const existingEvent = await client.query(
        "SELECT id FROM contract_events WHERE event_id = $1",
        [event.id]
      );

      if (existingEvent.rows.length > 0) {
        console.log(`Event ${event.id} already processed, skipping...`);
        return false;
      }

      // Determine table based on event topic
      const [eventType] = event.topic;
      const table = this.getTableName(eventType);

      // Store in contract_events (dedup table)
      await client.query(
        `INSERT INTO contract_events (event_id, event_type, ledger, tx_hash, timestamp, data)
         VALUES ($1, $2, $3, $4, to_timestamp($5), $6)
         ON CONFLICT (event_id) DO NOTHING`,
        [
          event.id,
          eventType,
          event.ledger,
          event.txHash,
          event.timestamp,
          JSON.stringify(event.value),
        ]
      );

      // Store in type-specific table
      await this.storeTypedEvent(table, event, client);

      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK");
      console.error("Error storing event:", error);
      throw error;
    } finally {
      client.release();
    }
  }

  private async storeTypedEvent(
    table: string,
    event: AnyEvent,
    client: any
  ): Promise<void> {
    const value = event.value as Record<string, unknown>;

    switch (table) {
      case "payments":
        await client.query(
          `INSERT INTO payments (payment_id, merchant_id, amount, currency, status, created_at)
           VALUES ($1, $2, $3, $4, $5, to_timestamp($6))
           ON CONFLICT (payment_id) DO UPDATE SET status = $5`,
          [
            value.payment_id,
            value.merchant_id,
            value.amount,
            value.currency,
            event.topic[1],
            event.timestamp,
          ]
        );
        break;

      case "refunds":
        await client.query(
          `INSERT INTO refunds (refund_id, payment_id, amount, status, created_at)
           VALUES ($1, $2, $3, $4, to_timestamp($5))
           ON CONFLICT (refund_id) DO UPDATE SET status = $4`,
          [
            value.refund_id,
            value.payment_id,
            value.amount,
            event.topic[1],
            event.timestamp,
          ]
        );
        break;

      case "disputes":
        await client.query(
          `INSERT INTO disputes (dispute_id, payment_id, amount, status, created_at)
           VALUES ($1, $2, $3, $4, to_timestamp($5))
           ON CONFLICT (dispute_id) DO UPDATE SET status = $4`,
          [
            value.dispute_id,
            value.payment_id,
            value.amount,
            event.topic[1],
            event.timestamp,
          ]
        );
        break;

      case "merchants":
        await client.query(
          `INSERT INTO merchants (merchant_id, status, last_update)
           VALUES ($1, $2, to_timestamp($3))
           ON CONFLICT (merchant_id) DO UPDATE SET status = $2, last_update = to_timestamp($3)`,
          [value.merchant_id, value.status, event.timestamp]
        );
        break;

      case "streams":
        await client.query(
          `INSERT INTO streams (stream_id, sender, receiver, amount, status, created_at)
           VALUES ($1, $2, $3, $4, $5, to_timestamp($6))
           ON CONFLICT (stream_id) DO UPDATE SET status = $5`,
          [
            value.stream_id,
            value.sender,
            value.receiver,
            value.amount,
            event.topic[1],
            event.timestamp,
          ]
        );
        break;

      case "subscriptions":
        await client.query(
          `INSERT INTO subscriptions (subscription_id, payer, status, created_at)
           VALUES ($1, $2, $3, to_timestamp($4))
           ON CONFLICT (subscription_id) DO UPDATE SET status = $3`,
          [
            value.subscription_id,
            value.payer,
            value.status,
            event.timestamp,
          ]
        );
        break;

      case "invoices":
        await client.query(
          `INSERT INTO invoices (invoice_id, merchant_id, total_amount, status, created_at)
           VALUES ($1, $2, $3, $4, to_timestamp($5))
           ON CONFLICT (invoice_id) DO UPDATE SET status = $4`,
          [
            value.invoice_id,
            value.merchant_id,
            value.total_amount,
            event.topic[1],
            event.timestamp,
          ]
        );
        break;
    }
  }

  private getTableName(eventType: string): string {
    const tableMap: Record<string, string> = {
      PAYMENT: "payments",
      REFUND: "refunds",
      DISPUTE: "disputes",
      MERCHANT: "merchants",
      STREAM: "streams",
      SUBSCRIPTION: "subscriptions",
      INVOICE: "invoices",
    };
    return tableMap[eventType] || "contract_events";
  }

  /**
   * Fetch the current settlement record for a payment, if the SEP-6/SEP-24
   * offramp has been attempted for it. Used by `SettlementService` to make
   * `settle()` idempotent against re-delivered `PAYMENT/ANCHOR_WITHDRAW`
   * events.
   */
  async getSettlement(paymentId: string): Promise<SettlementRecord | null> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `SELECT payment_id, merchant_id, anchor_domain, anchor_txn_id, amount, currency, status
         FROM settlements WHERE payment_id = $1`,
        [paymentId]
      );
      if (result.rows.length === 0) return null;
      const row = result.rows[0];
      return {
        paymentId: row.payment_id,
        merchantId: row.merchant_id,
        anchorDomain: row.anchor_domain,
        anchorTxnId: row.anchor_txn_id,
        amount: Number(row.amount),
        currency: row.currency,
        status: row.status as SettlementStatus,
      };
    } finally {
      client.release();
    }
  }

  /**
   * Insert or update the settlement row for a payment, keyed by
   * `payment_id`. Called at each step of the SEP-6 withdrawal flow
   * (initiated -> pending -> fiat_sent/failed).
   */
  async upsertSettlement(record: SettlementRecord): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(
        `INSERT INTO settlements
           (payment_id, merchant_id, anchor_domain, anchor_txn_id, amount, currency, status, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP)
         ON CONFLICT (payment_id) DO UPDATE SET
           anchor_domain = $3,
           anchor_txn_id = COALESCE($4, settlements.anchor_txn_id),
           amount = $5,
           currency = $6,
           status = $7,
           updated_at = CURRENT_TIMESTAMP`,
        [
          record.paymentId,
          record.merchantId,
          record.anchorDomain,
          record.anchorTxnId,
          record.amount,
          record.currency,
          record.status,
        ]
      );
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

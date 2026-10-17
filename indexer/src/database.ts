/**
 * FluxaPay Indexer Database Module
 * Handles PostgreSQL connections and event persistence with idempotency
 */

import { Pool } from "pg";
import { ContractEvent, AnyEvent } from "./types";

export class Database {
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
        if (event.topic[1] === "RETRY_CREATED") {
          // Issue #1037: Link the new payment row to its original. The new
          // payment's own PAYMENT/CREATED row may or may not have landed
          // yet (events can arrive out of order within a poll batch), so
          // this upserts a minimal row if needed and otherwise just sets
          // the FK column.
          await client.query(
            `INSERT INTO payments (payment_id, retry_of_payment_id, created_at)
             VALUES ($1, $2, to_timestamp($3))
             ON CONFLICT (payment_id) DO UPDATE SET retry_of_payment_id = $2`,
            [value.new_payment_id, value.original_payment_id, event.timestamp]
          );
          break;
        }

        await client.query(
          `INSERT INTO payments (payment_id, merchant_id, amount, currency, status, created_at)
           VALUES ($1, $2, $3, $4, $5, to_timestamp($6))
           ON CONFLICT (payment_id) DO UPDATE SET
             merchant_id = EXCLUDED.merchant_id,
             amount = EXCLUDED.amount,
             currency = EXCLUDED.currency,
             status = EXCLUDED.status`,
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

  async close(): Promise<void> {
    await this.pool.end();
  }
}

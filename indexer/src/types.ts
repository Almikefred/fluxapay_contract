/**
 * FluxaPay Indexer Event Types
 * Defines the structure of events emitted by the FluxaPay contract
 */

export interface ContractEvent {
  id: string;
  timestamp: number;
  ledger: number;
  txHash: string;
  contractId: string;
  topic: string[];
  value: unknown;
}

export interface PaymentEvent extends ContractEvent {
  topic: ["PAYMENT", "CREATED" | "CONFIRMED" | "SETTLED" | "FAILED"];
  value: {
    payment_id: string;
    merchant_id: string;
    amount: number;
    currency: string;
  };
}

/**
 * Issue #1037: Emitted by both `create_payment` (when called with
 * `retry_of_payment_id`) and `retry_payment` when a new payment is linked to
 * an expired/failed original. Payload is a positional 2-tuple, not the usual
 * named-field map, matching the on-chain `env.events().publish(topic, (a, b))` call.
 */
export interface PaymentRetryCreatedEvent extends ContractEvent {
  topic: ["PAYMENT", "RETRY_CREATED"];
  value: {
    original_payment_id: string;
    new_payment_id: string;
  };
}

export interface RefundEvent extends ContractEvent {
  topic: ["REFUND", "CREATED" | "PROCESSED" | "REJECTED"];
  value: {
    refund_id: string;
    payment_id: string;
    amount: number;
  };
}

export interface DisputeEvent extends ContractEvent {
  topic: ["DISPUTE", "CREATED" | "RESOLVED" | "ESCALATED"];
  value: {
    dispute_id: string;
    payment_id: string;
    amount: number;
  };
}

export interface MerchantEvent extends ContractEvent {
  topic: ["MERCHANT", "REGISTERED" | "VERIFIED" | "SUSPENDED"];
  value: {
    merchant_id: string;
    status: string;
  };
}

export interface StreamEvent extends ContractEvent {
  topic: ["STREAM", "CREATED" | "CLOSED" | "PAUSED" | "RESUMED"];
  value: {
    stream_id: string;
    sender: string;
    receiver: string;
    amount: number;
  };
}

export interface SubscriptionEvent extends ContractEvent {
  topic: ["SUBSCRIPTION", "CREATED" | "ACTIVE" | "CANCELLED" | "PAUSED"];
  value: {
    subscription_id: string;
    payer: string;
    status: string;
  };
}

export interface InvoiceEvent extends ContractEvent {
  topic: ["INVOICE", "CREATED" | "PAID" | "OVERDUE"];
  value: {
    invoice_id: string;
    merchant_id: string;
    total_amount: number;
  };
}

export type AnyEvent =
  | PaymentEvent
  | PaymentRetryCreatedEvent
  | RefundEvent
  | DisputeEvent
  | MerchantEvent
  | StreamEvent
  | SubscriptionEvent
  | InvoiceEvent;

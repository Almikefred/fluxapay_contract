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

/**
 * Emitted by `PaymentProcessor::settle_payment` when the settled merchant
 * has an `AnchorConfig` on file (see `merchant_registry.rs`). Consumed by
 * `SettlementService` (`settlement.ts`) to drive the SEP-6/SEP-24
 * USDC-to-fiat offramp. Topics carry `merchant_id` and `anchor_domain` in
 * addition to the type/action pair, so this event is decoded separately
 * from the generic `scValToObject` path — see `tryParseAnchorWithdraw` in
 * `index.ts`.
 */
export interface SettlementAnchorWithdrawEvent extends ContractEvent {
  topic: ["PAYMENT", "ANCHOR_WITHDRAW"];
  value: {
    payment_id: string;
    amount: number;
    currency: string;
    payout_address: string;
    sep6_endpoint: string;
    sep24_endpoint: string;
    supported_currencies: string[];
    ledger_timestamp: number;
  };
}

export type AnyEvent =
  | PaymentEvent
  | RefundEvent
  | DisputeEvent
  | MerchantEvent
  | StreamEvent
  | SubscriptionEvent
  | InvoiceEvent
  | SettlementAnchorWithdrawEvent;

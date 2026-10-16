/**
 * FluxaPay Indexer Event Types
 * Defines the structure of events emitted by FluxaPay contracts
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
  topic: ["PAYMENT", "CREATED" | "CONFIRMED" | "SETTLED" | "FAILED" | "CANCELLED"];
  value: {
    payment_id: string;
    merchant_id: string;
    amount: number;
    currency: string;
  };
}

export interface PaymentFeeEvent extends ContractEvent {
  topic: ["PAYMENT", "FEE_TOTAL"];
  value: {
    payment_id: string;
    amount: string | number | bigint;
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
  topic: ["DISPUTE", "CREATED" | "RESOLVED" | "REJECTED" | "ESCALATED" | "ADJUSTMENT"];
  value: {
    dispute_id: string;
    payment_id: string;
    amount: number;
  };
}

/**
 * Issue #677: dispute bond lifecycle events. Emitted when a bond is
 * released back to its owner (BOND_RETURNED) or forfeited to the treasury
 * (BOND_FORFEITED) after a dispute is resolved or rejected.
 */
export interface DisputeBondEvent extends ContractEvent {
  topic: ["DISPUTE", "BOND_RETURNED" | "BOND_FORFEITED"];
  value: {
    dispute_id: string;
    recipient: string;
    amount: number;
  };
}

export interface MerchantEvent extends ContractEvent {
  topic: ["MERCHANT", "REGISTERED" | "VERIFIED" | "SUSPENDED" | "REINSTATED"];
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

export interface FXOracleEvent extends ContractEvent {
  topic: ["FX_ORACLE" | "ORACLE" | "FX_RATE", "UPDATED" | "SET" | "REMOVED"];
  value: {
    pair?: string;
    asset?: string;
    rate: string | number | bigint;
    decimals?: number;
  };
}

export interface PaymentLinkEvent extends ContractEvent {
  topic: ["PAYMENT_LINK" | "LINK", "CREATED" | "UPDATED" | "DEACTIVATED" | "PAID"];
  value: {
    link_id: string;
    merchant_id: string;
    amount: number;
  };
}

export type AnyEvent =
  | PaymentEvent
  | PaymentFeeEvent
  | RefundEvent
  | DisputeEvent
  | DisputeBondEvent
  | MerchantEvent
  | StreamEvent
  | SubscriptionEvent
  | InvoiceEvent
  | FXOracleEvent
  | PaymentLinkEvent;

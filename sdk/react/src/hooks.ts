import * as React from "react";
import type {
  PaymentCharge,
  Merchant,
  Refund,
  CreatePaymentParams,
} from "@fluxapay/sdk";
import { computeTotalAccrued } from "@fluxapay/sdk";
import { useFluxapayClient } from "./FluxapayProvider.js";
import { useAsync, type AsyncState } from "./useAsync.js";

/** Fetch a single payment by id. Re-fetches whenever `paymentId` changes. */
export function usePayment(paymentId: string | undefined): AsyncState<PaymentCharge> {
  const client = useFluxapayClient();
  return useAsync(
    () => client.getPayment(paymentId as string) as unknown as Promise<PaymentCharge>,
    [paymentId],
    !!paymentId,
  );
}

/** Fetch a single merchant by id. Re-fetches whenever `merchantId` changes. */
export function useMerchant(merchantId: string | undefined): AsyncState<Merchant> {
  const client = useFluxapayClient();
  return useAsync(
    () => client.getMerchant(merchantId as string) as unknown as Promise<Merchant>,
    [merchantId],
    !!merchantId,
  );
}

export interface UseMerchantPaymentsOptions {
  /** Number of payments to skip. Defaults to 0. */
  offset?: number;
  /** Max number of payments to return. Defaults to 20. */
  limit?: number;
}

/**
 * Fetch the paginated list of payments for a merchant, resolving each
 * payment id returned by the contract into its full `PaymentCharge` record.
 */
export function useMerchantPayments(
  merchantId: string | undefined,
  options?: UseMerchantPaymentsOptions,
): AsyncState<PaymentCharge[]> {
  const client = useFluxapayClient();
  const offset = options?.offset ?? 0;
  const limit = options?.limit ?? 20;

  return useAsync(
    async () => {
      const idsTx = await client.contract.get_merchant_payments_paginated({
        merchant_id: merchantId as string,
        offset,
        limit,
      });
      const ids = (idsTx as unknown as { result: string[] }).result;
      const payments = await Promise.all(ids.map((id) => client.getPayment(id)));
      return payments as unknown as PaymentCharge[];
    },
    [merchantId, offset, limit],
    !!merchantId,
  );
}

/** Fetch a single refund by id. Re-fetches whenever `refundId` changes. */
export function useRefund(refundId: string | undefined): AsyncState<Refund> {
  const client = useFluxapayClient();
  return useAsync(
    () => client.getRefund(refundId as string) as unknown as Promise<Refund>,
    [refundId],
    !!refundId,
  );
}

export type MutationStatus = "idle" | "loading" | "success" | "error";

export interface UseCreatePaymentResult {
  mutate: (params: CreatePaymentParams) => Promise<PaymentCharge>;
  data: PaymentCharge | undefined;
  status: MutationStatus;
  loading: boolean;
  error: Error | undefined;
}

/** Create a payment. Returns a `mutate` function and the current transaction status. */
export function useCreatePayment(): UseCreatePaymentResult {
  const client = useFluxapayClient();
  const [data, setData] = React.useState<PaymentCharge | undefined>(undefined);
  const [status, setStatus] = React.useState<MutationStatus>("idle");
  const [error, setError] = React.useState<Error | undefined>(undefined);

  const mutate = React.useCallback(
    async (params: CreatePaymentParams) => {
      setStatus("loading");
      setError(undefined);
      try {
        const payment = (await client.createPayment(params)) as unknown as PaymentCharge;
        setData(payment);
        setStatus("success");
        return payment;
      } catch (err) {
        const normalized = err instanceof Error ? err : new Error(String(err));
        setError(normalized);
        setStatus("error");
        throw normalized;
      }
    },
    [client],
  );

  return { mutate, data, status, loading: status === "loading", error };
}

/** How often {@link useMerchantBalance} re-fetches in the background. */
const MERCHANT_BALANCE_POLL_INTERVAL_MS = 10_000;

export interface UseMerchantBalanceResult {
  balance: bigint | null;
  loading: boolean;
  error: Error | null;
  refresh: () => void;
}

/**
 * Subscribes to a merchant's current pending settlement balance
 * (`FluxapayClient.getMerchantBalance`), re-fetching on a background
 * interval so dashboard widgets pick up new confirmed payments without a
 * manual refresh.
 *
 * The SDK does not yet expose a push-based contract event subscription, so
 * polling is the interim mechanism: call `refresh()` for an immediate
 * update (e.g. right after your own app logic observes a
 * `PAYMENT/CONFIRMED`-style event from a websocket or indexer), and the
 * background interval keeps the value fresh otherwise.
 */
export function useMerchantBalance(merchantId: string | undefined): UseMerchantBalanceResult {
  const client = useFluxapayClient();
  const [balance, setBalance] = React.useState<bigint | null>(null);
  const [loading, setLoading] = React.useState<boolean>(!!merchantId);
  const [error, setError] = React.useState<Error | null>(null);
  const [tick, setTick] = React.useState(0);

  const refresh = React.useCallback(() => setTick((t) => t + 1), []);

  React.useEffect(() => {
    if (!merchantId) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    client
      .getMerchantBalance(merchantId)
      .then((result) => {
        if (!cancelled) {
          setBalance(BigInt(result ?? 0));
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err : new Error(String(err)));
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, merchantId, tick]);

  // Background poll so the balance reflects settlements that happened
  // without the consumer calling `refresh()` itself.
  React.useEffect(() => {
    if (!merchantId) return;
    const id = setInterval(refresh, MERCHANT_BALANCE_POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [merchantId, refresh]);

  return { balance, loading, error, refresh };
}

export interface UseStreamAccrualResult {
  accrued: bigint | null;
  remainingDeposit: bigint | null;
  loading: boolean;
  error: Error | null;
}

/** Snapshot of a stream's on-chain accrual state, as of the last poll. */
interface StreamCheckpoint {
  accruedAtCheckpoint: bigint;
  lastCheckpointAt: bigint;
  ratePerSecond: bigint;
  remainingDeposit: bigint;
  isActive: boolean;
}

/** How often the animation tick recomputes the extrapolated accrued amount. */
const STREAM_ANIMATION_TICK_MS = 250;

/**
 * Subscribes to a payment stream and returns the live accrued amount,
 * re-fetching the on-chain record every `pollIntervalMs` via
 * `FluxapayClient.getStream`.
 *
 * Between polls, the accrued amount is extrapolated client-side using
 * `computeTotalAccrued` — the same lazy-accrual formula the contract uses
 * (`fluxapay/src/stream.rs`) — driven by a short animation tick, so a
 * stream status UI can show a smoothly increasing number instead of one
 * that jumps only every `pollIntervalMs`.
 */
export function useStreamAccrual(
  streamId: string | undefined,
  pollIntervalMs = 5000,
): UseStreamAccrualResult {
  const client = useFluxapayClient();
  const [accrued, setAccrued] = React.useState<bigint | null>(null);
  const [remainingDeposit, setRemainingDeposit] = React.useState<bigint | null>(null);
  const [loading, setLoading] = React.useState<boolean>(!!streamId);
  const [error, setError] = React.useState<Error | null>(null);

  const checkpointRef = React.useRef<StreamCheckpoint | null>(null);

  const applyCheckpoint = React.useCallback((checkpoint: StreamCheckpoint) => {
    checkpointRef.current = checkpoint;
    setRemainingDeposit(checkpoint.remainingDeposit);

    if (!checkpoint.isActive) {
      setAccrued(checkpoint.accruedAtCheckpoint);
      return;
    }

    const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
    setAccrued(
      computeTotalAccrued(
        checkpoint.accruedAtCheckpoint,
        checkpoint.lastCheckpointAt,
        nowSeconds,
        checkpoint.ratePerSecond,
        checkpoint.remainingDeposit,
      ),
    );
  }, []);

  // Poll the chain for the authoritative checkpoint.
  React.useEffect(() => {
    if (!streamId) {
      setLoading(false);
      return;
    }

    let cancelled = false;

    const poll = () => {
      client
        .getStream(streamId)
        .then((stream: any) => {
          if (cancelled) return;
          applyCheckpoint({
            accruedAtCheckpoint: BigInt(stream.accrued_at_checkpoint ?? 0),
            lastCheckpointAt: BigInt(stream.last_checkpoint_at ?? 0),
            ratePerSecond: BigInt(stream.rate_per_second ?? 0),
            remainingDeposit: BigInt(stream.remaining_deposit ?? 0),
            isActive: stream.status?.tag === "Active",
          });
          setLoading(false);
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setError(err instanceof Error ? err : new Error(String(err)));
          setLoading(false);
        });
    };

    setLoading(true);
    setError(null);
    poll();
    const pollId = setInterval(poll, pollIntervalMs);

    return () => {
      cancelled = true;
      clearInterval(pollId);
    };
  }, [client, streamId, pollIntervalMs, applyCheckpoint]);

  // Smooth client-side extrapolation between polls.
  React.useEffect(() => {
    if (!streamId) return;
    const tickId = setInterval(() => {
      if (checkpointRef.current) {
        applyCheckpoint(checkpointRef.current);
      }
    }, STREAM_ANIMATION_TICK_MS);
    return () => clearInterval(tickId);
  }, [streamId, applyCheckpoint]);

  return { accrued, remainingDeposit, loading, error };
}

# @fluxapay/react

React hooks for [`@fluxapay/sdk`](../README.md) — pre-built data fetching and
mutations for payments, refunds, and merchant data. Built for the FluxaPay
merchant dashboard (Next.js), but works in any React app.

## Installation

```bash
npm install @fluxapay/react @fluxapay/sdk
```

## Quick Start

Wrap your app (or dashboard layout) in `FluxapayProvider`:

```tsx
import { FluxapayProvider } from "@fluxapay/react";

export default function App({ children }: { children: React.ReactNode }) {
  return (
    <FluxapayProvider
      config={{
        network: "testnet",
        rpcUrl: "https://soroban-testnet.stellar.org",
        contractId: "C...", // PaymentProcessor contract ID
        merchantRegistryContractId: "C...", // optional
      }}
    >
      {children}
    </FluxapayProvider>
  );
}
```

Then use the hooks anywhere below the provider:

```tsx
import {
  usePayment,
  useMerchant,
  useMerchantPayments,
  useCreatePayment,
  useRefund,
  useMerchantBalance,
  useStreamAccrual,
} from "@fluxapay/react";

function PaymentStatus({ paymentId }: { paymentId: string }) {
  const { data: payment, loading, error } = usePayment(paymentId);

  if (loading) return <p>Loading...</p>;
  if (error) return <p>Error: {error.message}</p>;
  return <p>Status: {payment?.status}</p>;
}

function MerchantProfile({ merchantId }: { merchantId: string }) {
  const { data: merchant, loading } = useMerchant(merchantId);
  return loading ? <p>Loading...</p> : <p>{merchant?.business_name}</p>;
}

function RecentPayments({ merchantId }: { merchantId: string }) {
  const { data: payments, loading } = useMerchantPayments(merchantId, { limit: 10 });
  if (loading) return <p>Loading...</p>;
  return (
    <ul>
      {payments?.map((p) => (
        <li key={p.payment_id}>{p.payment_id}: {p.amount.toString()}</li>
      ))}
    </ul>
  );
}

function RefundDetails({ refundId }: { refundId: string }) {
  const { data: refund, loading } = useRefund(refundId);
  return loading ? <p>Loading...</p> : <p>{refund?.reason}</p>;
}

function MerchantBalanceWidget({ merchantId }: { merchantId: string }) {
  const { balance, loading, error, refresh } = useMerchantBalance(merchantId);

  if (loading) return <p>Loading...</p>;
  if (error) return <p>Error: {error.message}</p>;
  return (
    <div>
      <p>Pending balance: {balance?.toString() ?? "0"}</p>
      <button onClick={refresh}>Refresh</button>
    </div>
  );
}

function StreamStatus({ streamId }: { streamId: string }) {
  // Polls every 5s by default; the displayed amount animates smoothly
  // between polls using the contract's accrual formula client-side.
  const { accrued, remainingDeposit, loading, error } = useStreamAccrual(streamId);

  if (loading) return <p>Loading...</p>;
  if (error) return <p>Error: {error.message}</p>;
  return (
    <p>
      Accrued: {accrued?.toString() ?? "0"} / remaining deposit: {remainingDeposit?.toString() ?? "0"}
    </p>
  );
}

function CreatePaymentForm() {
  const { mutate, loading, error, data } = useCreatePayment();

  const onSubmit = async () => {
    await mutate({
      paymentId: "pay_123",
      merchantId: "G...",
      amount: 1_000_000n,
      currency: "USDC",
      depositAddress: "G...",
    });
  };

  return (
    <button onClick={onSubmit} disabled={loading}>
      {loading ? "Creating..." : "Create payment"}
    </button>
  );
}
```

## Hooks

All query hooks return a `{ data, loading, error, refetch }` shape, matching
the pattern used by React Query / SWR consumers.

- `usePayment(paymentId)` — fetch a single payment.
- `useMerchant(merchantId)` — fetch a single merchant.
- `useMerchantPayments(merchantId, { offset?, limit? })` — fetch a merchant's paginated payments.
- `useRefund(refundId)` — fetch a single refund.
- `useCreatePayment()` — returns `{ mutate, data, status, loading, error }` for creating a payment.
- `useMerchantBalance(merchantId)` — returns `{ balance, loading, error, refresh }` for the merchant's current pending settlement balance. Polls in the background (every 10s) and exposes `refresh()` for an immediate update, e.g. right after your own app observes a confirmed-payment event.
- `useStreamAccrual(streamId, pollIntervalMs = 5000)` — returns `{ accrued, remainingDeposit, loading, error }` for a payment stream's live accrued amount. Re-fetches the on-chain record every `pollIntervalMs`, and smoothly extrapolates the displayed value between polls client-side using the same accrual formula as the contract (`compute_total_accrued`).

## License

MIT

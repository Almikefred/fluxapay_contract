# Error Codes Reference

This document lists the `Error` variants defined in `fluxapay/src/lib.rs`
(the `PaymentProcessor` / `RefundManager` contracts) and the tiered fee
schedule introduced by #1016.

## Tiered Refund Fee Reference (Issue #1016)

`process_refund` (via `process_refund_internal`) and `refund_instantly`
look up the merchant's KYC tier through `MerchantRegistry` and apply the
matching fee rate below, instead of a single flat rate for every merchant.
Both entry points emit the applied rate as the `fee_bps` field in the
`REFUND/COMPLETED` event payload.

| KYC Tier | Refund Fee (bps) | Refund Fee (%) | Constant |
|---|---|---|---|
| Unverified | 100 (falls back to `CurrentFee`, default `REFUND_FEE_BPS`) | 1.0% | `REFUND_FEE_BPS` |
| Basic | 100 | 1.0% | `REFUND_FEE_BPS_BASIC` |
| Full | 80 | 0.8% | `REFUND_FEE_BPS_FULL` |
| Business | 50 | 0.5% | `REFUND_FEE_BPS_BUSINESS` |

Notes:

- Unverified merchants use whatever the admin has configured as the
  contract-wide default fee (`DataKey::CurrentFee`, falling back to the
  `REFUND_FEE_BPS` constant of 100 bps) rather than a tier-specific
  constant, since "Unverified" has no dedicated constant of its own.
- `refund_instantly` only accepts callers whose tier is already `Full` or
  `Business` (see the `is_high_trust` check in `fluxapay/src/lib.rs`), so
  in practice it only ever applies `REFUND_FEE_BPS_FULL` or
  `REFUND_FEE_BPS_BUSINESS`; the `Basic`/`Unverified` match arms exist for
  defensive completeness and future tier expansion.
- A merchant's tier is read at the moment the refund is processed, not at
  the moment the original payment or refund request was created. A tier
  upgrade (see #1015) that lands between refund creation and processing is
  reflected in the fee actually charged.
- `RefundManager` needs its own `MerchantRegistry` address configured via
  `set_merchant_registry_address` (admin-only) — it is a separate contract
  from `PaymentProcessor` and does not share that configuration
  automatically. If no registry address is set, every tier falls back to
  the flat default fee.

## Error Enum (`fluxapay::Error`)

| Variant | Code |
|---|---|
| Unauthorized | 1 |
| PaymentAlreadyExists | 2 |
| PaymentExpired | 3 |
| InvalidPaymentId | 4 |
| RefundAlreadyProcessed | 8 |
| DisputeNotFound | 9 |
| DisputeAlreadyResolved | 12 |
| PaymentAlreadyProcessed | 14 |
| AccessControlError | 15 |
| RefundExceedsPayment | 16 |
| ContractPaused | 17 |
| RateLimitExceeded | 18 |
| RefundCancelled | 19 |
| UnsupportedToken | 20 |
| AmountBelowMin | 21 |
| AmountAboveMax | 22 |
| InvalidExpiry | 23 |
| InvalidSettlement | 24 |
| DuplicateIdempotencyKey | 25 |
| InvalidAddress | 26 |
| ArbitrageDetected | 27 |
| SwapPathInvalid | 28 |
| OraclePriceDeviation | 29 |
| SubscriptionInGracePeriod | 30 |
| SubscriptionRetryExhausted | 31 |
| InvalidResumeTimestamp | 32 |
| MerchantAuthError | 33 |
| TierVolumeLimitExceeded | 34 |
| BatchTooLarge | 35 |
| RefundExpired | 36 |
| InsufficientArbitrators | 37 |
| ArbitrationVotingThresholdNotMet | 38 |
| FeeProposalNotReady | 39 |
| InvalidEvidenceFormat | 40 |
| InvalidSettlementSignature | 41 |
| RefundCooldownNotElapsed | 42 |
| Reentrancy | 43 |
| NoFeeProposal | 44 |
| StaleOracleRate | 45 |
| LinkExpired / InsufficientTreasuryBalance | 46 |
| MetadataValueTooLong | 47 |
| UpgradeFailed | 48 |
| MetadataTooLarge | 49 |
| InvalidMemoType | 50 |
| MemoTooLong | 51 |
| InvalidMemoId | 52 |
| PayerNotWhitelisted | 53 |
| LinkMaxUsesReached / DirectTransferNotDisputable / MaxRetriesExceeded / InvalidStatusTransition | 54 |
| RateDeviationExceeded | 55 |
| DisputeRateLimitExceeded | 54 |
| PaymentNotFound | 404 |
| RefundNotFound | 405 |
| InvalidAmount | 406 |

> Several variants above intentionally or unintentionally share the same
> numeric discriminant (e.g. `46`, `54`) in the current contract source.
> This table reflects the enum as written in `fluxapay/src/lib.rs` rather
> than resolving that pre-existing duplication, which is out of scope for
> this change. Resolving it would alter wire-level error codes for
> existing integrators and should be its own tracked change.

## Refund-Specific Errors Most Relevant to Tiered Fees

| Error | When it's returned |
|---|---|
| `PaymentNotFound` | `process_refund_internal` cannot find the `Payment` record for the refund's `payment_id` (needed to resolve the merchant for the tier lookup). |
| `RefundAlreadyProcessed` | The refund is not `Pending` (already completed, rejected, or cancelled). |
| `RefundExpired` | Called after the refund's `expiry_at` has passed. |
| `Unauthorized` | `refund_instantly` rejects merchants whose KYC tier is not `Full` or `Business`, or whose `require_auth()`/blacklist checks fail. |
| `Reentrancy` | Reentrant or concurrent `process_refund` calls for the same `refund_id`, guarded by `DataKey::ReentrancyLock` / `DataKey::RefundLock`. |

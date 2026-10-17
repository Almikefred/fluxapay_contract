import { NetworkProfileSwitcher, NetworkEnvironment } from "../network-profiles.js";
import { withMappedContractError, FeeConfig } from "../index.js";

export interface MerchantRegistryConfig {
  network: NetworkEnvironment;
  rpcUrl?: string;
  contractId: string;
}

export interface RegisterMerchantParams {
  merchantId: string;
  businessName: string;
  settlementCurrency: string;
  payoutAddress?: string;
  bankAccount?: string;
  feeConfig?: FeeConfig;
}

export interface UpdateMerchantParams {
  merchantId: string;
  businessName?: string;
  settlementCurrency?: string;
  active?: boolean;
  payoutAddress?: string;
  bankAccount?: string;
  feeConfig?: FeeConfig;
}

/**
 * Stellar Anchor Protocol (SEP-6 / SEP-24) configuration for fiat offramp.
 *
 * Bridges on-chain USDC settlement to a merchant's bank account via a
 * compliant anchor partner (MoneyGram, Circle, Tempo, etc.).
 *
 * Passed as the `anchorConfig` argument to `setMerchantAnchor`. Pass
 * `undefined` or `null` to `setMerchantAnchor` to clear the anchor and
 * revert to on-chain-only settlement.
 */
export interface AnchorConfig {
  /** Fully qualified anchor domain, e.g. "api.moneygram.com". */
  anchorDomain: string;
  /** Full URL of the anchor's SEP-6 transfer server. */
  sep6Endpoint: string;
  /** Full URL of the anchor's SEP-24 interactive transfer server. */
  sep24Endpoint: string;
  /**
   * Fiat currencies this anchor can payout for this merchant.
   * ISO-4217 alphabetic codes, e.g. ["USD", "EUR", "NGN"].
   */
  supportedCurrencies: string[];
}

export interface SetMerchantAnchorParams {
  merchantId: string;
  /** Pass a valid config to enable SEP-6 offramp; pass `null` to disable. */
  anchorConfig: AnchorConfig | null;
}

export interface SetMerchantFeeWaiverParams {
  /** Must be the MerchantRegistry admin signer. */
  admin: string;
  merchantId: string;
  /** Timestamp (seconds) until which all platform fees are waived for this
   *  merchant. Pass `undefined`/`null` to immediately clear a running waiver. */
  expiresAt?: bigint | null;
}

/**
 * MerchantRegistryClient provides a high-level interface for interacting with the MerchantRegistry contract.
 * Manages merchant registration, verification, and account status operations.
 */
export class MerchantRegistryClient {
  private contract: any;
  public networkSwitcher: NetworkProfileSwitcher;
  private contractId: string;
  private rpcUrl: string;
  private networkPassphrase: string;

  constructor(config: MerchantRegistryConfig) {
    this.networkSwitcher = new NetworkProfileSwitcher(config.network);
    const profile = this.networkSwitcher.getProfile();
    this.rpcUrl = config.rpcUrl || profile.rpcUrl;
    this.networkPassphrase = profile.networkPassphrase;
    this.contractId = config.contractId;
    this.initializeContract();
  }

  private async initializeContract(): Promise<void> {
    // Contract will be lazily initialized on first use
  }

  private getContract(): any {
    if (!this.contract) {
      const { Client } = require("@stellar/stellar-sdk/contract");
      this.contract = new Client({
        networkPassphrase: this.networkPassphrase,
        rpcUrl: this.rpcUrl,
        contractId: this.contractId,
      });
    }
    return this.contract;
  }

  /**
   * Switch the client to a different network environment.
   */
  public switchNetwork(environment: NetworkEnvironment, contractId?: string): void {
    this.networkSwitcher.switchEnvironment(environment);
    const profile = this.networkSwitcher.getProfile();
    this.rpcUrl = profile.rpcUrl;
    this.networkPassphrase = profile.networkPassphrase;
    if (contractId) {
      this.contractId = contractId;
    }
    this.contract = undefined;
  }

  /**
   * Register a new merchant in the registry.
   */
  async registerMerchant(params: RegisterMerchantParams): Promise<void> {
    return withMappedContractError(() =>
      this.getContract().register_merchant({
        merchant_id: params.merchantId,
        business_name: params.businessName,
        settlement_currency: params.settlementCurrency,
        payout_address: params.payoutAddress,
        bank_account: params.bankAccount,
        fee_config: params.feeConfig,
      }),
    );
  }

  /**
   * Retrieve details of a specific merchant.
   */
  async getMerchant(merchantId: string): Promise<any> {
    return withMappedContractError(() =>
      this.getContract().get_merchant({
        merchant_id: merchantId,
      }),
    );
  }

  /**
   * Get the merchant's accumulated pending settlement balance (the amount
   * collected from confirmed payments that has not yet been swept to the
   * merchant's payout address).
   *
   * Used by the `useMerchantBalance` React hook for dashboard balance
   * widgets; returns `0n` for a merchant with nothing pending.
   */
  async getPendingSettlement(merchantId: string): Promise<bigint> {
    return withMappedContractError(() =>
      this.getContract().get_pending_settlement({
        merchant_id: merchantId,
      }),
    );
  }

  /**
   * Update merchant details.
   */
  async updateMerchant(params: UpdateMerchantParams): Promise<void> {
    return withMappedContractError(() =>
      this.getContract().update_merchant({
        merchant_id: params.merchantId,
        business_name: params.businessName,
        settlement_currency: params.settlementCurrency,
        active: params.active,
        payout_address: params.payoutAddress,
        bank_account: params.bankAccount,
        fee_config: params.feeConfig,
      }),
    );
  }

  /**
   * Suspend a merchant account, preventing further transactions.
   */
  async suspendMerchant(operator: string, merchantId: string): Promise<void> {
    return withMappedContractError(() =>
      this.getContract().suspend_merchant({
        operator: operator,
        merchant_id: merchantId,
      }),
    );
  }

  /**
   * Reinstate a suspended merchant account.
   */
  async reinstateMerchant(operator: string, merchantId: string): Promise<void> {
    return withMappedContractError(() =>
      this.getContract().reinstate_merchant({
        operator: operator,
        merchant_id: merchantId,
      }),
    );
  }

  /**
   * Verify a merchant's KYC status, enabling higher transaction limits.
   */
  async verifyMerchant(operator: string, merchantId: string): Promise<void> {
    return withMappedContractError(() =>
      this.getContract().verify_merchant({
        admin: operator,
        merchant_id: merchantId,
      }),
    );
  }

  /**
   * Configure or clear the merchant's Stellar Anchor (SEP-6 / SEP-24)
   * integration for automated fiat offramp during settlement.
   *
   * When a valid `anchorConfig` is supplied, every subsequent settlement for
   * this merchant will emit a `PAYMENT/ANCHOR_WITHDRAW` event that the
   * off-chain Settlement Service consumes to call the anchor's SEP-6
   * withdrawal endpoint and bridge USDC → the merchant's bank account.
   *
   * Pass `anchorConfig: null` to clear the anchor and revert to
   * on-chain-only settlement (USDC stays in the merchant's payout address).
   *
   * Requires the merchant's signature — only the merchant themselves may
   * change their anchor configuration.
   *
   * Emits an on-chain `(MERCHANT, ANCHOR_UPDATED)` event.
   */
  async setMerchantAnchor(params: SetMerchantAnchorParams): Promise<void> {
    return withMappedContractError(() =>
      this.getContract().set_merchant_anchor({
        merchant_id: params.merchantId,
        anchor_config: params.anchorConfig
          ? {
              anchor_domain: params.anchorConfig.anchorDomain,
              sep6_endpoint: params.anchorConfig.sep6Endpoint,
              sep24_endpoint: params.anchorConfig.sep24Endpoint,
              supported_currencies: params.anchorConfig.supportedCurrencies,
            }
          : null,
      }),
    );
  }

  /**
   * Admin-only: apply or clear a time-based platform fee waiver for a
   * merchant (onboarding / promotional campaigns).
   *
   * While the current ledger timestamp is below `expiresAt`, every
   * `settle_payment` for this merchant will waive both the global settlement
   * fee and the merchant-level FeeConfig fee.
   *
   * Pass `expiresAt: null` (or omit) to immediately revoke an active waiver.
   *
   * Requires the MerchantRegistry admin signature.
   *
   * Emits `(MERCHANT, FEE_WAIVER_SET)` on success.
   */
  async setMerchantFeeWaiver(params: SetMerchantFeeWaiverParams): Promise<void> {
    return withMappedContractError(() =>
      this.getContract().set_merchant_fee_waiver({
        admin: params.admin,
        merchant_id: params.merchantId,
        expires_at:
          params.expiresAt === null || params.expiresAt === undefined
            ? null
            : params.expiresAt,
      }),
    );
  }
}

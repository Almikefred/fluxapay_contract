/**
 * FluxaPay Indexer REST API Server
 * Exposes read-only endpoints for persisted payments, disputes, refunds, and events,
 * as well as health check and manual DLQ replay endpoints.
 */

import express, { type Request, type Response, type NextFunction } from "express";
import * as dotenv from "dotenv";
import { Database } from "./database";
import { requireApiKey } from "./auth/api-key";
import { requireMerchantApiKey } from "./auth/merchant-api-key";
import { loadSEP10AuthConfig, type SEP10AuthConfig } from "./auth/config";
import { requireSEP10Auth } from "./auth/middleware";

dotenv.config();

export type ReplayDLQHandler = () => Promise<{ attempted: number; succeeded: number; failed: number }>;

const PAYMENT_AMOUNT_DECIMALS = 7;

function parseReportDateRange(from: unknown, to: unknown): { start: Date; endExclusive: Date } | null {
  if (typeof from !== "string" || typeof to !== "string") return null;
  const isoDate = /^\d{4}-\d{2}-\d{2}$/;
  if (!isoDate.test(from) || !isoDate.test(to)) return null;

  const start = new Date(`${from}T00:00:00.000Z`);
  const end = new Date(`${to}T00:00:00.000Z`);
  if (
    Number.isNaN(start.getTime()) ||
    Number.isNaN(end.getTime()) ||
    start.toISOString().slice(0, 10) !== from ||
    end.toISOString().slice(0, 10) !== to ||
    end < start
  ) {
    return null;
  }

  const dayCount = (end.getTime() - start.getTime()) / 86_400_000 + 1;
  if (dayCount > 31) return null;

  return { start, endExclusive: new Date(end.getTime() + 86_400_000) };
}

function asInteger(value: unknown): bigint {
  const parsed = BigInt(String(value ?? 0));
  return parsed;
}

function formatMinorUnits(value: bigint, decimalPlaces = 2): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const divisor = 10n ** BigInt(decimalPlaces);
  const whole = absolute / divisor;
  const fraction = String(absolute % divisor).padStart(decimalPlaces, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

function formatTokenAmount(value: bigint): string {
  const scale = 10n ** BigInt(PAYMENT_AMOUNT_DECIMALS - 2);
  const cents = (value + (value >= 0n ? scale / 2n : -(scale / 2n))) / scale;
  return formatMinorUnits(cents);
}

function convertAmount(
  amount: bigint,
  rate: bigint,
  rateDecimals: number,
  invert = false
): string {
  const amountScale = 10n ** BigInt(PAYMENT_AMOUNT_DECIMALS);
  const rateScale = 10n ** BigInt(rateDecimals);
  const numerator = invert ? amount * rateScale : amount * rate;
  const denominator = invert ? amountScale * rate : amountScale * rateScale;
  const centsNumerator = numerator * 100n;
  const cents = (
    centsNumerator + (centsNumerator >= 0n ? denominator / 2n : -(denominator / 2n))
  ) / denominator;
  return formatMinorUnits(cents);
}

function csvCell(value: unknown): string {
  const text = value == null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function buildReconciliationCsv(report: Record<string, any>): string {
  const header = [
    "record_type", "id", "payment_id", "amount", "currency", "status",
    "created_at", "settled_at", "fee_amount", "net_amount", "fiat_amount", "fiat_currency",
    "fiat_equivalent", "customer_ref", "tags",
  ];
  const lines = [header.map(csvCell).join(",")];
  for (const payment of report.payments) {
    lines.push([
      "payment", payment.payment_id, payment.payment_id, payment.amount,
      payment.currency, payment.status, payment.created_at, payment.settled_at,
      payment.fee_amount, "", payment.fiat_amount, payment.fiat_currency,
      payment.fiat_equivalent, payment.customer_ref, payment.tags,
    ].map(csvCell).join(","));
  }
  for (const settlement of report.settlements) {
    lines.push([
      "settlement", settlement.payment_id, settlement.payment_id,
      settlement.amount, settlement.currency, "SETTLED", "", settlement.settled_at,
      settlement.fee_amount, settlement.net_amount,
    ].map(csvCell).join(","));
  }
  for (const refund of report.refunds) {
    lines.push([
      "refund", refund.refund_id, refund.payment_id, refund.amount,
      refund.currency, refund.status, refund.created_at,
    ].map(csvCell).join(","));
  }
  for (const adjustment of report.dispute_adjustments) {
    lines.push([
      "dispute_adjustment", adjustment.dispute_id, adjustment.payment_id,
      adjustment.amount, adjustment.currency, "LOST_DISPUTE_REFUND",
      adjustment.created_at,
    ].map(csvCell).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}

function buildReconciliationReport(
  data: {
    payments: Record<string, any>[];
    settlements: Record<string, any>[];
    refunds: Record<string, any>[];
    disputeAdjustments: Record<string, any>[];
    fxRates: Record<string, any>[];
  },
  from: string,
  to: string
): Record<string, unknown> {
  const rates = new Map<string, { rate: bigint; decimals: number }>();
  for (const item of data.fxRates) {
    const rate = asInteger(item.rate);
    const decimals = Number(item.decimals);
    if (rate <= 0n || !Number.isInteger(decimals) || decimals < 0 || decimals > 38) {
      throw new Error(`Invalid cached FX rate for ${String(item.pair)}`);
    }
    rates.set(String(item.pair).toUpperCase(), {
      rate,
      decimals,
    });
  }

  const missingFxPayments: string[] = [];
  const payments = data.payments.map((payment) => {
    const currency = String(payment.currency || "").toUpperCase();
    const amount = asInteger(payment.amount);
    const equivalents: Record<string, string> = {};
    let foundRate = false;

    for (const [pair, rate] of rates) {
      const [base, quote] = pair.split("_");
      if (base === currency && quote) {
        equivalents[quote] = convertAmount(amount, rate.rate, rate.decimals);
        foundRate = true;
      } else if (quote === currency && base) {
        equivalents[base] = convertAmount(amount, rate.rate, rate.decimals, true);
        foundRate = true;
      }
    }

    const requestedFiat = String(payment.fiat_currency || "").toUpperCase();
    if (!foundRate || (requestedFiat && equivalents[requestedFiat] === undefined)) {
      missingFxPayments.push(String(payment.payment_id));
    }

    return {
      ...payment,
      amount: formatTokenAmount(amount),
      fee_amount: formatTokenAmount(asInteger(payment.fee_amount)),
      fiat_amount: payment.fiat_amount == null ? null : String(payment.fiat_amount),
      fiat_equivalent: equivalents,
    };
  });

  const settledUsdc = data.settlements.filter(
    (settlement) => String(settlement.currency || "").toUpperCase() === "USDC"
  );
  const usdcRefunds = data.refunds.filter(
    (refund) => String(refund.currency || "").toUpperCase() === "USDC"
  );
  const usdcDisputeAdjustments = data.disputeAdjustments.filter(
    (adjustment) => String(adjustment.currency || "").toUpperCase() === "USDC"
  );
  const gross = settledUsdc.reduce((sum, item) => sum + asInteger(item.amount), 0n);
  const fees = settledUsdc.reduce((sum, item) => sum + asInteger(item.fee_amount), 0n);
  const refunds = usdcRefunds.reduce((sum, item) => sum + asInteger(item.amount), 0n);
  const net = gross - fees - refunds;
  const disputeAdjustments = usdcDisputeAdjustments.reduce(
    (sum, item) => sum + asInteger(item.amount),
    0n
  );
  const netFiatEquivalent: Record<string, string> = {};
  for (const [pair, rate] of rates) {
    const [base, quote] = pair.split("_");
    if (base === "USDC" && quote) {
      netFiatEquivalent[quote] = convertAmount(net, rate.rate, rate.decimals);
    }
  }
  for (const [pair, rate] of rates) {
    const [base, quote] = pair.split("_");
    if (quote === "USDC" && base && netFiatEquivalent[base] === undefined) {
      netFiatEquivalent[base] = convertAmount(net, rate.rate, rate.decimals, true);
    }
  }

  const report = {
    period: { from, to },
    summary: {
      total_gross_usdc: formatTokenAmount(gross),
      total_fees_usdc: formatTokenAmount(fees),
      total_refunds_usdc: formatTokenAmount(refunds),
      total_net_settled_usdc: formatTokenAmount(net),
      fiat_equivalent: netFiatEquivalent,
      dispute_adjustments: formatTokenAmount(disputeAdjustments),
      fx_conversion_unavailable_payment_ids: missingFxPayments,
    },
    payments,
    settlements: data.settlements.map((settlement) => {
      const amount = asInteger(settlement.amount);
      const fee = asInteger(settlement.fee_amount);
      return {
        ...settlement,
        amount: formatTokenAmount(amount),
        fee_amount: formatTokenAmount(fee),
        net_amount: formatTokenAmount(amount - fee),
      };
    }),
    refunds: data.refunds.map((refund) => ({
      ...refund,
      amount: formatTokenAmount(asInteger(refund.amount)),
    })),
    dispute_adjustments: data.disputeAdjustments.map((adjustment) => ({
      ...adjustment,
      amount: formatTokenAmount(asInteger(adjustment.amount)),
    })),
  };

  return report;
}

function makeOnboardingStep(
  key: string,
  completedAt: Date | string | null,
  actionUrl: string
): { key: string; completed: boolean; completed_at?: string; action_url?: string } {
  if (completedAt !== null) {
    const timestamp = completedAt instanceof Date ? completedAt : new Date(completedAt);
    return { key, completed: true, completed_at: timestamp.toISOString() };
  }
  return { key, completed: false, action_url: actionUrl };
}

export function createServer(
  database: Database,
  replayDlqHandler?: ReplayDLQHandler,
  sep10AuthConfig: SEP10AuthConfig = loadSEP10AuthConfig()
) {
  const app = express();
  app.use(express.json());

  // GET /health - Public endpoint checking database connection
  app.get("/health", async (_req: Request, res: Response) => {
    try {
      const health = await database.checkHealth();
      if (health.healthy) {
        res.status(200).json({ status: "healthy", database: "connected" });
      } else {
        res.status(503).json({ status: "unhealthy", database: "disconnected", error: health.details });
      }
    } catch (error: any) {
      res.status(503).json({ status: "unhealthy", database: "disconnected", error: error.message || String(error) });
    }
  });

  // Merchant onboarding is scoped to the merchant in the authenticated SEP-10 token.
  app.get(
    "/v1/merchants/me/onboarding",
    requireSEP10Auth(sep10AuthConfig),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        if (!req.auth) {
          res.status(401).json({ error: "Authentication required" });
          return;
        }

        const merchantId = req.auth.merchant_id || req.auth.sub;
        const state = await database.getMerchantOnboardingState(merchantId);
        const steps = [
          makeOnboardingStep("merchant_registered", state?.registeredAt ?? null, "/onboarding/register"),
          makeOnboardingStep("kyc_submitted", state?.kycSubmittedAt ?? null, "/settings/kyc"),
          makeOnboardingStep("webhook_configured", null, "/settings/webhooks"),
          makeOnboardingStep("payout_channel_added", null, "/settings/payout-channels"),
          makeOnboardingStep("test_payment_created", null, "/payments/new?network=testnet"),
          makeOnboardingStep("first_live_payment", null, "/payments/new?network=mainnet"),
        ];
        const completedSteps = steps.filter((step) => step.completed).length;

        res.status(200).json({
          completion_pct: Math.round((completedSteps / steps.length) * 100),
          steps,
        });
      } catch (error) {
        next(error);
      }
    }
  );

  // All subsequent routes require API-key authentication
  app.get(
    "/v1/reports/reconciliation",
    requireMerchantApiKey,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const range = parseReportDateRange(req.query.from, req.query.to);
        if (!range) {
          res.status(400).json({
            error: "from and to must be valid ISO-8601 dates spanning no more than 31 days",
          });
          return;
        }

        const merchantId = req.merchantId;
        if (!merchantId) {
          res.status(401).json({ error: "Merchant API key authentication required" });
          return;
        }

        if (req.query.merchant_id !== undefined && req.query.merchant_id !== merchantId) {
          res.status(403).json({ error: "API key is not authorized for this merchant" });
          return;
        }

        const data = await database.getReconciliationData(
          merchantId,
          range.start,
          range.endExclusive
        );
        const report = buildReconciliationReport(
          data,
          req.query.from as string,
          req.query.to as string
        );

        if (req.headers.accept?.includes("text/csv")) {
          res.status(200).type("text/csv").send(buildReconciliationCsv(report as Record<string, any>));
          return;
        }

        res.status(200).json(report);
      } catch (error) {
        next(error);
      }
    }
  );

  app.use(requireApiKey);

  // GET /payments/:paymentId
  app.get("/payments/:paymentId", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { paymentId } = req.params;
      const payment = await database.getPaymentById(paymentId);
      if (!payment) {
        res.status(404).json({ error: "Payment not found" });
        return;
      }
      res.status(200).json(payment);
    } catch (error) {
      next(error);
    }
  });

  // GET /merchants/:merchantId/payments?page=1&limit=20&status=Confirmed
  app.get("/merchants/:merchantId/payments", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { merchantId } = req.params;
      const page = req.query.page ? parseInt(req.query.page as string, 10) : 1;
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 20;
      const status = req.query.status ? (req.query.status as string) : undefined;

      if (isNaN(page) || page < 1 || isNaN(limit) || limit < 1) {
        res.status(400).json({ error: "Invalid pagination parameters" });
        return;
      }

      const result = await database.getPaymentsByMerchantPaginated(merchantId, page, limit, status);
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  // GET /merchants/:merchantId/disputes?status=Open
  app.get("/merchants/:merchantId/disputes", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { merchantId } = req.params;
      const status = req.query.status ? (req.query.status as string) : undefined;

      const disputes = await database.getDisputesByMerchant(merchantId, status);
      res.status(200).json({ disputes });
    } catch (error) {
      next(error);
    }
  });

  // GET /refunds/:refundId
  app.get("/refunds/:refundId", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { refundId } = req.params;
      const refund = await database.getRefundById(refundId);
      if (!refund) {
        res.status(404).json({ error: "Refund not found" });
        return;
      }
      res.status(200).json(refund);
    } catch (error) {
      next(error);
    }
  });

  // GET /events?type=PAYMENT/CONFIRMED&from=<ledger>&to=<ledger>
  app.get("/events", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const type = req.query.type ? (req.query.type as string) : undefined;
      const fromLedger = req.query.from ? parseInt(req.query.from as string, 10) : undefined;
      const toLedger = req.query.to ? parseInt(req.query.to as string, 10) : undefined;

      if (fromLedger !== undefined && isNaN(fromLedger)) {
        res.status(400).json({ error: "Invalid 'from' ledger parameter" });
        return;
      }
      if (toLedger !== undefined && isNaN(toLedger)) {
        res.status(400).json({ error: "Invalid 'to' ledger parameter" });
        return;
      }

      const events = await database.getEventsFiltered(type, fromLedger, toLedger);
      res.status(200).json({ events });
    } catch (error) {
      next(error);
    }
  });

  // POST /admin/replay-dlq - Trigger manual replay of dead-letter queue events
  app.post("/admin/replay-dlq", async (_req: Request, res: Response, next: NextFunction) => {
    try {
      if (!replayDlqHandler) {
        res.status(501).json({ error: "DLQ replay handler not configured on server" });
        return;
      }

      const result = await replayDlqHandler();
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  // Global Error Handler
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    console.error("API Request Error:", err);
    res.status(500).json({ error: "Internal Server Error" });
  });

  return app;
}

export async function startServer(
  database: Database,
  port = parseInt(process.env.PORT || process.env.INDEXER_API_PORT || "3001", 10),
  replayDlqHandler?: ReplayDLQHandler
) {
  const app = createServer(database, replayDlqHandler);
  const server = app.listen(port, () => {
    console.log(`Indexer REST API listening on port ${port}`);
  });
  return server;
}

async function main(): Promise<void> {
  const dbConnectionString =
    process.env.DATABASE_URL ||
    "postgres://postgres:password@localhost:5432/fluxapay";
  const port = parseInt(process.env.PORT || process.env.INDEXER_API_PORT || "3001", 10);

  const database = new Database(dbConnectionString);
  await database.initialize();

  await startServer(database, port);
}

if (require.main === module) {
  main().catch((error) => {
    console.error("Fatal error starting indexer API:", error);
    process.exit(1);
  });
}

import express, { type Request, type Response, type NextFunction } from "express";
import * as dotenv from "dotenv";
import { z } from "zod";
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

  // Issue #817: rate limit ALL routes (auth gets a stricter per-IP budget).
  app.use(createRateLimitMiddleware());

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

  // Webhook test delivery and delivery history (Issues #808, #810, #854).
  app.use("/webhooks", requireScope("manage:webhooks"));
  registerWebhookRoutes(app, {
    store: new WebhookStore(database.getPool()),
    merchantIdFromRequest: (req) =>
      typeof req.header("x-merchant-id") === "string"
        ? (req.header("x-merchant-id") as string)
        : null,
  });

  // Issue #785: GET /v1/payments
  app.get("/v1/payments", requireScope("read:payments"), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = paymentsQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid query parameters", details: parsed.error.flatten() });
        return;
      }

      const { merchant_id, status, from, to, limit, cursor } = parsed.data;

      const subject = req.auth?.sub;
      if (!subject) {
        res.status(401).json({ error: "Missing authenticated subject" });
        return;
      }
      if (subject !== merchant_id && !sep10Config.adminAccounts.has(subject)) {
        res.status(403).json({ error: "Token is not authorized for this merchant" });
        return;
      }

      let decodedCursor: { createdAt: string; id: string } | null = null;
      if (cursor) {
        decodedCursor = decodePaymentsCursor(cursor);
        if (!decodedCursor) {
          res.status(400).json({ error: "Invalid cursor" });
          return;
        }
      }

      const result = await database.getPaymentsFiltered({
        merchantId: merchant_id,
        statuses: status,
        from,
        to,
        limit,
        cursor: decodedCursor ?? undefined,
      });

      const nextCursor =
        result.payments.length === limit && result.payments.length > 0
          ? encodePaymentsCursor(
              String(result.payments[result.payments.length - 1].created_at),
              String(result.payments[result.payments.length - 1].id),
            )
          : null;

      res.status(200).json({
        data: result.payments,
        next_cursor: nextCursor,
        total: result.total,
      });
    } catch (error) {
      next(error);
    }
  });

  // Issue #840: GET /v1/reports/reconciliation?from=&to=
  // Merchant-authenticated CSV download of payments, refunds, and settlements.
  // Large reports are streamed via a PostgreSQL cursor (not buffered in memory).
  const reconciliationQuerySchema = z.object({
    from: isoDateString,
    to: isoDateString,
  });

  const reconciliationHandler = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = reconciliationQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid query parameters", details: parsed.error.flatten() });
        return;
      }

      const subject = req.auth?.sub;
      if (!subject) {
        res.status(401).json({ error: "Missing authenticated subject" });
        return;
      }

      const merchantId = subject;
      const from = new Date(parsed.data.from);
      const to = new Date(parsed.data.to);
      if (from > to) {
        res.status(400).json({ error: "`from` must be on or before `to`" });
        return;
      }

      const monthLabel = `${from.getUTCFullYear()}-${String(from.getUTCMonth() + 1).padStart(2, "0")}`;
      const filename = `reconciliation_${monthLabel}.csv`;

      res.status(200);
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename=${filename}`);

      const header =
        "payment_id,type,amount_usdc,fiat_amount,fiat_currency,status,created_at,settled_at,customer_ref,tags\n";
      res.write(header);

      const escapeCsv = (value: string): string => {
        if (value == null) return "";
        const s = String(value);
        if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
        return s;
      };

      for await (const row of database.streamReconciliationReport(merchantId, from, to)) {
        const line = [
          row.payment_id,
          row.type,
          row.amount_usdc,
          row.fiat_amount,
          row.fiat_currency,
          row.status,
          row.created_at,
          row.settled_at,
          row.customer_ref,
          row.tags,
        ]
          .map(escapeCsv)
          .join(",");
        if (!res.write(line + "\n")) {
          await new Promise<void>((resolve) => res.once("drain", resolve));
        }
      }

      res.end();
    } catch (error) {
      next(error);
    }
  };

  // SEP-10 JWT authenticated (merchant subject = merchant_id).
  app.get(
    "/v1/reports/reconciliation",
    requireSEP10Auth(sep10Config),
    reconciliationHandler,
  );

  // GET /payments/:paymentId
  app.get("/payments/:paymentId", requireScope("read:payments"), async (req: Request, res: Response, next: NextFunction) => {
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

  app.get("/merchants/:merchantId/payments", requireScope("read:payments"), async (req: Request, res: Response, next: NextFunction) => {
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

  app.get("/merchants/:merchantId/disputes", requireScope("read:payments"), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { merchantId } = req.params;
      const status = req.query.status ? (req.query.status as string) : undefined;
      const disputes = await database.getDisputesByMerchant(merchantId, status);
      res.status(200).json({ disputes });
    } catch (error) {
      next(error);
    }
  });

  app.get("/refunds/:refundId", requireScope("read:payments"), async (req: Request, res: Response, next: NextFunction) => {
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

  app.get("/events", requireScope("read:analytics"), async (req: Request, res: Response, next: NextFunction) => {
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

  // ------------------------------------------------------------------ Issue #1067: Invoice lifecycle routes

  /** GET /v1/invoices?status=Pending|Paid|Overdue|Voided&merchant_id=... */
  app.get("/v1/invoices", requireScope("read:payments"), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const merchantId = typeof req.query.merchant_id === "string" ? req.query.merchant_id : undefined;
      const status = typeof req.query.status === "string" ? req.query.status : undefined;
      const limit = req.query.limit ? Math.min(parseInt(req.query.limit as string, 10), 100) : 50;
      const offset = req.query.offset ? parseInt(req.query.offset as string, 10) : 0;

      const result = await database.getInvoices({ merchantId, status, limit, offset });
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  /** GET /v1/invoices/:id */
  app.get("/v1/invoices/:id", requireScope("read:payments"), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const invoice = await database.getInvoiceById(req.params.id);
      if (!invoice) {
        res.status(404).json({ error: "Invoice not found" });
        return;
      }
      res.status(200).json(invoice);
    } catch (error) {
      next(error);
    }
  });

  /**
   * DELETE /v1/invoices/:id — soft-delete (Voided transition).
   * Requires SEP-10 merchant auth; only the owning merchant may void.
   */
  app.delete(
    "/v1/invoices/:id",
    requireSEP10Auth(sep10Config),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const invoiceId = req.params.id;
        const merchantId = req.auth?.sub;
        if (!merchantId) {
          res.status(401).json({ error: "Missing authenticated merchant subject" });
          return;
        }
        const updated = await database.voidInvoice(invoiceId, merchantId);
        if (!updated) {
          res.status(404).json({ error: "Invoice not found or already paid/voided" });
          return;
        }
        res.status(200).json({ invoiceId, status: "Voided" });
      } catch (error) {
        next(error);
      }
    },
  );

  // ------------------------------------------------------------------ Issue #1066: Fee collection history

  /** GET /v1/treasury/fees?offset=0&limit=100 — paginated fee collection history */
  app.get("/v1/treasury/fees", requireScope("admin"), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const limit = req.query.limit ? Math.min(parseInt(req.query.limit as string, 10), 200) : 100;
      const offset = req.query.offset ? parseInt(req.query.offset as string, 10) : 0;
      const token = typeof req.query.token === "string" ? req.query.token : undefined;

      const result = await database.getFeeCollectionHistory({ offset, limit, token });
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  // ------------------------------------------------------------------ Issue #1064: Merchant leaderboard

  /**
   * GET /v1/merchants/leaderboard?limit=20
   * Public — no auth required. Returns top merchants sorted by score descending.
   */
  app.get("/v1/merchants/leaderboard", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const limit = req.query.limit ? Math.min(parseInt(req.query.limit as string, 10), 100) : 20;
      if (isNaN(limit) || limit < 1) {
        res.status(400).json({ error: "limit must be a positive integer ≤ 100" });
        return;
      }
      const result = await database.getTopMerchants(limit);
      res.status(200).json({ merchants: result });
    } catch (error) {
      next(error);
    }
  });

  app.post("/admin/replay-dlq", requireScope("admin"), async (_req: Request, res: Response, next: NextFunction) => {
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

  app.post("/admin/replay", requireAdminApiKey, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const fromParam = req.query.from_ledger ?? req.query.from ?? req.body?.from_ledger ?? req.body?.from;
      const toParam = req.query.to_ledger ?? req.query.to ?? req.body?.to_ledger ?? req.body?.to;

      const fromLedger = parseInt(fromParam as string, 10);
      const toLedger = parseInt(toParam as string, 10);

      if (isNaN(fromLedger) || isNaN(toLedger) || fromLedger < 1 || toLedger < fromLedger) {
        res.status(400).json({
          error: "Invalid ledger parameters: 'from_ledger' and 'to_ledger' must be positive integers with from_ledger <= to_ledger",
        });
        return;
      }

      if (toLedger - fromLedger > MAX_REPLAY_LEDGER_RANGE) {
        res.status(400).json({
          error: `Requested ledger range (${toLedger - fromLedger + 1}) exceeds maximum allowed limit of ${MAX_REPLAY_LEDGER_RANGE} ledgers`,
        });
        return;
      }

      if (!eventReplayHandler) {
        res.status(501).json({ error: "Event replay handler not configured on server" });
        return;
      }

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders?.();

      let isClientConnected = true;
      req.on("close", () => {
        isClientConnected = false;
      });

      const onProgress = (progress: ReplayProgressUpdate) => {
        if (!isClientConnected) return;
        res.write(`data: ${JSON.stringify({ processed: progress.processed, total: progress.total, stored: progress.stored })}\n\n`);
      };

      const result = await eventReplayHandler(fromLedger, toLedger, onProgress);
      if (isClientConnected) {
        res.write(`data: ${JSON.stringify({ type: "complete", processed: result.processed, total: result.total, stored: result.stored })}\n\n`);
        res.end();
      }
    } catch (error: any) {
      if (res.headersSent) {
        res.write(`data: ${JSON.stringify({ type: "error", error: error.message || String(error) })}\n\n`);
        res.end();
      } else {
        next(error);
      }
    }
  });

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    console.error("API Request Error:", err);
    res.status(500).json({ error: "Internal Server Error" });
  });

  return app;
}

export async function startServer(
  database: Database,
  port = parseInt(process.env.PORT || process.env.INDEXER_API_PORT || "3001", 10),
  replayDlqHandler?: ReplayDLQHandler,
  eventReplayHandler?: EventReplayHandler,
) {
  const app = createServer(database, replayDlqHandler, eventReplayHandler);
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

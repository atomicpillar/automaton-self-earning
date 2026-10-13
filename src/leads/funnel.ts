/**
 * Funnel report.
 *
 * Counts how many distinct leads ever reached each stage (from the event
 * log, so a lead that later churned still counts), plus spend and revenue.
 */

import type BetterSqlite3 from "better-sqlite3";
import { DEFAULT_PRICE_CENTS } from "./ledger.js";
import type { LeadStatus } from "./types.js";

type Database = BetterSqlite3.Database;

export const MIN_SAMPLE_FOR_CONCLUSIONS = 100;

export interface FunnelReport {
  totalLeads: number;
  /** Distinct leads that ever reached each stage. */
  reached: { found: number; contacted: number; replied: number; trial: number; paid: number };
  /** Stage-to-stage rates; null when the denominator is zero. */
  rates: {
    contactedToReplied: number | null;
    repliedToTrial: number | null;
    trialToPaid: number | null;
    contactedToPaid: number | null;
  };
  doNotContact: number;
  currentPaid: number;
  mrrCents: number;
  totalCostCents: number;
  /** Total spend divided by customers ever won; null until the first sale. */
  costPerPaidCents: number | null;
  /** Monthly price minus cost to serve; null if cost to serve was not given. */
  marginPerCustomerCents: number | null;
  /** Months of one customer's margin needed to repay the cost per customer. */
  paybackMonths: number | null;
  warnings: string[];
}

function rate(num: number, den: number): number | null {
  return den === 0 ? null : num / den;
}

export function buildFunnelReport(
  db: Database,
  opts: { priceCents?: number; costToServeCents?: number } = {},
): FunnelReport {
  const price = opts.priceCents ?? DEFAULT_PRICE_CENTS;

  const reachedCount = (status: LeadStatus): number =>
    (
      db
        .prepare(
          "SELECT COUNT(DISTINCT lead_id) AS n FROM lead_events WHERE kind = 'status_change' AND to_status = ?",
        )
        .get(status) as { n: number }
    ).n;

  const count = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;

  const reached = {
    found: count("SELECT COUNT(*) AS n FROM leads"),
    contacted: reachedCount("contacted"),
    replied: reachedCount("replied"),
    trial: reachedCount("trial"),
    paid: reachedCount("paid"),
  };

  const currentPaid = count("SELECT COUNT(*) AS n FROM leads WHERE status = 'paid'");
  const doNotContact = count("SELECT COUNT(*) AS n FROM leads WHERE status = 'do_not_contact'");
  const totalCostCents = count(
    "SELECT COALESCE(SUM(cost_cents), 0) AS n FROM lead_events",
  );

  const costPerPaidCents = reached.paid > 0 ? Math.round(totalCostCents / reached.paid) : null;
  const marginPerCustomerCents =
    opts.costToServeCents !== undefined ? price - opts.costToServeCents : null;
  const paybackMonths =
    costPerPaidCents !== null && marginPerCustomerCents !== null && marginPerCustomerCents > 0
      ? costPerPaidCents / marginPerCustomerCents
      : null;

  const warnings: string[] = [];
  if (reached.contacted < MIN_SAMPLE_FOR_CONCLUSIONS) {
    warnings.push(
      `Only ${reached.contacted} contacted; need about ${MIN_SAMPLE_FOR_CONCLUSIONS} before the rates mean anything.`,
    );
  }
  if (marginPerCustomerCents !== null && marginPerCustomerCents <= 0) {
    warnings.push("Cost to serve is at or above the price: every customer loses money.");
  }

  return {
    totalLeads: reached.found,
    reached,
    rates: {
      contactedToReplied: rate(reached.replied, reached.contacted),
      repliedToTrial: rate(reached.trial, reached.replied),
      trialToPaid: rate(reached.paid, reached.trial),
      contactedToPaid: rate(reached.paid, reached.contacted),
    },
    doNotContact,
    currentPaid,
    mrrCents: currentPaid * price,
    totalCostCents,
    costPerPaidCents,
    marginPerCustomerCents,
    paybackMonths,
    warnings,
  };
}

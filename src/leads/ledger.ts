/**
 * Lead Ledger
 *
 * SQLite-backed record of every prospect, its status history, and what it
 * cost and earned. Backed by the `leads` and `lead_events` tables.
 */

import type BetterSqlite3 from "better-sqlite3";
import { ulid } from "ulid";
import { scoreLead } from "./scoring.js";
import {
  CONSENT_BASES,
  LEAD_STATUSES,
  type Lead,
  type LeadChannel,
  type LeadFilter,
  type LeadSignals,
  type LeadStatus,
  type NewLeadInput,
} from "./types.js";

type Database = BetterSqlite3.Database;

/** Allowed status moves. `do_not_contact` is terminal. */
const TRANSITIONS: Record<LeadStatus, LeadStatus[]> = {
  found: ["contacted", "lost", "do_not_contact"],
  contacted: ["replied", "trial", "lost", "do_not_contact"],
  replied: ["trial", "lost", "do_not_contact"],
  trial: ["paid", "lost", "do_not_contact"],
  paid: ["lost", "do_not_contact"],
  lost: ["do_not_contact"],
  do_not_contact: [],
};

export const DEFAULT_PRICE_CENTS = 5900; // $59/month

interface LeadRow {
  id: string;
  name: string;
  brokerage: string | null;
  city: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  source: string;
  consent_basis: string;
  signals: string;
  fit_score: number;
  status: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export function normalizeEmail(raw: string | undefined): string | null {
  const email = raw?.trim().toLowerCase();
  if (!email) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error(`Invalid email: ${raw}`);
  }
  return email;
}

/** Normalize a North American number to +1XXXXXXXXXX. */
export function normalizePhone(raw: string | undefined): string | null {
  if (!raw || !raw.trim()) return null;
  let digits = raw.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
  if (digits.length !== 10) throw new Error(`Invalid phone number: ${raw}`);
  return `+1${digits}`;
}

function rowToLead(row: LeadRow): Lead {
  return {
    id: row.id,
    name: row.name,
    brokerage: row.brokerage,
    city: row.city,
    phone: row.phone,
    email: row.email,
    website: row.website,
    source: row.source,
    consentBasis: row.consent_basis as Lead["consentBasis"],
    signals: JSON.parse(row.signals) as LeadSignals,
    fitScore: row.fit_score,
    status: row.status as LeadStatus,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class LeadLedger {
  constructor(private readonly db: Database) {}

  /**
   * Add a lead. Duplicates (same email or phone) return the existing lead
   * untouched, so re-importing never resurrects a do_not_contact lead.
   */
  addLead(input: NewLeadInput): { lead: Lead; created: boolean } {
    const name = input.name?.trim();
    if (!name) throw new Error("Lead name is required");
    if (!input.source?.trim()) throw new Error("Lead source is required");
    if (!CONSENT_BASES.includes(input.consentBasis)) {
      throw new Error(`Invalid consent basis: ${String(input.consentBasis)}`);
    }

    const email = normalizeEmail(input.email);
    const phone = normalizePhone(input.phone);
    if (!email && !phone) throw new Error("Lead needs an email or phone number");

    const existing = this.findByContact(email, phone);
    if (existing) return { lead: existing, created: false };

    const signals = input.signals ?? {};
    const { score } = scoreLead(signals);
    const id = ulid();

    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO leads
            (id, name, brokerage, city, phone, email, website, source,
             consent_basis, signals, fit_score, status, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'found', ?)`,
        )
        .run(
          id,
          name,
          input.brokerage?.trim() || null,
          input.city?.trim() || null,
          phone,
          email,
          input.website?.trim() || null,
          input.source.trim(),
          input.consentBasis,
          JSON.stringify(signals),
          score,
          input.notes?.trim() || null,
        );
      this.insertEvent(id, { kind: "status_change", toStatus: "found" });
    })();

    return { lead: this.getLead(id)!, created: true };
  }

  getLead(id: string): Lead | undefined {
    const row = this.db.prepare("SELECT * FROM leads WHERE id = ?").get(id) as
      | LeadRow
      | undefined;
    return row ? rowToLead(row) : undefined;
  }

  listLeads(filter: LeadFilter = {}): Lead[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.status) {
      where.push("status = ?");
      params.push(filter.status);
    }
    if (filter.minScore !== undefined) {
      where.push("fit_score >= ?");
      params.push(filter.minScore);
    }
    const sql =
      `SELECT * FROM leads${where.length ? ` WHERE ${where.join(" AND ")}` : ""}` +
      ` ORDER BY fit_score DESC, created_at ASC LIMIT ?`;
    params.push(filter.limit ?? 100);
    return (this.db.prepare(sql).all(...params) as LeadRow[]).map(rowToLead);
  }

  /** Replace a lead's signals and recompute its fit score. */
  updateSignals(id: string, signals: LeadSignals): Lead {
    this.requireLead(id);
    const { score } = scoreLead(signals);
    this.db
      .prepare(
        "UPDATE leads SET signals = ?, fit_score = ?, updated_at = datetime('now') WHERE id = ?",
      )
      .run(JSON.stringify(signals), score, id);
    return this.getLead(id)!;
  }

  setStatus(
    id: string,
    to: LeadStatus,
    opts: { detail?: string; channel?: LeadChannel; revenueCents?: number } = {},
  ): Lead {
    if (!LEAD_STATUSES.includes(to)) throw new Error(`Invalid status: ${String(to)}`);
    const lead = this.requireLead(id);
    if (lead.status === to) return lead;
    if (!TRANSITIONS[lead.status].includes(to)) {
      throw new Error(`Cannot move lead from ${lead.status} to ${to}`);
    }

    this.db.transaction(() => {
      this.db
        .prepare("UPDATE leads SET status = ?, updated_at = datetime('now') WHERE id = ?")
        .run(to, id);
      this.insertEvent(id, {
        kind: "status_change",
        fromStatus: lead.status,
        toStatus: to,
        channel: opts.channel,
        detail: opts.detail,
        revenueCents: to === "paid" ? (opts.revenueCents ?? DEFAULT_PRICE_CENTS) : 0,
      });
    })();
    return this.getLead(id)!;
  }

  /** Log that a drafted message was generated (does not change status). */
  recordDraft(id: string, channel: LeadChannel): void {
    this.requireLead(id);
    this.insertEvent(id, { kind: "message_drafted", channel });
  }

  /** Log that a message was actually sent by a human; moves found -> contacted. */
  recordSent(id: string, channel: LeadChannel, detail?: string): Lead {
    const lead = this.requireLead(id);
    if (lead.status === "do_not_contact") {
      throw new Error("Lead is marked do_not_contact");
    }
    this.insertEvent(id, { kind: "message_sent", channel, detail });
    return lead.status === "found"
      ? this.setStatus(id, "contacted", { channel, detail })
      : this.getLead(id)!;
  }

  recordCost(id: string, costCents: number, detail?: string): void {
    if (!Number.isInteger(costCents) || costCents <= 0) {
      throw new Error("costCents must be a positive integer");
    }
    this.requireLead(id);
    this.insertEvent(id, { kind: "cost", costCents, detail });
  }

  addNote(id: string, detail: string): void {
    this.requireLead(id);
    this.insertEvent(id, { kind: "note", detail });
  }

  // ─── internals ────────────────────────────────────────────────

  private requireLead(id: string): Lead {
    const lead = this.getLead(id);
    if (!lead) throw new Error(`Lead not found: ${id}`);
    return lead;
  }

  private findByContact(email: string | null, phone: string | null): Lead | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM leads WHERE (? IS NOT NULL AND email = ?) OR (? IS NOT NULL AND phone = ?) LIMIT 1",
      )
      .get(email, email, phone, phone) as LeadRow | undefined;
    return row ? rowToLead(row) : undefined;
  }

  private insertEvent(
    leadId: string,
    e: {
      kind: string;
      channel?: LeadChannel;
      fromStatus?: LeadStatus;
      toStatus?: LeadStatus;
      costCents?: number;
      revenueCents?: number;
      detail?: string;
    },
  ): void {
    this.db
      .prepare(
        `INSERT INTO lead_events
          (id, lead_id, kind, channel, from_status, to_status, cost_cents, revenue_cents, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ulid(),
        leadId,
        e.kind,
        e.channel ?? null,
        e.fromStatus ?? null,
        e.toStatus ?? null,
        e.costCents ?? 0,
        e.revenueCents ?? 0,
        e.detail ?? null,
      );
  }
}

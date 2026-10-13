import Database from "better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MIGRATION_V12 } from "../../state/schema.js";
import { LeadLedger, normalizeEmail, normalizePhone } from "../../leads/ledger.js";
import { ISA_SCORE_CAP, scoreLead } from "../../leads/scoring.js";
import { draftEmail, draftSms, firstName, type SenderConfig } from "../../leads/drafts.js";
import { buildFunnelReport } from "../../leads/funnel.js";

let db: BetterSqlite3.Database;
let ledger: LeadLedger;

const cfg: SenderConfig = {
  senderName: "Alex Smith",
  businessName: "Atomic Pillar",
  mailingAddress: "1 Example St, Toronto, ON",
  contactPhone: "+1 416 555 0100",
  contactEmail: "alex@example.com",
};

function add(n: number, extra: Partial<Parameters<LeadLedger["addLead"]>[0]> = {}) {
  return ledger.addLead({
    name: `Agent ${n}`,
    email: `agent${n}@example.com`,
    phone: `416555${String(1000 + n)}`,
    source: "https://example.com/team",
    consentBasis: "conspicuous_publication",
    ...extra,
  }).lead;
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(MIGRATION_V12);
  ledger = new LeadLedger(db);
});
afterEach(() => db.close());

describe("scoring", () => {
  it("scores only observed signals", () => {
    expect(scoreLead({}).score).toBe(0);
    expect(scoreLead({ soloOrSmallTeam: true, recentActivity: true }).score).toBe(45);
  });

  it("maxes at 100", () => {
    const all = scoreLead({
      soloOrSmallTeam: true, recentActivity: true, mobileContact: true,
      noChatOrBooking: true, slowReplyMentions: true, inTargetArea: true,
    });
    expect(all.score).toBe(100);
  });

  it("caps leads that have an ISA or call centre", () => {
    const r = scoreLead({ soloOrSmallTeam: true, recentActivity: true, hasIsaOrCallCentre: true });
    expect(r.score).toBe(ISA_SCORE_CAP);
  });
});

describe("normalization", () => {
  it("normalizes phone numbers", () => {
    expect(normalizePhone("(416) 555-1234")).toBe("+14165551234");
    expect(normalizePhone("1-416-555-1234")).toBe("+14165551234");
    expect(normalizePhone("")).toBeNull();
    expect(() => normalizePhone("12345")).toThrow(/Invalid phone/);
  });

  it("normalizes and validates email", () => {
    expect(normalizeEmail("  A@B.com ")).toBe("a@b.com");
    expect(() => normalizeEmail("nope")).toThrow(/Invalid email/);
  });
});

describe("ledger", () => {
  it("adds a lead with score and a found event", () => {
    const { lead, created } = ledger.addLead({
      name: "Sam Lee", email: "SAM@example.com", source: "team page",
      consentBasis: "conspicuous_publication",
      signals: { soloOrSmallTeam: true, mobileContact: true },
    });
    expect(created).toBe(true);
    expect(lead.email).toBe("sam@example.com");
    expect(lead.fitScore).toBe(40);
    expect(lead.status).toBe("found");
  });

  it("requires source, consent basis and a contact method", () => {
    expect(() => ledger.addLead({ name: "x", email: "x@y.com", source: "", consentBasis: "referral" })).toThrow(/source/);
    expect(() => ledger.addLead({ name: "x", source: "s", consentBasis: "referral" })).toThrow(/email or phone/);
    expect(() =>
      ledger.addLead({ name: "x", email: "x@y.com", source: "s", consentBasis: "bogus" as never }),
    ).toThrow(/consent basis/);
  });

  it("dedupes by email or phone and never resurrects do_not_contact", () => {
    const a = add(1);
    ledger.setStatus(a.id, "do_not_contact");
    const again = ledger.addLead({
      name: "Renamed", email: "agent1@example.com", source: "other", consentBasis: "referral",
    });
    expect(again.created).toBe(false);
    expect(again.lead.id).toBe(a.id);
    expect(again.lead.status).toBe("do_not_contact");
    const byPhone = ledger.addLead({
      name: "Renamed", phone: "(416) 555-1001", source: "other", consentBasis: "referral",
    });
    expect(byPhone.created).toBe(false);
  });

  it("enforces status transitions", () => {
    const l = add(1);
    expect(() => ledger.setStatus(l.id, "paid")).toThrow(/Cannot move/);
    ledger.setStatus(l.id, "contacted");
    ledger.setStatus(l.id, "replied");
    ledger.setStatus(l.id, "trial");
    expect(ledger.setStatus(l.id, "paid").status).toBe("paid");
  });

  it("treats do_not_contact as terminal", () => {
    const l = add(1);
    ledger.setStatus(l.id, "do_not_contact");
    expect(() => ledger.setStatus(l.id, "contacted")).toThrow(/Cannot move/);
    expect(() => ledger.recordSent(l.id, "email")).toThrow(/do_not_contact/);
  });

  it("recordSent moves found to contacted once", () => {
    const l = add(1);
    expect(ledger.recordSent(l.id, "email").status).toBe("contacted");
    expect(ledger.recordSent(l.id, "sms").status).toBe("contacted");
  });

  it("lists by score and filters", () => {
    add(1, { signals: { soloOrSmallTeam: true } });
    add(2, { signals: { soloOrSmallTeam: true, recentActivity: true } });
    add(3);
    const all = ledger.listLeads();
    expect(all.map((l) => l.name)).toEqual(["Agent 2", "Agent 1", "Agent 3"]);
    expect(ledger.listLeads({ minScore: 40 })).toHaveLength(1);
    expect(ledger.listLeads({ status: "paid" })).toHaveLength(0);
  });

  it("rejects non-positive costs", () => {
    const l = add(1);
    expect(() => ledger.recordCost(l.id, 0)).toThrow();
    expect(() => ledger.recordCost(l.id, 1.5)).toThrow();
  });
});

describe("drafts", () => {
  it("includes identity, address, demo line and an opt-out in email", () => {
    const d = draftEmail(add(1, { brokerage: "RE/MAX" }), cfg);
    expect(d.subject).toBeTruthy();
    expect(d.body).toContain("Hi Agent,");
    expect(d.body).toContain("1 Example St, Toronto, ON");
    expect(d.body).toContain("+1 647 930-6606");
    expect(d.body).toContain("RE/MAX");
    expect(d.body.toLowerCase()).toContain("unsubscribe");
  });

  it("greets by first name for both name orders", () => {
    expect(firstName("Sam Lee")).toBe("Sam");
    expect(firstName("Lee, Sam")).toBe("Sam");
    expect(firstName("  Sam  ")).toBe("Sam");
    const d = draftEmail(add(9, { name: "Lee, Sam" }), cfg);
    expect(d.body).toContain("Hi Sam,");
    expect(d.body).not.toContain(",,");
  });

  it("includes identity and STOP in sms", () => {
    const d = draftSms(add(1), cfg);
    expect(d.body).toContain("Alex Smith");
    expect(d.body).toContain("STOP");
  });

  it("makes no unverified performance claims", () => {
    const d = draftEmail(add(1), cfg).body + draftSms(add(2), cfg).body;
    expect(d).not.toMatch(/\d+\s*%|\dx\b|guarantee/i);
  });

  it("refuses do_not_contact leads and missing contact/config", () => {
    const l = add(1);
    ledger.setStatus(l.id, "do_not_contact");
    expect(() => draftEmail(ledger.getLead(l.id)!, cfg)).toThrow(/do_not_contact/);
    const phoneOnly = ledger.addLead({ name: "P", phone: "4165559999", source: "s", consentBasis: "referral" }).lead;
    expect(() => draftEmail(phoneOnly, cfg)).toThrow(/no email/);
    const emailOnly = ledger.addLead({ name: "E", email: "e@e.com", source: "s", consentBasis: "referral" }).lead;
    expect(() => draftSms(emailOnly, cfg)).toThrow(/no phone/);
    expect(() => draftEmail(add(5), { ...cfg, mailingAddress: "" })).toThrow(/mailingAddress/);
  });
});

describe("funnel", () => {
  it("is empty and null-safe with no leads", () => {
    const r = buildFunnelReport(db);
    expect(r.totalLeads).toBe(0);
    expect(r.rates.contactedToReplied).toBeNull();
    expect(r.costPerPaidCents).toBeNull();
    expect(r.warnings[0]).toMatch(/need about 100/);
  });

  it("counts stages, cost, revenue and payback", () => {
    const [a, b, c] = [add(1), add(2), add(3)];
    for (const l of [a, b, c]) ledger.recordSent(l.id, "email");
    ledger.setStatus(a.id, "replied");
    ledger.setStatus(b.id, "replied");
    ledger.setStatus(a.id, "trial");
    ledger.setStatus(a.id, "paid");
    ledger.recordCost(a.id, 3000, "tooling");

    const r = buildFunnelReport(db, { costToServeCents: 2000 });
    expect(r.reached).toEqual({ found: 3, contacted: 3, replied: 2, trial: 1, paid: 1 });
    expect(r.rates.contactedToReplied).toBeCloseTo(2 / 3);
    expect(r.rates.trialToPaid).toBe(1);
    expect(r.currentPaid).toBe(1);
    expect(r.mrrCents).toBe(5900);
    expect(r.totalCostCents).toBe(3000);
    expect(r.costPerPaidCents).toBe(3000);
    expect(r.marginPerCustomerCents).toBe(3900);
    expect(r.paybackMonths).toBeCloseTo(3000 / 3900);
  });

  it("keeps churned customers in 'ever paid' but out of MRR", () => {
    const a = add(1);
    ledger.recordSent(a.id, "email");
    ledger.setStatus(a.id, "trial");
    ledger.setStatus(a.id, "paid");
    ledger.setStatus(a.id, "lost");
    const r = buildFunnelReport(db);
    expect(r.reached.paid).toBe(1);
    expect(r.currentPaid).toBe(0);
    expect(r.mrrCents).toBe(0);
  });

  it("warns when cost to serve exceeds price", () => {
    const r = buildFunnelReport(db, { costToServeCents: 6000 });
    expect(r.warnings.join(" ")).toMatch(/loses money/);
  });
});

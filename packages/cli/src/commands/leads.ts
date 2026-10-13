/**
 * automaton-cli leads <subcommand>
 *
 * Lead ledger for the Atomic Pillar realtor outreach. Drafts are for a human
 * to copy and send; nothing here sends a message.
 *
 *   leads add --name N [--email E] [--phone P] --source S --consent BASIS [flags]
 *   leads import <file.csv>
 *   leads list [--status S] [--min-score N] [--limit N]
 *   leads draft <id> --channel email|sms
 *   leads sent <id> --channel email|sms|call|other
 *   leads mark <id> <status> [--note TEXT]
 *   leads cost <id> <dollars> [--note TEXT]
 *   leads report [--cost-to-serve DOLLARS]
 */

import chalk from "chalk";
import fs from "fs";
import path from "path";
import { loadConfig, resolvePath } from "@conway/automaton/config.js";
import { createDatabase } from "@conway/automaton/state/database.js";
import { LeadLedger } from "@conway/automaton/leads/ledger.js";
import { draftEmail, draftSms, type SenderConfig } from "@conway/automaton/leads/drafts.js";
import { buildFunnelReport } from "@conway/automaton/leads/funnel.js";
import { scoreLead } from "@conway/automaton/leads/scoring.js";
import {
  CONSENT_BASES,
  LEAD_STATUSES,
  type ConsentBasis,
  type LeadChannel,
  type LeadSignals,
  type LeadStatus,
} from "@conway/automaton/leads/types.js";

const SIGNAL_KEYS: (keyof LeadSignals)[] = [
  "soloOrSmallTeam",
  "mobileContact",
  "noChatOrBooking",
  "recentActivity",
  "slowReplyMentions",
  "hasIsaOrCallCentre",
  "inTargetArea",
];

const SENDER_PATH = path.join(process.env.HOME || "/root", ".automaton", "leads-sender.json");

// ─── Arg parsing ──────────────────────────────────────────────

const argv = process.argv.slice(3);
const sub = argv[0];
const positional: string[] = [];
const flags = new Map<string, string>();
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith("--")) {
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) flags.set(key, "true");
    else {
      flags.set(key, next);
      i++;
    }
  } else positional.push(a);
}

function fail(msg: string): never {
  console.error(chalk.red(msg));
  process.exit(1);
}

function pickStatus(s: string | undefined): LeadStatus {
  if (!s || !(LEAD_STATUSES as readonly string[]).includes(s)) {
    fail(`Status must be one of: ${LEAD_STATUSES.join(", ")}`);
  }
  return s as LeadStatus;
}

function pickConsent(s: string | undefined): ConsentBasis {
  if (!s || !(CONSENT_BASES as readonly string[]).includes(s)) {
    fail(`Consent basis must be one of: ${CONSENT_BASES.join(", ")}`);
  }
  return s as ConsentBasis;
}

function pickChannel(s: string | undefined, allowed: LeadChannel[]): LeadChannel {
  if (!s || !allowed.includes(s as LeadChannel)) fail(`--channel must be one of: ${allowed.join(", ")}`);
  return s as LeadChannel;
}

function dollarsToCents(s: string | undefined, label: string): number {
  const n = Number(s);
  if (!s || !Number.isFinite(n) || n <= 0) fail(`${label} must be a positive dollar amount`);
  return Math.round(n * 100);
}

function loadSender(): SenderConfig {
  if (!fs.existsSync(SENDER_PATH)) {
    fail(
      `No sender profile at ${SENDER_PATH}. Create it with:\n` +
        JSON.stringify(
          {
            senderName: "Your Name",
            businessName: "Atomic Pillar",
            mailingAddress: "Street, City, Province, Postal Code",
            contactPhone: "+1 ...",
            contactEmail: "you@example.com",
          },
          null,
          2,
        ),
    );
  }
  return JSON.parse(fs.readFileSync(SENDER_PATH, "utf-8")) as SenderConfig;
}

/** Minimal RFC 4180 CSV parser (quotes, escaped quotes, CRLF). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== "")) rows.push(row);
  return rows;
}

function truthy(v: string | undefined): boolean | undefined {
  if (v === undefined || v.trim() === "") return undefined;
  return ["true", "yes", "y", "1"].includes(v.trim().toLowerCase());
}

// ─── Run ──────────────────────────────────────────────────────

const config = loadConfig();
if (!config) fail("No automaton configuration found.");
const database = createDatabase(resolvePath(config.dbPath));
const ledger = new LeadLedger(database.raw);

const fmt$ = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const fmtPct = (r: number | null) => (r === null ? "n/a" : `${(r * 100).toFixed(1)}%`);

switch (sub) {
  case "add": {
    const signals: LeadSignals = {};
    for (const k of SIGNAL_KEYS) if (flags.has(k)) signals[k] = flags.get(k) !== "false";
    const { lead, created } = ledger.addLead({
      name: flags.get("name") ?? "",
      brokerage: flags.get("brokerage"),
      city: flags.get("city"),
      phone: flags.get("phone"),
      email: flags.get("email"),
      website: flags.get("website"),
      source: flags.get("source") ?? "",
      consentBasis: pickConsent(flags.get("consent")),
      signals,
      notes: flags.get("note"),
    });
    console.log(created ? chalk.green("Added") : chalk.yellow("Already exists"), lead.id, lead.name, `score ${lead.fitScore}`);
    break;
  }

  case "import": {
    const file = positional[0];
    if (!file || !fs.existsSync(file)) fail("Usage: leads import <file.csv>");
    const rows = parseCsv(fs.readFileSync(file, "utf-8"));
    const header = rows.shift()?.map((h) => h.trim().toLowerCase());
    if (!header) fail("CSV is empty");
    const col = (r: string[], name: string) => {
      const idx = header.indexOf(name.toLowerCase());
      return idx >= 0 ? r[idx]?.trim() || undefined : undefined;
    };
    let added = 0, dupes = 0, errors = 0;
    rows.forEach((r, i) => {
      try {
        const signals: LeadSignals = {};
        for (const k of SIGNAL_KEYS) {
          const v = truthy(col(r, k));
          if (v !== undefined) signals[k] = v;
        }
        const { created } = ledger.addLead({
          name: col(r, "name") ?? "",
          brokerage: col(r, "brokerage"),
          city: col(r, "city"),
          phone: col(r, "phone"),
          email: col(r, "email"),
          website: col(r, "website"),
          source: col(r, "source") ?? "",
          consentBasis: pickConsent(col(r, "consent_basis")),
          signals,
          notes: col(r, "notes"),
        });
        created ? added++ : dupes++;
      } catch (err) {
        errors++;
        console.error(chalk.red(`Row ${i + 2}: ${(err as Error).message}`));
      }
    });
    console.log(`Imported: ${chalk.green(added)} added, ${chalk.yellow(dupes)} duplicates, ${chalk.red(errors)} errors`);
    break;
  }

  case "list": {
    const status = flags.has("status") ? pickStatus(flags.get("status")) : undefined;
    const leads = ledger.listLeads({
      status,
      minScore: flags.has("min-score") ? Number(flags.get("min-score")) : undefined,
      limit: flags.has("limit") ? Number(flags.get("limit")) : 50,
    });
    if (leads.length === 0) console.log(chalk.dim("No leads match."));
    for (const l of leads) {
      const why = scoreLead(l.signals).reasons.join(", ");
      console.log(
        `${chalk.dim(l.id)} ${String(l.fitScore).padStart(3)}  ${l.status.padEnd(14)} ${l.name}` +
          `${l.brokerage ? ` (${l.brokerage})` : ""}  ${chalk.dim(why)}`,
      );
    }
    break;
  }

  case "draft": {
    const id = positional[0];
    const lead = id ? ledger.getLead(id) : undefined;
    if (!lead) fail("Usage: leads draft <id> --channel email|sms (lead not found)");
    const channel = pickChannel(flags.get("channel"), ["email", "sms"]);
    const sender = loadSender();
    const draft = channel === "email" ? draftEmail(lead, sender) : draftSms(lead, sender);
    ledger.recordDraft(lead.id, channel);
    console.log(chalk.dim(`To: ${channel === "email" ? lead.email : lead.phone}`));
    if (draft.subject) console.log(chalk.dim(`Subject: ${draft.subject}`));
    console.log("\n" + draft.body + "\n");
    console.log(chalk.dim(`After you send it, run: leads sent ${lead.id} --channel ${channel}`));
    break;
  }

  case "sent": {
    const id = positional[0];
    if (!id) fail("Usage: leads sent <id> --channel email|sms|call|other");
    const lead = ledger.recordSent(id, pickChannel(flags.get("channel"), ["email", "sms", "call", "other"]), flags.get("note"));
    console.log(chalk.green(`${lead.name} -> ${lead.status}`));
    break;
  }

  case "mark": {
    const [id, status] = positional;
    if (!id || !status) fail("Usage: leads mark <id> <status> [--note TEXT]");
    const lead = ledger.setStatus(id, pickStatus(status), { detail: flags.get("note") });
    console.log(chalk.green(`${lead.name} -> ${lead.status}`));
    break;
  }

  case "cost": {
    const [id, dollars] = positional;
    if (!id) fail("Usage: leads cost <id> <dollars> [--note TEXT]");
    ledger.recordCost(id, dollarsToCents(dollars, "amount"), flags.get("note"));
    console.log(chalk.green(`Recorded ${fmt$(dollarsToCents(dollars, "amount"))}`));
    break;
  }

  case "report": {
    const r = buildFunnelReport(database.raw, {
      costToServeCents: flags.has("cost-to-serve") ? dollarsToCents(flags.get("cost-to-serve"), "--cost-to-serve") : undefined,
    });
    console.log(chalk.bold("\nAtomic Pillar realtor funnel"));
    console.log(`Leads found      ${r.reached.found}`);
    console.log(`Contacted        ${r.reached.contacted}`);
    console.log(`Replied          ${r.reached.replied}   (${fmtPct(r.rates.contactedToReplied)} of contacted)`);
    console.log(`Trial            ${r.reached.trial}   (${fmtPct(r.rates.repliedToTrial)} of replied)`);
    console.log(`Paid (ever)      ${r.reached.paid}   (${fmtPct(r.rates.trialToPaid)} of trials, ${fmtPct(r.rates.contactedToPaid)} of contacted)`);
    console.log(`Do not contact   ${r.doNotContact}`);
    console.log(`\nPaying now       ${r.currentPaid}   MRR ${fmt$(r.mrrCents)}`);
    console.log(`Spend            ${fmt$(r.totalCostCents)}   cost per paid ${r.costPerPaidCents === null ? "n/a" : fmt$(r.costPerPaidCents)}`);
    if (r.marginPerCustomerCents !== null) {
      console.log(`Margin/customer  ${fmt$(r.marginPerCustomerCents)}/mo   payback ${r.paybackMonths === null ? "n/a" : `${r.paybackMonths.toFixed(1)} mo`}`);
    }
    for (const w of r.warnings) console.log(chalk.yellow(`! ${w}`));
    console.log();
    break;
  }

  default:
    console.log(`
Usage: automaton-cli leads <subcommand>

  add --name N [--email E] [--phone P] --source S --consent BASIS [--brokerage B] [--city C] [--<signal>]
  import <file.csv>              columns: name,email,phone,brokerage,city,website,source,consent_basis,<signals>
  list [--status S] [--min-score N] [--limit N]
  draft <id> --channel email|sms
  sent <id> --channel email|sms|call|other
  mark <id> <status> [--note TEXT]
  cost <id> <dollars> [--note TEXT]
  report [--cost-to-serve DOLLARS]

Consent bases: ${CONSENT_BASES.join(", ")}
Statuses:      ${LEAD_STATUSES.join(", ")}
Signals:       ${SIGNAL_KEYS.join(", ")}
Sender profile: ${SENDER_PATH}
`);
}

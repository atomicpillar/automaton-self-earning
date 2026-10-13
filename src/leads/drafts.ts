/**
 * Outreach drafts.
 *
 * Produces plain, honest copy-paste messages for a human to send. Nothing
 * here sends anything. No performance claims are made; the pitch is
 * "call the demo line and judge for yourself".
 */

import type { Lead } from "./types.js";

export const DEMO_PHONE = "+1 647 930-6606";

export interface SenderConfig {
  /** Person the message is sent from, e.g. "Alex Smith". */
  senderName: string;
  /** Business sending the message, e.g. "Atomic Pillar". */
  businessName: string;
  /** Physical mailing address (CASL requires it on email). */
  mailingAddress: string;
  /** How the recipient can reach the sender. */
  contactPhone: string;
  contactEmail: string;
  trialDays?: number;
  demoPhone?: string;
}

export interface Draft {
  channel: "email" | "sms";
  subject?: string;
  body: string;
}

/** First name for the greeting; handles "Last, First" as well as "First Last". */
export function firstName(name: string): string {
  const trimmed = name.trim();
  const [beforeComma, afterComma] = trimmed.split(",", 2).map((p) => p.trim());
  const source = afterComma ? afterComma : beforeComma;
  return source.split(/\s+/)[0] || trimmed;
}

function requireConfig(c: SenderConfig, fields: (keyof SenderConfig)[]): void {
  for (const f of fields) {
    if (!String(c[f] ?? "").trim()) throw new Error(`Sender config is missing ${f}`);
  }
}

function assertContactable(lead: Lead): void {
  if (lead.status === "do_not_contact") {
    throw new Error(`Lead ${lead.id} is marked do_not_contact; no draft produced`);
  }
}

export function draftEmail(lead: Lead, cfg: SenderConfig): Draft {
  assertContactable(lead);
  if (!lead.email) throw new Error(`Lead ${lead.id} has no email address`);
  requireConfig(cfg, ["senderName", "businessName", "mailingAddress", "contactPhone", "contactEmail"]);

  const demo = cfg.demoPhone ?? DEMO_PHONE;
  const trial = cfg.trialDays ?? 14;
  const where = lead.brokerage
    ? `your published ${lead.brokerage} contact details`
    : "your publicly listed business contact details";

  const body = [
    `Hi ${firstName(lead.name)},`,
    "",
    `I found ${where}, so I'm writing about your business directly.`,
    "",
    `${cfg.businessName} makes an AI receptionist for GTA realtors. It answers calls and texts when you can't, asks a few qualifying questions, and books appointments on your calendar.`,
    "",
    `The easiest way to judge it is to call ${demo} and talk to it like a buyer would. There's also a ${trial}-day free trial if it looks useful.`,
    "",
    "If this isn't relevant, just reply \"no\" and I won't contact you again.",
    "",
    `${cfg.senderName}`,
    `${cfg.businessName}`,
    `${cfg.mailingAddress}`,
    `${cfg.contactPhone} | ${cfg.contactEmail}`,
    "",
    "To stop receiving messages from us, reply with \"unsubscribe\".",
  ].join("\n");

  return {
    channel: "email",
    subject: "A quick test: what happens when a buyer calls after hours?",
    body,
  };
}

export function draftSms(lead: Lead, cfg: SenderConfig): Draft {
  assertContactable(lead);
  if (!lead.phone) throw new Error(`Lead ${lead.id} has no phone number`);
  requireConfig(cfg, ["senderName", "businessName", "contactPhone"]);

  const demo = cfg.demoPhone ?? DEMO_PHONE;
  const trial = cfg.trialDays ?? 14;

  const body =
    `Hi ${firstName(lead.name)}, it's ${cfg.senderName} from ${cfg.businessName}. ` +
    `We make an AI receptionist for GTA realtors that answers missed calls and books appointments. ` +
    `Call ${demo} to try it as a buyer would; free ${trial}-day trial if useful. ` +
    `Reply STOP and I won't message again.`;

  return { channel: "sms", body };
}

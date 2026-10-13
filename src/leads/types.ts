/**
 * Lead Ledger Types
 *
 * Tracks outbound prospects for the Atomic Pillar realtor SaaS.
 */

export const LEAD_STATUSES = [
  "found",
  "contacted",
  "replied",
  "trial",
  "paid",
  "lost",
  "do_not_contact",
] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

/** CASL basis for messaging this person. Must be recorded for every lead. */
export const CONSENT_BASES = [
  "conspicuous_publication",
  "express_consent",
  "existing_relationship",
  "referral",
] as const;
export type ConsentBasis = (typeof CONSENT_BASES)[number];

export type LeadChannel = "email" | "sms" | "call" | "other";

/**
 * Fit signals observed about a lead. Every field is optional: `undefined`
 * means "not checked", which scores neutrally (zero), never as a match.
 */
export interface LeadSignals {
  /** Solo agent or small team (no dedicated lead desk). */
  soloOrSmallTeam?: boolean;
  /** Mobile number is the primary published contact. */
  mobileContact?: boolean;
  /** Website has NO chat widget or booking link (true = missing). */
  noChatOrBooking?: boolean;
  /** Listings or sales within the last 90 days. */
  recentActivity?: boolean;
  /** Reviews or posts mention slow replies / hard to reach. */
  slowReplyMentions?: boolean;
  /** Has an ISA, call centre, or receptionist (disqualifying). */
  hasIsaOrCallCentre?: boolean;
  /** Inside the target geography (GTA). */
  inTargetArea?: boolean;
}

export interface Lead {
  id: string;
  name: string;
  brokerage: string | null;
  city: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  source: string;
  consentBasis: ConsentBasis;
  signals: LeadSignals;
  fitScore: number;
  status: LeadStatus;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NewLeadInput {
  name: string;
  brokerage?: string;
  city?: string;
  phone?: string;
  email?: string;
  website?: string;
  source: string;
  consentBasis: ConsentBasis;
  signals?: LeadSignals;
  notes?: string;
}

export interface LeadFilter {
  status?: LeadStatus;
  minScore?: number;
  limit?: number;
}

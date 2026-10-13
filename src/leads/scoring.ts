/**
 * Lead fit scoring.
 *
 * A transparent, additive proxy for "this realtor probably misses calls and
 * has no one to answer them". It scores only observed signals; unknown
 * signals add nothing. A lead with an ISA / call centre is capped because
 * they are unlikely to need a $59/mo AI receptionist.
 */

import type { LeadSignals } from "./types.js";

interface Rule {
  key: keyof LeadSignals;
  points: number;
  reason: string;
}

const RULES: Rule[] = [
  { key: "soloOrSmallTeam", points: 25, reason: "solo or small team" },
  { key: "recentActivity", points: 20, reason: "active in the last 90 days" },
  { key: "mobileContact", points: 15, reason: "mobile is the main contact" },
  { key: "noChatOrBooking", points: 15, reason: "no chat or booking link on site" },
  { key: "slowReplyMentions", points: 15, reason: "slow-reply mentions in reviews/posts" },
  { key: "inTargetArea", points: 10, reason: "in target area" },
];

export const ISA_SCORE_CAP = 20;

export interface ScoreResult {
  score: number;
  reasons: string[];
}

export function scoreLead(signals: LeadSignals): ScoreResult {
  let score = 0;
  const reasons: string[] = [];

  for (const rule of RULES) {
    if (signals[rule.key] === true) {
      score += rule.points;
      reasons.push(rule.reason);
    }
  }

  if (signals.hasIsaOrCallCentre === true) {
    score = Math.min(score, ISA_SCORE_CAP);
    reasons.push(`has ISA/call centre (capped at ${ISA_SCORE_CAP})`);
  }

  return { score: Math.max(0, Math.min(100, score)), reasons };
}

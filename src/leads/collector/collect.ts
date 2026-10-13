/**
 * Collector orchestrator.
 *
 * Pulls candidate agent pages from several networks in round-robin order,
 * parses what each agent has published, keeps GTA agents we could actually
 * contact, optionally checks their own website for a chat/booking widget,
 * and returns rows ready for `leads import`.
 */

import { discover, shuffle, type SourceName, ALL_SOURCES } from "./discovery.js";
import type { PoliteFetcher } from "./fetcher.js";
import {
  analyzeSite,
  isGtaCity,
  parseAgentPage,
  type CollectedAgent,
} from "./parsers.js";
import type { LeadSignals } from "../types.js";

export interface CollectOptions {
  fetcher: PoliteFetcher;
  sources?: SourceName[];
  /** Extra agent/site URLs found elsewhere (e.g. via search); parsed generically. */
  seedUrls?: string[];
  /** Stop once this many contactable GTA agents are collected. */
  target: number;
  /** Check each agent's own website for a chat widget or booking link. */
  checkSites?: boolean;
  /** Drop agents whose brokerage matches this pattern. */
  excludeBrokerage?: RegExp;
  rng?: () => number;
  log?: (msg: string) => void;
}

export interface CollectedLead {
  agent: CollectedAgent;
  signals: LeadSignals;
}

export interface CollectStats {
  pagesFetched: number;
  parsed: number;
  notGta: number;
  noContact: number;
  excluded: number;
  collected: number;
  failures: Record<string, number>;
  byNetwork: Record<string, number>;
  requestsUsed: number;
}

export function buildSignals(agent: CollectedAgent, siteCheck: { hasChat: boolean; hasBooking: boolean } | "none" | "unknown"): LeadSignals {
  const signals: LeadSignals = { inTargetArea: true };
  if (agent.mobile) signals.mobileContact = true;
  if (siteCheck === "none") signals.noChatOrBooking = true; // no website of their own
  else if (siteCheck !== "unknown") signals.noChatOrBooking = !siteCheck.hasChat && !siteCheck.hasBooking;
  return signals;
}

export async function collect(opts: CollectOptions): Promise<{ leads: CollectedLead[]; stats: CollectStats }> {
  const log = opts.log ?? (() => {});
  const rng = opts.rng ?? Math.random;
  const stats: CollectStats = {
    pagesFetched: 0, parsed: 0, notGta: 0, noContact: 0, excluded: 0, collected: 0,
    failures: {}, byNetwork: {}, requestsUsed: 0,
  };
  const leads: CollectedLead[] = [];
  const seen = new Set<string>();

  const queues: string[][] = [];
  if (opts.seedUrls?.length) queues.push(opts.seedUrls.slice());
  for (const source of opts.sources ?? ALL_SOURCES) {
    const urls = shuffle(await discover(source, opts.fetcher, rng), rng);
    log(`${source}: ${urls.length} candidate pages`);
    queues.push(urls);
  }

  const fail = (reason: string) => {
    stats.failures[reason] = (stats.failures[reason] ?? 0) + 1;
  };

  let i = 0;
  while (leads.length < opts.target && queues.some((q) => q.length > 0) && opts.fetcher.budgetLeft > 0) {
    const queue = queues[i++ % queues.length];
    const url = queue.shift();
    if (!url || seen.has(url)) continue;
    seen.add(url);

    const page = await opts.fetcher.get(url);
    if (!page.ok) {
      fail(page.reason);
      continue;
    }
    stats.pagesFetched++;

    const agent = parseAgentPage(page.body, url);
    if (!agent) {
      fail("unparsed");
      continue;
    }
    stats.parsed++;

    if (!isGtaCity(agent.city)) {
      stats.notGta++;
      continue;
    }
    if (!agent.email && !agent.mobile) {
      stats.noContact++;
      continue;
    }
    if (opts.excludeBrokerage && agent.brokerage && opts.excludeBrokerage.test(agent.brokerage)) {
      stats.excluded++;
      continue;
    }

    let site: { hasChat: boolean; hasBooking: boolean } | "none" | "unknown" = "unknown";
    if (opts.checkSites) {
      if (!agent.website) site = "none";
      else {
        const res = await opts.fetcher.get(agent.website);
        if (res.ok) site = analyzeSite(res.body);
        else fail(`site_${res.reason}`);
      }
    }

    leads.push({ agent, signals: buildSignals(agent, site) });
    stats.collected++;
    stats.byNetwork[agent.network] = (stats.byNetwork[agent.network] ?? 0) + 1;
    if (leads.length % 10 === 0) log(`${leads.length}/${opts.target} collected (${opts.fetcher.requestsMade} requests)`);
  }

  stats.requestsUsed = opts.fetcher.requestsMade;
  return { leads, stats };
}

// ─── CSV for `leads import` ─────────────────────────────────────

const SIGNAL_COLUMNS = [
  "soloOrSmallTeam", "mobileContact", "noChatOrBooking", "recentActivity",
  "slowReplyMentions", "hasIsaOrCallCentre", "inTargetArea",
] as const;

function csvCell(v: string | null | undefined): string {
  const s = v ?? "";
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function leadsToCsv(leads: CollectedLead[]): string {
  const header = [
    "name", "email", "phone", "brokerage", "city", "website", "source",
    "consent_basis", "notes", ...SIGNAL_COLUMNS,
  ];
  const rows = leads.map(({ agent, signals }) => [
    agent.name,
    agent.email,
    agent.mobile, // labelled mobile only: never an office line
    agent.brokerage,
    agent.city,
    agent.website,
    agent.sourceUrl,
    "conspicuous_publication",
    [`network: ${agent.network}`, ...agent.notes].join("; "),
    ...SIGNAL_COLUMNS.map((k) => (signals[k] === undefined ? "" : signals[k] ? "yes" : "no")),
  ]);
  return [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\n") + "\n";
}

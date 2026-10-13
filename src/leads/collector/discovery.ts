/**
 * Candidate discovery.
 *
 * Agent profile URLs come from each network's own published sitemaps, which
 * robots.txt points crawlers to. Royal LePage URLs carry the city, so they
 * can be filtered to the GTA before any page is fetched.
 */

import type { PoliteFetcher } from "./fetcher.js";
import { isGtaCity } from "./parsers.js";

export type SourceName = "remax" | "c21" | "royallepage";
export const ALL_SOURCES: SourceName[] = ["royallepage", "c21", "remax"];

export function extractLocs(xml: string): string[] {
  return [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/g)].map((m) => m[1].replace(/&amp;/g, "&"));
}

export function shuffle<T>(items: T[], rng: () => number = Math.random): T[] {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function locsOf(fetcher: PoliteFetcher, url: string): Promise<string[]> {
  const res = await fetcher.get(url);
  return res.ok ? extractLocs(res.body) : [];
}

/** All Ontario RE/MAX agent profile URLs (the city is only known after fetching). */
export async function discoverRemax(fetcher: PoliteFetcher): Promise<string[]> {
  const index = await locsOf(fetcher, "https://www.remax.ca/sitemaps/ci/agent_sitemaps_index.xml");
  const urls: string[] = [];
  for (const sm of index.slice(0, 3)) urls.push(...(await locsOf(fetcher, sm)));
  return urls.filter((u) => /^https:\/\/www\.remax\.ca\/on\/[^/]+-ag$/.test(u));
}

/** Century 21 agents, nationwide (the city is only known after fetching). */
export async function discoverC21(
  fetcher: PoliteFetcher,
  rng: () => number = Math.random,
  files = 8,
): Promise<string[]> {
  const root = await locsOf(fetcher, "https://www.c21.ca/sitemap.xml");
  const agentMaps = shuffle(root.filter((u) => /sitemap-agents-\d+\.xml$/.test(u)), rng).slice(0, files);
  const urls: string[] = [];
  for (const sm of agentMaps) urls.push(...(await locsOf(fetcher, sm)));
  return urls.filter((u) => /\/directory\/agents\/[^/]+$/.test(u));
}

/** Royal LePage agents: the Ontario sitemap, filtered to GTA cities by URL path. */
export async function discoverRoyalLepage(fetcher: PoliteFetcher): Promise<string[]> {
  const index = await locsOf(fetcher, "https://www.royallepage.ca/sitemap/sitemap-en-agents-index.xml");
  const ontario = index.filter((u) => /sitemap-en-agents-on\.xml$/.test(u));
  const urls: string[] = [];
  for (const sm of ontario) urls.push(...(await locsOf(fetcher, sm)));
  return urls.filter((u) => {
    const m = /\/en\/agent\/ontario\/([a-z-]+)\//.exec(u);
    return !!m && isGtaCity(m[1].replace(/-/g, " "));
  });
}

export async function discover(
  source: SourceName,
  fetcher: PoliteFetcher,
  rng: () => number = Math.random,
): Promise<string[]> {
  switch (source) {
    case "remax":
      return discoverRemax(fetcher);
    case "c21":
      return discoverC21(fetcher, rng);
    case "royallepage":
      return discoverRoyalLepage(fetcher);
  }
}

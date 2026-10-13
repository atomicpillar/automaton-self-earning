/**
 * Polite fetcher.
 *
 * Identifies itself, honours robots.txt for every host (refusing the URL if
 * robots.txt cannot be read), waits between requests to the same host
 * (never less than the host's Crawl-delay), caches bodies on disk, and
 * caps the number of network requests. It does not retry blocked requests
 * or attempt to get around a block.
 */

import crypto from "crypto";
import fs from "fs";
import path from "path";
import { isAllowed, parseRobots, type RobotsRules } from "./robots.js";

export const COLLECTOR_USER_AGENT =
  "Mozilla/5.0 (compatible; AtomicPillarBot/0.1; +https://atomicpillar.com)";

export type FetchOutcome =
  | { ok: true; body: string; fromCache: boolean }
  | { ok: false; reason: "robots" | "http" | "network" | "budget" | "not_html"; detail?: string };

export interface FetcherOptions {
  cacheDir: string;
  /** Minimum delay between requests to one host. */
  delayMs?: number;
  /** Maximum network requests (cache hits are free). */
  maxRequests?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export class PoliteFetcher {
  private readonly delayMs: number;
  private readonly maxRequests: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly robotsByHost = new Map<string, RobotsRules | null>();
  private readonly lastRequestAt = new Map<string, number>();
  requestsMade = 0;

  constructor(private readonly opts: FetcherOptions) {
    this.delayMs = opts.delayMs ?? 2000;
    this.maxRequests = opts.maxRequests ?? 300;
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now ?? Date.now;
    fs.mkdirSync(opts.cacheDir, { recursive: true });
  }

  get budgetLeft(): number {
    return this.maxRequests - this.requestsMade;
  }

  async get(rawUrl: string): Promise<FetchOutcome> {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return { ok: false, reason: "network", detail: "invalid url" };
    }
    if (url.protocol !== "https:") {
      return { ok: false, reason: "network", detail: "https only" };
    }

    const cachePath = path.join(
      this.opts.cacheDir,
      crypto.createHash("sha1").update(url.href).digest("hex") + ".txt",
    );
    if (fs.existsSync(cachePath)) {
      return { ok: true, body: fs.readFileSync(cachePath, "utf-8"), fromCache: true };
    }

    const robots = await this.robotsFor(url);
    if (robots === null) return { ok: false, reason: "robots", detail: "robots.txt unreadable" };
    if (!isAllowed(robots, url.pathname + url.search)) {
      return { ok: false, reason: "robots", detail: "disallowed by robots.txt" };
    }

    const res = await this.politeRequest(url, robots);
    if (!res.ok) return res;
    fs.writeFileSync(cachePath, res.body);
    return { ok: true, body: res.body, fromCache: false };
  }

  private async robotsFor(url: URL): Promise<RobotsRules | null> {
    const host = url.host;
    if (this.robotsByHost.has(host)) return this.robotsByHost.get(host) ?? null;

    const robotsUrl = new URL("/robots.txt", url);
    let rules: RobotsRules | null = null;
    // robots.txt is fetched with the same budget and pacing as everything else.
    const res = await this.politeRequest(robotsUrl, { rules: [], crawlDelaySeconds: null }, true);
    if (res.ok) {
      rules = parseRobots(res.body, COLLECTOR_USER_AGENT);
    } else if (res.reason === "http" && res.detail === "404") {
      rules = { rules: [], crawlDelaySeconds: null }; // no robots.txt: nothing is disallowed
    }
    this.robotsByHost.set(host, rules);
    return rules;
  }

  private async politeRequest(
    url: URL,
    robots: RobotsRules,
    isRobotsTxt = false,
  ): Promise<{ ok: true; body: string } | Extract<FetchOutcome, { ok: false }>> {
    if (this.requestsMade >= this.maxRequests) return { ok: false, reason: "budget" };

    const gap = Math.max(this.delayMs, (robots.crawlDelaySeconds ?? 0) * 1000);
    const last = this.lastRequestAt.get(url.host);
    if (last !== undefined) {
      const wait = last + gap - this.now();
      if (wait > 0) await this.sleep(wait);
    }
    this.lastRequestAt.set(url.host, this.now());
    this.requestsMade++;

    try {
      const res = await this.fetchImpl(url.href, {
        headers: { "user-agent": COLLECTOR_USER_AGENT, accept: "text/html,application/xml,text/plain" },
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: "follow",
      });
      // A redirect to another host would skip that host's robots.txt check.
      if (res.url && new URL(res.url).host !== url.host) {
        return { ok: false, reason: "http", detail: "cross-host redirect refused" };
      }
      // A redirect to another host would skip that host's robots.txt check.
      if (res.url && new URL(res.url).host !== url.host) {
        return { ok: false, reason: "http", detail: "cross-host redirect refused" };
      }
      if (!res.ok) return { ok: false, reason: "http", detail: String(res.status) };
      const type = res.headers.get("content-type") ?? "";
      if (!isRobotsTxt && !/html|xml|text\//i.test(type)) {
        return { ok: false, reason: "not_html", detail: type };
      }
      return { ok: true, body: await res.text() };
    } catch (err) {
      return { ok: false, reason: "network", detail: (err as Error).message };
    }
  }
}

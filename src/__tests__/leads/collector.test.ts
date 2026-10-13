import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isAllowed, parseRobots } from "../../leads/collector/robots.js";
import { PoliteFetcher } from "../../leads/collector/fetcher.js";
import {
  analyzeSite,
  isGtaCity,
  parseAgentPage,
  parseC21,
  parseRemax,
  parseRoyalLepage,
} from "../../leads/collector/parsers.js";
import { buildSignals, collect, leadsToCsv } from "../../leads/collector/collect.js";
import { extractLocs, shuffle } from "../../leads/collector/discovery.js";

const UA = "AtomicPillarBot/0.1";

describe("robots", () => {
  const txt = `
User-agent: *
Disallow: /api/
Disallow: /*?page=*
Allow: /api/public
Crawl-delay: 3

User-agent: BadBot
Disallow: /
`;
  const rules = parseRobots(txt, UA);

  it("applies the * group and wildcard patterns", () => {
    expect(isAllowed(rules, "/on/some-agent")).toBe(true);
    expect(isAllowed(rules, "/api/private")).toBe(false);
    expect(isAllowed(rules, "/list?page=2")).toBe(false);
  });

  it("lets the longer Allow beat a shorter Disallow", () => {
    expect(isAllowed(rules, "/api/public/x")).toBe(true);
  });

  it("reads crawl-delay and ignores groups for other bots", () => {
    expect(rules.crawlDelaySeconds).toBe(3);
    expect(isAllowed(rules, "/anything")).toBe(true);
  });

  it("honours a group that names us specifically", () => {
    const r = parseRobots("User-agent: atomicpillarbot\nDisallow: /\n\nUser-agent: *\nAllow: /", UA);
    expect(isAllowed(r, "/x")).toBe(false);
  });

  it("treats an empty Disallow as allow-all and supports $", () => {
    const r = parseRobots("User-agent: *\nDisallow:\n", UA);
    expect(isAllowed(r, "/x")).toBe(true);
    const e = parseRobots("User-agent: *\nDisallow: /*.pdf$\n", UA);
    expect(isAllowed(e, "/a.pdf")).toBe(false);
    expect(isAllowed(e, "/a.pdf.html")).toBe(true);
  });
});

describe("fetcher", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fetcher-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  function fakeFetch(routes: Record<string, { status?: number; body?: string; url?: string }>, calls: string[] = []): typeof fetch {
    return (async (input: string | URL | Request) => {
      const u = String(input);
      calls.push(u);
      const r = routes[u];
      if (!r) return new Response("nf", { status: 404, headers: { "content-type": "text/plain" } });
      const res = new Response(r.body ?? "", { status: r.status ?? 200, headers: { "content-type": "text/html" } });
      if (r.url) Object.defineProperty(res, "url", { value: r.url });
      return res;
    }) as typeof fetch;
  }

  it("fetches allowed pages, caches them, and spaces requests", async () => {
    const calls: string[] = [];
    const sleeps: number[] = [];
    let t = 0;
    const f = new PoliteFetcher({
      cacheDir: dir, delayMs: 1000, maxRequests: 10,
      fetchImpl: fakeFetch({
        "https://a.test/robots.txt": { body: "User-agent: *\nDisallow: /private" },
        "https://a.test/ok": { body: "hello" },
      }, calls),
      sleep: async (ms) => { sleeps.push(ms); t += ms; },
      now: () => t,
    });
    const first = await f.get("https://a.test/ok");
    expect(first).toMatchObject({ ok: true, body: "hello", fromCache: false });
    const again = await f.get("https://a.test/ok");
    expect(again).toMatchObject({ ok: true, fromCache: true });
    expect(calls.filter((c) => c.endsWith("/ok"))).toHaveLength(1);
    expect(sleeps.some((ms) => ms > 0)).toBe(true); // robots.txt then page were spaced
  });

  it("refuses disallowed paths without requesting them", async () => {
    const calls: string[] = [];
    const f = new PoliteFetcher({
      cacheDir: dir, delayMs: 0,
      fetchImpl: fakeFetch({ "https://a.test/robots.txt": { body: "User-agent: *\nDisallow: /private" } }, calls),
    });
    const r = await f.get("https://a.test/private/x");
    expect(r).toMatchObject({ ok: false, reason: "robots" });
    expect(calls).not.toContain("https://a.test/private/x");
  });

  it("refuses when robots.txt cannot be read, but allows a missing (404) one", async () => {
    const blocked = new PoliteFetcher({
      cacheDir: dir, delayMs: 0,
      fetchImpl: fakeFetch({ "https://b.test/robots.txt": { status: 403 } }),
    });
    expect(await blocked.get("https://b.test/x")).toMatchObject({ ok: false, reason: "robots" });

    const none = new PoliteFetcher({
      cacheDir: fs.mkdtempSync(path.join(dir, "n-")), delayMs: 0,
      fetchImpl: fakeFetch({ "https://c.test/x": { body: "fine" } }),
    });
    expect(await none.get("https://c.test/x")).toMatchObject({ ok: true, body: "fine" });
  });

  it("refuses http URLs, cross-host redirects, and stops at the request budget", async () => {
    const f = new PoliteFetcher({
      cacheDir: dir, delayMs: 0, maxRequests: 2,
      fetchImpl: fakeFetch({
        "https://d.test/robots.txt": { body: "User-agent: *\nAllow: /" },
        "https://d.test/redir": { body: "x", url: "https://other.test/y" },
        "https://d.test/p": { body: "p" },
      }),
    });
    expect(await f.get("http://d.test/p")).toMatchObject({ ok: false });
    expect(await f.get("https://d.test/redir")).toMatchObject({ ok: false, detail: "cross-host redirect refused" });
    expect(await f.get("https://d.test/p")).toMatchObject({ ok: false, reason: "budget" });
  });
});

const REMAX_HTML = `<html><head><title>X</title>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"RealEstateAgent","name":"Pat Example","telephone":"(416) 555-0199","email":"pat@patexample.ca","subOrganization":"REMAX Example Realty Inc","address":{"@type":"PostalAddress","addressLocality":"Mississauga","addressRegion":"ON"}}</script>
</head><body><div>CONTACT ME</div><span>Website:</span> <a>www.patexample.ca</a> <span>Mobile:</span> <a>(416) 555-0199</a>
<p>7 Years Experience</p></body></html>`;

const C21_HTML = `<html><head><meta property="og:title" content="Sam Sample - CENTURY 21 Example Brokerage -  - CENTURY 21 Canada" /></head><body>
<div>CONTACT</div><div>Main</div><a>(905) 555-0100</a><div>Cell</div><a>(905) 555-0111</a><div>Office</div><a>(905) 555-0122</a>
<div>Email</div><a>sam.sample@century21.ca</a><div>Website</div><a>http://samsample.ca</a>
<div>Offices</div><div>CENTURY 21 Example Brokerage</div><div>1 Main Street</div><div>Brampton, ON L6Y1A1</div></body></html>`;

const RLP_HTML = `<html><head><title>   Lee Tester, Sales Representative , Royal LePage Example Realty | Royal LePage</title></head><body>
<p><span>Direct</span> <a>905.555.0130</a></p><p><span>Mobile</span> <a>647.555.0131</a></p><p><span>Toll Free</span> <a>888.555.0132</a></p></body></html>`;

describe("parsers", () => {
  it("parses RE/MAX JSON-LD and labelled mobile", () => {
    const a = parseRemax(REMAX_HTML, "https://www.remax.ca/on/pat-example-1-ag")!;
    expect(a).toMatchObject({
      network: "remax", name: "Pat Example", brokerage: "REMAX Example Realty Inc",
      city: "Mississauga", mobile: "(416) 555-0199", email: "pat@patexample.ca",
      website: "https://www.patexample.ca",
    });
    expect(a.notes[0]).toContain("7 years");
  });

  it("parses Century 21 and uses only the Cell number", () => {
    const a = parseC21(C21_HTML, "https://www.c21.ca/directory/agents/sam-sample")!;
    expect(a).toMatchObject({
      network: "c21", name: "Sam Sample", brokerage: "CENTURY 21 Example Brokerage",
      city: "Brampton", mobile: "(905) 555-0111", email: "sam.sample@century21.ca",
      website: "https://samsample.ca",
    });
  });

  it("parses Royal LePage, taking city from the URL and ignoring direct/toll-free", () => {
    const a = parseRoyalLepage(RLP_HTML, "https://www.royallepage.ca/en/agent/ontario/richmond-hill/lee-tester/1/")!;
    expect(a).toMatchObject({
      network: "royallepage", name: "Lee Tester", brokerage: "Royal LePage Example Realty",
      city: "Richmond Hill", mobile: "(647) 555-0131", email: null,
    });
  });

  it("leaves mobile empty when only office lines are labelled", () => {
    const html = C21_HTML.replace("<div>Cell</div><a>(905) 555-0111</a>", "");
    expect(parseC21(html, "https://www.c21.ca/directory/agents/x")!.mobile).toBeNull();
  });

  it("dispatches by host and falls back to a generic parser", () => {
    expect(parseAgentPage(REMAX_HTML, "https://www.remax.ca/on/x-ag")!.network).toBe("remax");
    const own = parseAgentPage(
      `<html><head><title>Jo Indie | Realtor</title></head><body><a href="mailto:jo@indie.ca">mail</a></body></html>`,
      "https://www.jo-indie.ca/contact",
    )!;
    expect(own).toMatchObject({ network: "other", name: "Jo Indie", email: "jo@indie.ca" });
    expect(parseAgentPage("<html></html>", "not a url")).toBeNull();
  });

  it("recognises GTA cities", () => {
    expect(isGtaCity("Mississauga")).toBe(true);
    expect(isGtaCity(" richmond hill ")).toBe(true);
    expect(isGtaCity("London")).toBe(false);
    expect(isGtaCity(null)).toBe(false);
  });

  it("detects chat widgets and booking links on an own site", () => {
    expect(analyzeSite('<script src="//embed.tawk.to/abc"></script>')).toEqual({ hasChat: true, hasBooking: false });
    expect(analyzeSite("<a>Book a free consultation</a>")).toEqual({ hasChat: false, hasBooking: true });
    expect(analyzeSite("<p>Welcome</p>")).toEqual({ hasChat: false, hasBooking: false });
  });
});

describe("discovery helpers", () => {
  it("extracts sitemap locs and shuffles deterministically", () => {
    expect(extractLocs("<urlset><url><loc>https://a.test/1?x=1&amp;y=2</loc></url><url><loc> https://a.test/2 </loc></url></urlset>"))
      .toEqual(["https://a.test/1?x=1&y=2", "https://a.test/2"]);
    const seq = [0.1, 0.9, 0.5];
    let i = 0;
    const a = shuffle([1, 2, 3, 4], () => seq[i++ % 3]);
    const b = (() => { let j = 0; return shuffle([1, 2, 3, 4], () => seq[j++ % 3]); })();
    expect(a).toEqual(b);
    expect([...a].sort()).toEqual([1, 2, 3, 4]);
  });
});

describe("collect", () => {
  it("keeps contactable GTA agents, drops the rest, and builds signals + CSV", async () => {
    const pages: Record<string, string> = {
      "https://www.remax.ca/on/a-ag": REMAX_HTML,
      "https://www.c21.ca/directory/agents/b": C21_HTML.replace("Brampton, ON L6Y1A1", "London, ON N6B1R1"), // not GTA
      "https://www.c21.ca/directory/agents/c": C21_HTML.replace(/<div>Email<\/div><a>[^<]*<\/a>/, "").replace("<div>Cell</div><a>(905) 555-0111</a>", ""), // no contact
      "https://www.patexample.ca": "<html><body>no widgets here</body></html>",
    };
    const fake = {
      budgetLeft: 100,
      requestsMade: 0,
      async get(url: string) {
        if (url.endsWith("sitemap.xml") || url.includes("sitemap")) return { ok: false as const, reason: "http" as const };
        return pages[url] ? { ok: true as const, body: pages[url], fromCache: false } : { ok: false as const, reason: "http" as const };
      },
    };
    const { leads, stats } = await collect({
      fetcher: fake as never, sources: [], seedUrls: Object.keys(pages).filter((u) => !u.includes("patexample")),
      target: 10, checkSites: true,
    });
    expect(leads).toHaveLength(1);
    expect(stats).toMatchObject({ parsed: 3, notGta: 1, noContact: 1, collected: 1 });
    expect(leads[0].signals).toEqual({ inTargetArea: true, mobileContact: true, noChatOrBooking: true });

    const csv = leadsToCsv(leads);
    expect(csv.split("\n")[0]).toContain("consent_basis");
    expect(csv).toContain("conspicuous_publication");
    expect(csv).toContain("(416) 555-0199");
  });

  it("excludes brokerages by pattern", async () => {
    const fake = { budgetLeft: 10, requestsMade: 0, async get() { return { ok: true as const, body: REMAX_HTML, fromCache: false }; } };
    const { leads, stats } = await collect({
      fetcher: fake as never, sources: [], seedUrls: ["https://www.remax.ca/on/a-ag"], target: 5, excludeBrokerage: /remax/i,
    });
    expect(leads).toHaveLength(0);
    expect(stats.excluded).toBe(1);
  });

  it("buildSignals marks no website as no chat/booking and unknown as unset", () => {
    const agent = { network: "other", name: "n", brokerage: null, city: "Toronto", mobile: null, email: "a@b.co", website: null, sourceUrl: "u", notes: [] } as const;
    expect(buildSignals({ ...agent }, "none").noChatOrBooking).toBe(true);
    expect(buildSignals({ ...agent }, "unknown").noChatOrBooking).toBeUndefined();
    expect(buildSignals({ ...agent }, { hasChat: true, hasBooking: false }).noChatOrBooking).toBe(false);
  });

  it("escapes CSV fields", () => {
    const csv = leadsToCsv([{
      agent: { network: "other", name: 'Lee, "Sam"', brokerage: null, city: "Toronto", mobile: null, email: "a@b.co", website: null, sourceUrl: "u", notes: [] },
      signals: {},
    }]);
    expect(csv).toContain('"Lee, ""Sam"""');
  });
});

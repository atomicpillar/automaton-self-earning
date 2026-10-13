/**
 * Agent page parsers.
 *
 * Extract only what the agent has published on their own public profile:
 * name, brokerage, office city, a labelled mobile number, an email and a
 * website. A number is treated as mobile only when the page labels it
 * "Mobile" or "Cell"; office, main, fax and toll-free lines are ignored so
 * an SMS draft never goes to a switchboard.
 */

export type AgentNetwork = "remax" | "c21" | "royallepage" | "other";

export interface CollectedAgent {
  network: AgentNetwork;
  name: string;
  brokerage: string | null;
  city: string | null;
  /** Labelled mobile/cell number only, as published. */
  mobile: string | null;
  email: string | null;
  website: string | null;
  sourceUrl: string;
  notes: string[];
}

const PHONE_RE = /\(?\d{3}\)?[\s.\-]*\d{3}[\s.\-]*\d{4}/;
const EMAIL_RE = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/;
const JUNK_EMAIL_RE = /(no-?reply|donotreply|@example\.(com|org|net)$|sentry|wixpress|\.(png|jpe?g|gif|svg|webp)$)/i;

/** Brokerage and portal domains are not an agent's own site. */
const NON_AGENT_SITE_RE =
  /(^|\.)(remax|c21|century21|royallepage|facebook|instagram|linkedin|twitter|x|youtube|tiktok|google|realtor|mls)\./i;

export const GTA_CITIES = new Set([
  "toronto", "etobicoke", "scarborough", "north york", "york", "east york",
  "mississauga", "brampton", "vaughan", "woodbridge", "markham", "richmond hill",
  "oakville", "burlington", "milton", "halton hills", "georgetown", "acton",
  "pickering", "ajax", "whitby", "oshawa", "clarington", "bowmanville",
  "aurora", "newmarket", "east gwillimbury", "whitchurch-stouffville",
  "stouffville", "king", "king city", "georgina", "caledon", "bolton",
  "uxbridge", "scugog", "brock", "thornhill", "maple", "concord", "kleinburg",
]);

export function isGtaCity(city: string | null | undefined): boolean {
  if (!city) return false;
  return GTA_CITIES.has(city.trim().toLowerCase());
}

export function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&#x27;|&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

/** Visible text with every tag boundary replaced by a single "|". */
export function htmlToPipes(html: string): string {
  const noScripts = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<!--[\s\S]*?-->/g, "");
  const piped = noScripts.replace(/<[^>]+>/g, "|");
  return decodeEntities(piped).replace(/[\s|]*\|[\s|]*/g, "|");
}

export function normalizeDisplayPhone(raw: string): string | null {
  const m = PHONE_RE.exec(raw);
  if (!m) return null;
  const digits = m[0].replace(/\D/g, "");
  if (digits.length !== 10) return null;
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

/** The value that follows any of `labels` in pipe-text, matched by `valueRe`. */
function labelled(text: string, labels: string[], valueRe: RegExp): string | null {
  for (const label of labels) {
    const re = new RegExp(`\\|${label}:?\\|+([^|]{1,120})`, "i");
    const m = re.exec(text);
    if (m) {
      const v = valueRe.exec(m[1]);
      if (v) return v[0];
    }
  }
  return null;
}

function cleanEmail(e: string | null | undefined): string | null {
  if (!e) return null;
  const m = EMAIL_RE.exec(e.trim());
  if (!m || JUNK_EMAIL_RE.test(m[0])) return null;
  return m[0].toLowerCase();
}

function cleanWebsite(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let v = raw.trim();
  if (!v) return null;
  if (!/^https?:\/\//i.test(v)) v = `https://${v}`;
  try {
    const u = new URL(v);
    if (!u.hostname.includes(".") || NON_AGENT_SITE_RE.test(u.hostname)) return null;
    return `https://${u.hostname}${u.pathname === "/" ? "" : u.pathname}`;
  } catch {
    return null;
  }
}

function jsonLdBlocks(html: string): unknown[] {
  const out: unknown[] = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(m[1]);
      if (Array.isArray(parsed)) out.push(...parsed);
      else if (parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>)["@graph"])) {
        out.push(...((parsed as Record<string, unknown>)["@graph"] as unknown[]));
      } else out.push(parsed);
    } catch {
      /* ignore malformed JSON-LD */
    }
  }
  return out;
}

type LdObj = Record<string, unknown>;
function agentJsonLd(html: string): LdObj | null {
  for (const b of jsonLdBlocks(html)) {
    if (!b || typeof b !== "object") continue;
    const o = b as LdObj;
    const t = o["@type"];
    const types = Array.isArray(t) ? t : [t];
    if (types.some((x) => x === "RealEstateAgent" || x === "Person")) return o;
  }
  return null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? decodeEntities(v.trim()) : null;
}

function titleOf(html: string): string {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m ? decodeEntities(m[1]).replace(/\s+/g, " ").trim() : "";
}

function cityFromOfficeAddress(text: string): string | null {
  const m = /([A-Z][A-Za-z.'\- ]{2,40}),\s*ON\s+[A-Z]\d[A-Z]\s?\d[A-Z]\d/.exec(text);
  return m ? m[1].trim() : null;
}

// ─── RE/MAX ─────────────────────────────────────────────────────

export function parseRemax(html: string, url: string): CollectedAgent | null {
  const ld = agentJsonLd(html);
  const text = htmlToPipes(html);
  const name = str(ld?.["name"]);
  if (!name) return null;
  const address = (ld?.["address"] ?? {}) as LdObj;
  const mobile = labelled(text, ["Mobile", "Cell"], PHONE_RE);
  return {
    network: "remax",
    name,
    brokerage: str(ld?.["subOrganization"]),
    city: str(address["addressLocality"]),
    mobile: mobile ? normalizeDisplayPhone(mobile) : null,
    email: cleanEmail(str(ld?.["email"])),
    website: cleanWebsite(labelled(text, ["Website"], /[^\s|]+\.[^\s|]+/)),
    sourceUrl: url,
    notes: experienceNotes(text),
  };
}

// ─── Century 21 ─────────────────────────────────────────────────

export function parseC21(html: string, url: string): CollectedAgent | null {
  const text = htmlToPipes(html);
  const og = /<meta property="og:title" content="([^"]*)"/i.exec(html);
  const rawTitle = og ? decodeEntities(og[1]) : titleOf(html);
  const parts = rawTitle.split(" - ").map((p) => p.trim()).filter(Boolean);
  const name = parts[0];
  if (!name) return null;
  const mobile = labelled(text, ["Cell", "Mobile"], PHONE_RE);
  return {
    network: "c21",
    name,
    brokerage: parts[1] ?? null,
    city: cityFromOfficeAddress(text),
    mobile: mobile ? normalizeDisplayPhone(mobile) : null,
    email: cleanEmail(labelled(text, ["Email"], EMAIL_RE)),
    website: cleanWebsite(labelled(text, ["Website"], /[^\s|]+\.[^\s|]+/)),
    sourceUrl: url,
    notes: [],
  };
}

// ─── Royal LePage ───────────────────────────────────────────────

export function parseRoyalLepage(html: string, url: string): CollectedAgent | null {
  const text = htmlToPipes(html);
  // "Zita Maben, Sales Representative , Royal LePage Signature Realty | Royal LePage"
  const title = titleOf(html).split("|")[0];
  const parts = title.split(",").map((p) => p.trim()).filter(Boolean);
  const name = parts[0];
  if (!name) return null;
  const pathCity = /\/agent\/[a-z-]+\/([a-z-]+)\//i.exec(new URL(url).pathname + "/")?.[1];
  const mobile = labelled(text, ["Mobile", "Cell"], PHONE_RE);
  return {
    network: "royallepage",
    name,
    brokerage: parts.slice(2).join(", ") || null,
    city: pathCity ? pathCity.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) : null,
    mobile: mobile ? normalizeDisplayPhone(mobile) : null,
    email: cleanEmail(/mailto:([^"'?]+)/i.exec(html)?.[1]),
    website: null,
    sourceUrl: url,
    notes: [],
  };
}

// ─── Generic (independents' own sites, other brokerages) ────────

export function parseGeneric(html: string, url: string): CollectedAgent | null {
  const ld = agentJsonLd(html);
  const text = htmlToPipes(html);
  const name = str(ld?.["name"]) ?? titleOf(html).split(/[|\-–—]/)[0].trim();
  if (!name) return null;
  const address = (ld?.["address"] ?? {}) as LdObj;
  const mobile = labelled(text, ["Mobile", "Cell"], PHONE_RE);
  const mailto = /mailto:([^"'?]+)/i.exec(html)?.[1];
  let host: string | null = null;
  try {
    host = new URL(url).hostname;
  } catch {
    host = null;
  }
  return {
    network: "other",
    name,
    brokerage: str(ld?.["worksFor"] && (ld["worksFor"] as LdObj)["name"]) ?? str(ld?.["subOrganization"]),
    city: str(address["addressLocality"]) ?? cityFromOfficeAddress(text),
    mobile: mobile ? normalizeDisplayPhone(mobile) : normalizeDisplayPhone(str(ld?.["telephone"]) ?? ""),
    email: cleanEmail(str(ld?.["email"])) ?? cleanEmail(mailto),
    website: host ? cleanWebsite(host) : null,
    sourceUrl: url,
    notes: ["own website: telephone may be a main line, check before texting"],
  };
}

function experienceNotes(text: string): string[] {
  const m = /(\d+)\s+Years? Experience/i.exec(text);
  return m ? [`${m[1]} years experience (per profile)`] : [];
}

export function parseAgentPage(html: string, url: string): CollectedAgent | null {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }
  if (/(^|\.)remax\.ca$/.test(host)) return parseRemax(html, url);
  if (/(^|\.)c21\.ca$/.test(host)) return parseC21(html, url);
  if (/(^|\.)royallepage\.ca$/.test(host)) return parseRoyalLepage(html, url);
  return parseGeneric(html, url);
}

// ─── Own-website check ──────────────────────────────────────────

const CHAT_MARKERS = [
  "intercom", "drift.com", "driftt", "tawk.to", "livechatinc", "crisp.chat",
  "tidio", "usemessages.com", "zopim", "zdassets", "olark", "chatra",
  "freshchat", "podium", "ylopo", "structurely", "smith.ai", "chatbot",
  "livechat", "leadconnectorhq", "widget.mychatbot", "botpress",
];
const BOOKING_RE =
  /calendly\.com|acuityscheduling|(book|schedule)\s+(a|your)\s+(free\s+)?(call|consult\w*|showing|appointment|meeting|viewing)/i;

export interface SiteCheck {
  hasChat: boolean;
  hasBooking: boolean;
}

export function analyzeSite(html: string): SiteCheck {
  const lower = html.toLowerCase();
  return {
    hasChat: CHAT_MARKERS.some((m) => lower.includes(m)),
    hasBooking: BOOKING_RE.test(html),
  };
}

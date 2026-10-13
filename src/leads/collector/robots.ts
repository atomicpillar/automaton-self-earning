/**
 * Minimal robots.txt parser.
 *
 * Implements the rules a polite collector needs: the group for our user
 * agent (falling back to `*`), Allow/Disallow with `*` and `$` wildcards,
 * longest-match-wins (Allow wins ties), and Crawl-delay.
 */

interface Rule {
  allow: boolean;
  pattern: string;
}

export interface RobotsRules {
  rules: Rule[];
  crawlDelaySeconds: number | null;
}

export function parseRobots(text: string, userAgent: string): RobotsRules {
  const agent = userAgent.toLowerCase();
  type Group = { agents: string[]; rules: Rule[]; crawlDelay: number | null };
  const groups: Group[] = [];
  let current: Group | null = null;
  let lastWasAgent = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (field === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [], crawlDelay: null };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (field === "allow" || field === "disallow") {
      // An empty Disallow means "allow everything"; it adds no rule.
      if (value) current.rules.push({ allow: field === "allow", pattern: value });
    } else if (field === "crawl-delay") {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) current.crawlDelay = n;
    }
  }

  const specific = groups.filter((g) => g.agents.some((a) => a !== "*" && agent.includes(a)));
  const chosen = specific.length > 0 ? specific : groups.filter((g) => g.agents.includes("*"));
  return {
    rules: chosen.flatMap((g) => g.rules),
    crawlDelaySeconds: chosen.find((g) => g.crawlDelay !== null)?.crawlDelay ?? null,
  };
}

function patternToRegex(pattern: string): RegExp {
  const anchored = pattern.endsWith("$");
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${body}${anchored ? "$" : ""}`);
}

/** True if `pathAndQuery` (e.g. "/on/foo?x=1") may be fetched. */
export function isAllowed(robots: RobotsRules, pathAndQuery: string): boolean {
  let best: { len: number; allow: boolean } | null = null;
  for (const rule of robots.rules) {
    if (!patternToRegex(rule.pattern).test(pathAndQuery)) continue;
    const len = rule.pattern.length;
    if (!best || len > best.len || (len === best.len && rule.allow)) {
      best = { len, allow: rule.allow };
    }
  }
  return best ? best.allow : true;
}

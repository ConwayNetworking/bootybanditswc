/**
 * GET /api/matches
 *
 * Fully automated score sync, designed for Cloudflare Pages + free
 * football-data.org tier (10 req/min):
 *
 *  1. Edge cache (Cache API) fronts everything: 55s TTL while matches are
 *     live or about to kick off, 5min otherwise. However many people have
 *     the site open, upstream sees ~1 request/min worst case.
 *  2. On each refresh the function trims the upstream payload (~90% smaller)
 *     and maps every football-data match onto the site's fixture IDs (1-104),
 *     including knockout bracket slots resolved from group standings.
 *  3. Computed results are persisted to KV (`global:auto`) so all three
 *     leagues share one sync and nobody needs to keep an admin tab open.
 *     KV is only written when something actually changed (free tier allows
 *     1k writes/day). A full payload copy is kept in KV as a stale fallback
 *     for upstream outages, rewritten at most every 10 minutes.
 *
 * Env vars:   FOOTBALL_DATA_KEY
 *             API_FOOTBALL_KEY (optional — API-Sports per-match goal scorers for Match Centre)
 * KV binding: WC_LEAGUE
 */

import { applyFeedToResults } from "../lib/apply-feed-results.js";

const UPSTREAM = "https://api.football-data.org/v4/competitions/WC/matches";
const API_FOOTBALL_LIVE = "https://v3.football.api-sports.io/fixtures?live=all";
const WC_LEAGUE_ID = 1;
const WC_SEASON = 2026;
const KV_CACHE = "cache:matches:v2";
const KV_AUTO = "global:auto";
const KV_LIVE_FEED = "global:live_feed";
const KV_API_FB = "cache:apifb:budget";
const KV_MATCH_GOALS = "cache:match_goals:v1";
const API_FB_MIN_MS = 5 * 60 * 1000;
const API_FB_DAILY_MAX = 80;
const API_FB_GOALS_MIN_MS = 3 * 60 * 1000;
const API_FB_GOALS_MIN_MS_BACKFILL = 15 * 1000;
const API_FB_GOALS_BACKFILL_BATCH = 5;
const API_FB_GOALS_BACKFILL_ROUNDS = 4;
const API_FB_GOALS_IDS_BATCH = 20;
const API_FB_GOALS_DAILY_MAX = 50;
const API_FB_DAILY_TOTAL_MAX = 100;
const API_FOOTBALL_BASE = "https://v3.football.api-sports.io";
const LIVE_FEED_MAX = 20;
const LIVE_TTL_S = 30;
const IDLE_TTL_S = 300;
const LIVE_REVALIDATE_MS = 25 * 1000;
const KV_REWRITE_MS = 10 * 60 * 1000;
const KV_SCORERS  = "cache:scorers:v1";
const KV_SQUADS   = "cache:squads:v1";
const SCORERS_TTL_MS = 10 * 60 * 1000;   // refresh scorers every 10 min
const SQUADS_TTL_MS  = 60 * 60 * 1000;   // refresh squads every 1 hour
const KICKOFF_SOON_MS = 15 * 60 * 1000;
const MATCH_WINDOW_MS = 150 * 60 * 1000;

/* ── Fixture table (must mirror MX/KO in index.html) ─────────────────── */
/* Group stage: [id, group, home, away] */
const MX = [
  [1, "A", "Mexico", "South Africa"], [2, "A", "South Korea", "Czech Republic"],
  [3, "B", "Canada", "Bosnia & Herzegovina"], [4, "D", "USA", "Paraguay"],
  [5, "B", "Qatar", "Switzerland"], [6, "C", "Brazil", "Morocco"],
  [7, "C", "Haiti", "Scotland"], [8, "D", "Australia", "Turkey"],
  [9, "E", "Germany", "Curacao"], [10, "F", "Netherlands", "Japan"],
  [11, "E", "Ivory Coast", "Ecuador"], [12, "F", "Sweden", "Tunisia"],
  [13, "H", "Spain", "Cape Verde"], [14, "G", "Belgium", "Egypt"],
  [15, "H", "Saudi Arabia", "Uruguay"], [16, "G", "Iran", "New Zealand"],
  [17, "I", "France", "Senegal"], [18, "I", "Iraq", "Norway"],
  [19, "J", "Argentina", "Algeria"], [20, "J", "Austria", "Jordan"],
  [21, "K", "Portugal", "DR Congo"], [22, "L", "England", "Croatia"],
  [23, "L", "Ghana", "Panama"], [24, "K", "Uzbekistan", "Colombia"],
  [25, "A", "Czech Republic", "South Africa"], [26, "B", "Switzerland", "Bosnia & Herzegovina"],
  [27, "B", "Canada", "Qatar"], [28, "A", "Mexico", "South Korea"],
  [29, "D", "USA", "Australia"], [30, "C", "Scotland", "Morocco"],
  [31, "C", "Brazil", "Haiti"], [32, "D", "Turkey", "Paraguay"],
  [33, "F", "Netherlands", "Sweden"], [34, "E", "Germany", "Ivory Coast"],
  [35, "E", "Ecuador", "Curacao"], [36, "F", "Tunisia", "Japan"],
  [37, "H", "Spain", "Saudi Arabia"], [38, "G", "Belgium", "Iran"],
  [39, "H", "Uruguay", "Cape Verde"], [40, "G", "New Zealand", "Egypt"],
  [41, "J", "Argentina", "Austria"], [42, "I", "France", "Iraq"],
  [43, "I", "Norway", "Senegal"], [44, "J", "Jordan", "Algeria"],
  [45, "K", "Portugal", "Uzbekistan"], [46, "L", "England", "Ghana"],
  [47, "L", "Panama", "Croatia"], [48, "K", "Colombia", "DR Congo"],
  [49, "B", "Switzerland", "Canada"], [50, "B", "Bosnia & Herzegovina", "Qatar"],
  [51, "C", "Scotland", "Brazil"], [52, "C", "Morocco", "Haiti"],
  [53, "A", "Czech Republic", "Mexico"], [54, "A", "South Africa", "South Korea"],
  [55, "E", "Ecuador", "Germany"], [56, "E", "Curacao", "Ivory Coast"],
  [57, "F", "Japan", "Sweden"], [58, "F", "Tunisia", "Netherlands"],
  [59, "D", "Turkey", "USA"], [60, "D", "Paraguay", "Australia"],
  [61, "I", "Norway", "France"], [62, "I", "Senegal", "Iraq"],
  [63, "H", "Cape Verde", "Saudi Arabia"], [64, "H", "Uruguay", "Spain"],
  [65, "G", "Egypt", "Iran"], [66, "G", "New Zealand", "Belgium"],
  [67, "L", "Panama", "England"], [68, "L", "Croatia", "Ghana"],
  [69, "J", "Algeria", "Austria"], [70, "J", "Jordan", "Argentina"],
  [71, "K", "Colombia", "Portugal"], [72, "K", "DR Congo", "Uzbekistan"],
];
/* Knockout: [id, round, slot1, slot2] — slots resolved from results */
const KO = [
  [73, "R32", "2A", "2B"], [74, "R32", "1E", "3rd(A/B/C/D/F)"],
  [75, "R32", "1F", "2C"], [76, "R32", "1C", "2F"],
  [77, "R32", "1I", "3rd(C/D/F/G/H)"], [78, "R32", "2E", "2I"],
  [79, "R32", "1A", "3rd(C/E/F/H/I)"], [80, "R32", "1L", "3rd(E/H/I/J/K)"],
  [81, "R32", "1D", "3rd(B/E/F/I/J)"], [82, "R32", "1G", "3rd(A/E/H/I/J)"],
  [83, "R32", "2K", "2L"], [84, "R32", "1H", "2J"],
  [85, "R32", "1B", "3rd(E/F/G/I/J)"], [86, "R32", "1J", "2H"],
  [87, "R32", "1K", "3rd(D/E/I/J/L)"], [88, "R32", "2D", "2G"],
  [89, "R16", "W74", "W77"], [90, "R16", "W73", "W75"],
  [91, "R16", "W76", "W78"], [92, "R16", "W79", "W80"],
  [93, "R16", "W83", "W84"], [94, "R16", "W81", "W82"],
  [95, "R16", "W86", "W88"], [96, "R16", "W85", "W87"],
  [97, "QF", "W89", "W90"], [98, "QF", "W93", "W94"],
  [99, "QF", "W91", "W92"], [100, "QF", "W95", "W96"],
  [101, "SF", "W97", "W98"], [102, "SF", "W99", "W100"],
  [103, "3RD", "L101", "L102"], [104, "FIN", "W101", "W102"],
];

const GL = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L"];
const GRP = {};
for (const m of MX) {
  if (!GRP[m[1]]) GRP[m[1]] = [];
  for (const t of [m[2], m[3]]) if (!GRP[m[1]].includes(t)) GRP[m[1]].push(t);
}

/* football-data names → our names (norm() also strips diacritics/punct) */
const ALIASES = {
  "Korea Republic": "South Korea",
  "Czechia": "Czech Republic",
  "Cote d'Ivoire": "Ivory Coast",
  "Cabo Verde": "Cape Verde",
  "Congo DR": "DR Congo",
  "Bosnia and Herzegovina": "Bosnia & Herzegovina",
  "IR Iran": "Iran",
  "Turkiye": "Turkey",
  "United States": "USA",
  "United States of America": "USA",
  "Saudi-Arabia": "Saudi Arabia",
  "Côte d'Ivoire": "Ivory Coast",
  "Cote d Ivoire": "Ivory Coast",
  "Cape Verde Islands": "Cape Verde",
  "Republic of Ireland": "Ireland",
  "Korea Republic": "South Korea",
  "United States": "USA",
  "Curaçao": "Curacao",
  "Congo DR": "DR Congo",
  "Bosnia-Herzegovina": "Bosnia & Herzegovina",
};

/* API-Sports team labels → our fixture table names */
const API_FB_TEAM_ALIASES = {
  "United States": "USA",
  "United States of America": "USA",
  "Korea Republic": "South Korea",
  "Korea DPR": "North Korea",
  "Congo DR": "DR Congo",
  "Congo-DR": "DR Congo",
  "Côte d'Ivoire": "Ivory Coast",
  "Cote d'Ivoire": "Ivory Coast",
  "Cabo Verde": "Cape Verde",
  "Cape Verde Islands": "Cape Verde",
  "IR Iran": "Iran",
  "Turkiye": "Turkey",
  "Türkiye": "Turkey",
  "Czechia": "Czech Republic",
  "Saudi-Arabia": "Saudi Arabia",
  "Bosnia and Herzegovina": "Bosnia & Herzegovina",
  "Bosnia-Herzegovina": "Bosnia & Herzegovina",
};

function norm(s) {
  return String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

const TEAM_LOOKUP = {};
for (const g of GL) for (const t of GRP[g]) TEAM_LOOKUP[norm(t)] = t;
for (const a in ALIASES) TEAM_LOOKUP[norm(a)] = ALIASES[a];

function canonTeam(team) {
  if (!team) return null;
  if (typeof team === "string") team = { name: team };
  for (const candidate of [team.name, team.shortName, team.tla]) {
    const mapped = candidate && API_FB_TEAM_ALIASES[candidate];
    if (mapped) return mapped;
    const hit = TEAM_LOOKUP[norm(candidate)];
    if (hit) return hit;
  }
  return null;
}

/* ── Group standings + bracket resolution (port of index.html logic) ── */
const FR = {
  Argentina: 1, Spain: 2, France: 3, England: 4, Portugal: 5, Brazil: 6, Morocco: 7,
  Netherlands: 8, Belgium: 9, Germany: 10, Croatia: 11, Colombia: 13, Mexico: 14,
  Senegal: 15, Uruguay: 16, USA: 17, Japan: 18, Switzerland: 19, Iran: 21, Turkey: 22,
  Ecuador: 23, Austria: 24, "South Korea": 25, Australia: 27, Algeria: 28, Egypt: 29,
  Canada: 30, Norway: 31, "Ivory Coast": 33, Panama: 34, Sweden: 38,
  "Czech Republic": 39, Paraguay: 40, Scotland: 42, "DR Congo": 45, Tunisia: 46,
  Uzbekistan: 51, Iraq: 56, Qatar: 57, "South Africa": 60, "Saudi Arabia": 61, Jordan: 63,
  "Bosnia & Herzegovina": 65, "Cape Verde": 69, Ghana: 73, Haiti: 83, Curacao: 82,
  "New Zealand": 85,
};

function h2hPlayed(g, t1, t2, results) {
  for (const mx of MX) {
    if (mx[1] !== g) continue;
    if ((mx[2] === t1 && mx[3] === t2) || (mx[2] === t2 && mx[3] === t1)) return !!results[mx[0]];
  }
  return false;
}

function grpH2HStats(g, teams, results) {
  const h = {};
  for (const t of teams) h[t] = { p: 0, gf: 0, ga: 0, gd: 0, pts: 0 };
  for (const mx of MX) {
    if (mx[1] !== g) continue;
    const a = mx[2], b = mx[3];
    if (!h[a] || !h[b]) continue;
    const r = results[mx[0]];
    if (!r) continue;
    const s1 = r.s1, s2 = r.s2;
    h[a].p++; h[b].p++;
    h[a].gf += s1; h[a].ga += s2;
    h[b].gf += s2; h[b].ga += s1;
    if (s1 > s2) h[a].pts += 3;
    else if (s1 < s2) h[b].pts += 3;
    else { h[a].pts += 1; h[b].pts += 1; }
  }
  for (const t of Object.keys(h)) h[t].gd = h[t].gf - h[t].ga;
  return h;
}

function cmpGroupTeams(a, b, g, st, results) {
  const sa = st[a], sb = st[b];
  if (sa.pts !== sb.pts) return sb.pts - sa.pts;
  const tied = Object.keys(st).filter((t) => st[t].pts === sa.pts);
  if (tied.length >= 2) {
    const h2h = grpH2HStats(g, tied, results);
    const ha = h2h[a], hb = h2h[b];
    if (ha.pts !== hb.pts) return hb.pts - ha.pts;
    if (ha.gd !== hb.gd) return hb.gd - ha.gd;
    if (ha.gf !== hb.gf) return hb.gf - ha.gf;
  }
  if (sa.gd !== sb.gd) return sb.gd - sa.gd;
  if (sa.gf !== sb.gf) return sb.gf - sa.gf;
  return (FR[a] || 999) - (FR[b] || 999);
}

function cGrp(g, results) {
  const st = {};
  for (const t of GRP[g]) st[t] = { p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, gd: 0, pts: 0 };
  let played = 0;
  for (const mx of MX) {
    if (mx[1] !== g) continue;
    const r = results[mx[0]];
    if (!r) continue;
    played++;
    const t1 = mx[2], t2 = mx[3], s1 = r.s1, s2 = r.s2;
    st[t1].p++; st[t2].p++;
    st[t1].gf += s1; st[t1].ga += s2; st[t2].gf += s2; st[t2].ga += s1;
    if (s1 > s2) { st[t1].w++; st[t1].pts += 3; st[t2].l++; }
    else if (s1 < s2) { st[t2].w++; st[t2].pts += 3; st[t1].l++; }
    else { st[t1].d++; st[t1].pts += 1; st[t2].d++; st[t2].pts += 1; }
  }
  const arr = Object.entries(st);
  for (const [, s] of arr) s.gd = s.gf - s.ga;
  arr.sort((a, b) => cmpGroupTeams(a[0], b[0], g, st, results));
  return { st: arr, done: played === 6 };
}

function gB3(results) {
  const all = [];
  for (const g of GL) {
    const d = cGrp(g, results);
    if (!d.done) return null;
    if (d.st.length > 2) all.push({ team: d.st[2][0], group: g, s: d.st[2][1] });
  }
  all.sort((a, b) => b.s.pts - a.s.pts || b.s.gd - a.s.gd || b.s.gf - a.s.gf);
  return all.slice(0, 8);
}

function winnerOf(r, t1, t2) {
  if (r.s1 > r.s2) return t1;
  if (r.s2 > r.s1) return t2;
  if (r.p1 != null && r.p2 != null) return r.p1 > r.p2 ? t1 : r.p2 > r.p1 ? t2 : null;
  return null;
}

function gKT(slot, results) {
  if (!slot) return null;
  if (slot[0] === "W" || slot[0] === "L") {
    const mid = parseInt(slot.substring(1), 10);
    const r = results[mid];
    if (!r) return null;
    const t = gKM(mid, results);
    if (!t || !t[0] || !t[1]) return null;
    const w = winnerOf(r, t[0], t[1]);
    if (!w) return null;
    return slot[0] === "W" ? w : (w === t[0] ? t[1] : t[0]);
  }
  if (slot.length === 2 && slot[1] >= "A" && slot[1] <= "L") {
    const d = cGrp(slot[1], results);
    if (!d.done) return null;
    const pos = slot[0] === "1" ? 0 : 1;
    return pos < d.st.length ? d.st[pos][0] : null;
  }
  if (slot.indexOf("3rd") === 0) {
    const b3 = gB3(results);
    if (!b3) return null;
    const groups = slot.replace("3rd(", "").replace(")", "").split("/");
    for (const entry of b3) if (groups.includes(entry.group)) return entry.team;
    return null;
  }
  return null;
}

function gKM(mid, results) {
  for (const k of KO) if (k[0] === mid) return [gKT(k[2], results), gKT(k[3], results)];
  return null;
}

/* ── Upstream payload processing ─────────────────────────────────────── */
const LIVE_STATUSES = ["IN_PLAY", "PAUSED", "SUSPENDED"];
const DONE_STATUSES = ["FINISHED", "AWARDED"];

const STAGE_MAP = {
  R32: ["LAST_32", "ROUND_OF_32", "PLAYOFFS"],
  R16: ["LAST_16", "ROUND_OF_16"],
  QF: ["QUARTER_FINALS", "QUARTER_FINAL"],
  SF: ["SEMI_FINALS", "SEMI_FINAL"],
  "3RD": ["THIRD_PLACE", "THIRD_PLACE_PLAYOFF", "PLAYOFF_FOR_THIRD_PLACE"],
  FIN: ["FINAL"],
};

function stageOk(round, apiStage) {
  if (!apiStage || apiStage === "PLAYOFFS") return true;
  const known = STAGE_MAP[round] || [];
  /* Unknown stage strings shouldn't block matching */
  const allKnown = Object.values(STAGE_MAP).flat();
  if (!allKnown.includes(apiStage)) return true;
  return known.includes(apiStage);
}

function isGroupStage(m) {
  return m.stage === "GROUP_STAGE" || (!m.stage && !!m.group);
}

function trimMatch(m) {
  const sc = m.score || {};
  return {
    id: m.id,
    utcDate: m.utcDate,
    status: m.status,
    minute: typeof m.minute === "number" ? m.minute : undefined,
    matchday: m.matchday,
    stage: m.stage,
    group: m.group,
    homeTeam: { name: m.homeTeam && (m.homeTeam.name || m.homeTeam.shortName), tla: m.homeTeam && m.homeTeam.tla },
    awayTeam: { name: m.awayTeam && (m.awayTeam.name || m.awayTeam.shortName), tla: m.awayTeam && m.awayTeam.tla },
    score: {
      winner: sc.winner, duration: sc.duration,
      fullTime: sc.fullTime, halfTime: sc.halfTime,
      penalties: sc.penalties && sc.penalties.home != null ? sc.penalties : undefined,
    },
  };
}

function extractRef(m) {
  const refs = m.referees;
  if (!Array.isArray(refs) || !refs.length) return null;
  const main = refs.find((r) => r.type === "REFEREE") || refs[0];
  if (!main || !main.name) return null;
  return main.nationality ? main.name + " (" + main.nationality + ")" : main.name;
}

function extractVenue(m) {
  /* venue may be a string or an object depending on API version */
  if (!m.venue) return null;
  if (typeof m.venue === "string") return { name: m.venue };
  return {
    name: m.venue.name || m.venue,
    city: m.venue.city || (m.area && m.area.name) || undefined,
  };
}

function orientScore(sc, homeIsFirst) {
  if (homeIsFirst) return sc;
  const out = { ...sc, s1: sc.s2, s2: sc.s1 };
  if (sc.p1 != null) { out.p1 = sc.p2; out.p2 = sc.p1; }
  if (sc.ht1 != null) { out.ht1 = sc.ht2; out.ht2 = sc.ht1; }
  return out;
}

function mergeMeta(prev, computed) {
  return { ...(prev || {}), ...(computed || {}) };
}

function matchDetailUrl(env, apiId) {
  return env.FOOTBALL_DATA_URL
    ? new URL("/v4/matches/" + apiId, env.FOOTBALL_DATA_URL).toString()
    : "https://api.football-data.org/v4/matches/" + apiId;
}

function apiDetailHeaders(apiKey) {
  return { "X-Auth-Token": apiKey };
}

function applyLiveDetail(listMatch, detail) {
  const src = detail && typeof detail.minute !== "undefined" ? detail : detail && detail.match;
  if (!src) return;
  const min = parseInt(src.minute, 10);
  if (!isNaN(min)) listMatch.minute = min;
  if (src.score) listMatch.score = { ...(listMatch.score || {}), ...src.score };
  if (Array.isArray(src.goals) && src.goals.length) listMatch.goals = src.goals;
}

/* ── API-Sports (api-football.com) — sparing fallback for live gaps ───── */
const API_FB_LIVE_SHORTS = { "1H": 1, "2H": 1, HT: 1, ET: 1, BT: 1, P: 1, LIVE: 1, INT: 1 };

function findFixtureIdByTeams(h, a, results) {
  const fx = findGroupFixture(h, a);
  if (fx) return { id: fx[0], homeIsFirst: fx[2] === h };
  for (const k of KO) {
    const t1 = gKT(k[2], results);
    const t2 = gKT(k[3], results);
    if (!t1 || !t2) continue;
    if ((t1 === h && t2 === a) || (t1 === a && t2 === h)) {
      return { id: k[0], homeIsFirst: t1 === h };
    }
  }
  return null;
}

function halfTimeMatchesCurrentScore(m) {
  const ht = m.score && m.score.halfTime;
  const ft = m.score && m.score.fullTime;
  if (!ht || ht.home == null || ht.away == null) return false;
  if (!ft || ft.home == null || ft.away == null) return false;
  return ht.home === ft.home && ht.away === ft.away;
}

function shouldTrustHalfTimeScore(m, min) {
  const ht = m.score && m.score.halfTime;
  if (!ht || ht.home == null || ht.away == null) return false;
  if (DONE_STATUSES.includes(m.status)) return true;
  if (LIVE_STATUSES.includes(m.status) || m.status === "PAUSED") {
    if (halfTimeMatchesCurrentScore(m)) return false;
  }
  const liveMin = typeof min === "number" ? min : (typeof m.minute === "number" ? m.minute : null);
  if (m.status === "PAUSED" && isRealHalfTimePause(m, liveMin != null && liveMin > 45)) return true;
  if (liveMin != null && liveMin > 45) return true;
  return false;
}

function isAfterHalfTime(r, prev, utc, nowMs) {
  if (!r || r.st !== "LIVE") return false;
  if (r.pp) return false;
  let min = typeof r.min === "number" ? r.min : null;
  if (min == null && utc && nowMs) {
    const ko = new Date(utc).getTime();
    if (!isNaN(ko)) {
      min = Math.floor((nowMs - ko) / 60000);
      if (min < 0) min = null;
    }
  }
  if (min != null && min <= 45) return false;
  if (r.aht || (prev && prev.aht)) return true;
  if (r.ht1 != null && min != null && min > 45) return true;
  return false;
}

function sanitizeFirstHalfLive(r, utc, nowMs) {
  if (!r || r.st !== "LIVE" || r.pp) return;
  let min = typeof r.min === "number" ? r.min : null;
  if (min == null && utc && nowMs) {
    const ko = new Date(utc).getTime();
    if (!isNaN(ko)) {
      min = Math.floor((nowMs - ko) / 60000);
      if (min < 0) min = null;
    }
  }
  if (min == null) {
    delete r.ht1;
    delete r.ht2;
    delete r.aht;
    if (!r.prd || /2nd/i.test(r.prd)) r.prd = "1st Half";
    return;
  }
  if (min > 45) {
    if (r.ht1 != null && r.ht2 != null && r.s1 != null && r.s2 != null &&
        r.ht1 === r.s1 && r.ht2 === r.s2) {
      delete r.ht1;
      delete r.ht2;
    }
    return;
  }
  delete r.ht1;
  delete r.ht2;
  delete r.aht;
  if (!r.prd || /2nd/i.test(r.prd)) r.prd = "1st Half";
}

function apiFootballPeriod(short, min, htDone) {
  if (short === "1H") return "1st Half";
  if (short === "2H") return "2nd Half";
  if (short === "HT") return "HALF TIME";
  if (short === "P") return "Penalties";
  if (short === "ET") {
    if (min != null && min > 105) return "2nd Half - Extra Time";
    return "1st Half - Extra Time";
  }
  if (min == null) return htDone ? "2nd Half" : "1st Half";
  if (min > 105) return "2nd Half - Extra Time";
  if (min > 90) return "1st Half - Extra Time";
  if (!htDone && min <= 45) return "1st Half";
  if (!htDone && min > 45) return "1st Half";
  if (htDone && min <= 90) return "2nd Half";
  return "2nd Half";
}

function liveResultFromApiFootball(entry, homeIsFirst) {
  const fix = entry.fixture || {};
  const st = fix.status || {};
  const short = st.short || "";
  if (!API_FB_LIVE_SHORTS[short]) return null;

  const elapsed = typeof st.elapsed === "number" ? st.elapsed : null;
  const extra = typeof st.extra === "number" ? st.extra : 0;
  const min = elapsed != null ? elapsed + extra : null;

  const goals = entry.goals || {};
  const ht = (entry.score && entry.score.halftime) || {};
  const htDone = short === "2H" || short === "ET" || short === "BT" || short === "P"
    || ((ht.home != null && ht.away != null) && min != null && min > 45);
  let s1 = goals.home;
  let s2 = goals.away;
  if (s1 == null || s2 == null) return null;
  if (!homeIsFirst) { const tmp = s1; s1 = s2; s2 = tmp; }

  const out = { s1, s2, st: "LIVE", prd: apiFootballPeriod(short, min, htDone) };
  if (min != null) out.min = min;
  if (short === "ET" || short === "BT") out.dur = "EXTRA_TIME";
  else if (short === "P") out.dur = "PENALTY_SHOOTOUT";
  if (htDone) {
    out.ht1 = homeIsFirst ? ht.home : ht.away;
    out.ht2 = homeIsFirst ? ht.away : ht.home;
    out.aht = 1;
  }
  if (short === "HT") { out.pp = 1; out.clk = 1; }
  else if (short === "BT" || short === "INT") out.clk = 1;
  return out;
}

function apiFootballIsBetter(fd, af) {
  if (!af || af.st !== "LIVE") return false;
  if (!fd || fd.st !== "LIVE") return true;
  if (fd.min == null && af.min != null) return true;
  if (fd.s1 == null || fd.s2 == null) return af.s1 != null && af.s2 != null;
  if (af.s1 != null && af.s2 != null && af.s1 + af.s2 > fd.s1 + fd.s2) return true;
  if (af.clk && !fd.clk) return true;
  if (af.min != null && fd.min != null) {
    const fdReg = !fd.dur || fd.dur === "REGULAR";
    if (fd.min <= 90 && af.min > 90 && fdReg) return false;
    if (af.min > fd.min + 5 && fd.min <= 90) return false;
    if (af.min > fd.min && af.min - fd.min <= 5) return true;
    if (af.min > 105 && fd.min <= 105) return true;
    if (fd.dur === "EXTRA_TIME" && af.min > fd.min) return true;
  }
  if (af.prd && /extra/i.test(af.prd) && fd.prd === "2nd Half" && (fd.min == null || fd.min > 85)) return true;
  return false;
}

function mergeApiFootballLive(fd, af) {
  if (!apiFootballIsBetter(fd, af)) return fd;
  const out = { ...fd };
  if (af.s1 != null) out.s1 = af.s1;
  if (af.s2 != null) out.s2 = af.s2;
  if (af.min != null) out.min = af.min;
  if (af.prd) out.prd = af.prd;
  if (af.dur && !(af.min != null && af.min <= 90 && af.dur === "EXTRA_TIME")) out.dur = af.dur;
  if (af.ht1 != null) { out.ht1 = af.ht1; out.ht2 = af.ht2; }
  if (af.aht) out.aht = 1;
  if (af.pp) { out.pp = 1; out.clk = 1; }
  else if (af.clk) { out.clk = 1; delete out.pp; }
  else { delete out.clk; delete out.pp; }
  out.st = "LIVE";
  return out;
}

function applyGoalSnapToLiveResults(results, goalSnap) {
  for (const fid in goalSnap || {}) {
    const goals = goalSnap[fid];
    if (!goals || !goals.length) continue;
    const r = results[fid];
    if (!r || r.st !== "LIVE") continue;
    const last = goals[goals.length - 1];
    if (last.s1 == null || last.s2 == null) continue;
    const curTotal = (r.s1 || 0) + (r.s2 || 0);
    const snapTotal = last.s1 + last.s2;
    if (snapTotal <= curTotal) continue;
    const out = { ...r, s1: last.s1, s2: last.s2, st: "LIVE" };
    if (last.minute != null) out.min = last.minute;
    results[fid] = out;
  }
}

function applyFeedScoresToLiveResults(results, feed) {
  const merged = applyFeedToResults(results, feed);
  for (const fid in merged) results[fid] = merged[fid];
}

function needsApiFootballSupplement(rawMatches, results, goalSnap) {
  const live = rawMatches.filter((m) => LIVE_STATUSES.includes(m.status));
  if (!live.length) return false;
  for (const m of live) {
    if (typeof m.minute !== "number") return true;
    const h = canonTeam(m.homeTeam);
    const a = canonTeam(m.awayTeam);
    if (!h || !a) continue;
    const slot = findFixtureIdByTeams(h, a, results);
    if (!slot) continue;
    const r = results[slot.id];
    if (!r || r.st !== "LIVE") return true;
    if (r.s1 == null || r.s2 == null) return true;
    if (r.min == null) return true;
    if (r.min > 90 && r.dur !== "EXTRA_TIME") return true;
  }
  for (const fid in goalSnap || {}) {
    const goals = goalSnap[fid];
    const r = results[fid];
    if (!r || r.st !== "LIVE" || !goals || !goals.length) continue;
    const last = goals[goals.length - 1];
    if (last.s1 == null || last.s2 == null) continue;
    if (last.s1 + last.s2 > (r.s1 || 0) + (r.s2 || 0)) return true;
  }
  return false;
}

async function loadApiFootballBudget(kv) {
  const dayKey = new Date().toISOString().slice(0, 10);
  let bud = { day: dayKey, liveCount: 0, goalsCount: 0, lastLiveAt: 0, lastGoalsAt: 0 };
  if (!kv) return bud;
  try {
    const raw = await kv.get(KV_API_FB);
    if (raw) bud = JSON.parse(raw);
  } catch { /* fresh budget */ }
  if (bud.day !== dayKey) bud = { day: dayKey, liveCount: 0, goalsCount: 0, lastLiveAt: 0, lastGoalsAt: 0 };
  if (bud.liveCount == null && bud.count != null) bud.liveCount = bud.count;
  if (bud.goalsCount == null) bud.goalsCount = 0;
  return bud;
}

function apiFootballTotalCalls(bud) {
  return (bud.liveCount || 0) + (bud.goalsCount || 0);
}

async function canCallApiFootball(kv, now) {
  const bud = await loadApiFootballBudget(kv);
  if (apiFootballTotalCalls(bud) >= API_FB_DAILY_TOTAL_MAX) return false;
  if ((bud.liveCount || 0) >= API_FB_DAILY_MAX) return false;
  if (bud.lastLiveAt && now - bud.lastLiveAt < API_FB_MIN_MS) return false;
  return true;
}

async function canCallApiFootballGoals(kv, now, opts = {}) {
  const minMs = opts.backfill ? API_FB_GOALS_MIN_MS_BACKFILL : API_FB_GOALS_MIN_MS;
  const bud = await loadApiFootballBudget(kv);
  const goalsUsed = bud.goalsCount || 0;
  const total = apiFootballTotalCalls(bud);
  if (goalsUsed >= API_FB_GOALS_DAILY_MAX) return false;
  if (total >= API_FB_DAILY_TOTAL_MAX) return false;
  if (opts.bootstrap) return true;
  /* Backfill may issue several calls in one sync (season + ids batches). */
  if (opts.backfill) return true;
  if (bud.lastGoalsAt && now - bud.lastGoalsAt < minMs) return false;
  return true;
}

async function recordApiFootballCall(kv, now) {
  const bud = await loadApiFootballBudget(kv);
  bud.liveCount = (bud.liveCount || 0) + 1;
  bud.lastLiveAt = now;
  if (kv) {
    try { await kv.put(KV_API_FB, JSON.stringify(bud)); } catch { /* best-effort */ }
  }
}

async function recordApiFootballGoalsCall(kv, now) {
  const bud = await loadApiFootballBudget(kv);
  bud.goalsCount = (bud.goalsCount || 0) + 1;
  bud.lastGoalsAt = now;
  if (kv) {
    try { await kv.put(KV_API_FB, JSON.stringify(bud)); } catch { /* best-effort */ }
  }
}

async function fetchApiFootballLive(env) {
  const key = env.API_FOOTBALL_KEY;
  if (!key) return null;
  const url = env.API_FOOTBALL_URL || API_FOOTBALL_LIVE;
  try {
    const r = await fetch(url, { headers: { "x-apisports-key": key } });
    if (!r.ok) return null;
    const json = await r.json();
    if (!Array.isArray(json.response)) return null;
    return json.response.filter(isWcFixture);
  } catch {
    return null;
  }
}

function apiFootballHeaders(env) {
  return { "x-apisports-key": env.API_FOOTBALL_KEY };
}

async function fetchApiFootballJson(env, path) {
  if (!env.API_FOOTBALL_KEY) return null;
  const base = env.API_FOOTBALL_BASE || API_FOOTBALL_BASE;
  try {
    const r = await fetch(base + path, { headers: apiFootballHeaders(env) });
    if (!r.ok) return { rows: null, err: "HTTP " + r.status };
    const json = await r.json();
    if (json.errors && Object.keys(json.errors).length) {
      const msg = Object.values(json.errors).join("; ");
      return { rows: null, err: msg || "API error" };
    }
    if (!Array.isArray(json.response)) return { rows: null, err: "bad response" };
    return { rows: json.response, err: null };
  } catch (err) {
    return { rows: null, err: err.message || "fetch failed" };
  }
}

function isWcFixture(row) {
  if (!row) return false;
  if (!row.league) return true;
  const id = Number(row.league.id);
  if (id === WC_LEAGUE_ID) return true;
  const name = String(row.league.name || "").toLowerCase();
  return name.includes("world cup");
}

function filterWcFixtures(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.filter(isWcFixture);
}

async function fetchApiFootballFixturesByDate(env, dateStr) {
  if (!dateStr) return null;
  const q = "/fixtures?league=" + WC_LEAGUE_ID + "&season=" + WC_SEASON + "&date=" + encodeURIComponent(dateStr);
  const out = await fetchApiFootballJson(env, q);
  if (!out || !out.rows || !out.rows.length) return null;
  return filterWcFixtures(out.rows);
}

async function fetchApiFootballWcFinished(env, pendingDates) {
  const seen = new Set();
  const rows = [];

  const addRows = (list) => {
    for (const row of filterWcFixtures(list || [])) {
      const id = row.fixture && row.fixture.id;
      if (!id || seen.has(id)) continue;
      const short = row.fixture.status && row.fixture.status.short;
      if (short !== "FT" && short !== "AET" && short !== "PEN") continue;
      seen.add(id);
      rows.push(row);
    }
  };

  const seasonQ = "/fixtures?league=" + WC_LEAGUE_ID + "&season=" + WC_SEASON;
  const seasonOut = await fetchApiFootballJson(env, seasonQ);
  if (seasonOut && seasonOut.rows && seasonOut.rows.length) addRows(seasonOut.rows);
  if (rows.length) return rows;

  for (const status of ["FT", "AET", "PEN"]) {
    const q = "/fixtures?league=" + WC_LEAGUE_ID + "&season=" + WC_SEASON + "&status=" + status;
    const out = await fetchApiFootballJson(env, q);
    if (out && out.rows && out.rows.length) addRows(out.rows);
    if (rows.length) return rows;
  }

  if (pendingDates && pendingDates.length) {
    for (let di = 0; di < Math.min(pendingDates.length, 3); di++) {
      const out = await fetchApiFootballFixturesByDate(env, pendingDates[di]);
      if (out && out.length) addRows(out);
      if (rows.length) return rows;
    }
  }

  return null;
}

async function fetchApiFootballFixturesByIds(env, apiIds) {
  if (!apiIds || !apiIds.length) return null;
  const chunk = apiIds.slice(0, API_FB_GOALS_IDS_BATCH).join("-");
  const q = "/fixtures?ids=" + chunk;
  const out = await fetchApiFootballJson(env, q);
  if (!out || !out.rows || !out.rows.length) return null;
  return out.rows;
}

async function fetchApiFootballEvents(env, apiFixtureId) {
  if (!env.API_FOOTBALL_KEY || !apiFixtureId) return null;
  const base = env.API_FOOTBALL_BASE || API_FOOTBALL_BASE;
  const url = base + "/fixtures/events?fixture=" + encodeURIComponent(String(apiFixtureId));
  try {
    const r = await fetch(url, { headers: apiFootballHeaders(env) });
    if (!r.ok) return null;
    const json = await r.json();
    return Array.isArray(json.response) ? json.response : null;
  } catch {
    return null;
  }
}

function parseApiFootballGoalEvents(events) {
  if (!Array.isArray(events)) return [];
  const goals = [];
  for (const ev of events) {
    if (ev.type !== "Goal") continue;
    const team = canonTeam(ev.team) || (ev.team && ev.team.name) || null;
    const player = ev.player && ev.player.name ? ev.player.name : null;
    const assist = ev.assist && ev.assist.name ? ev.assist.name : null;
    const elapsed = ev.time && typeof ev.time.elapsed === "number" ? ev.time.elapsed : null;
    const extra = ev.time && typeof ev.time.extra === "number" ? ev.time.extra : 0;
    goals.push({
      minute: elapsed,
      extra: extra || 0,
      team,
      player,
      assist,
      detail: ev.detail || "Goal",
    });
  }
  goals.sort((a, b) => {
    const am = (a.minute != null ? a.minute : 0) + (a.extra || 0);
    const bm = (b.minute != null ? b.minute : 0) + (b.extra || 0);
    return am - bm;
  });
  return goals;
}

function fixtureDateFromTimes(fid, times) {
  const utc = times && times[fid];
  if (utc && utc.length >= 10) return utc.slice(0, 10);
  for (const m of MX) {
    if (m[0] === fid && m[4] && m[4].length >= 10) return m[4].slice(0, 10);
  }
  for (const k of KO) {
    if (k[0] === fid && k[4] && k[4].length >= 10) return k[4].slice(0, 10);
  }
  return null;
}

function fixtureNeedsGoals(fid, store) {
  const entry = store.byFixture && store.byFixture[String(fid)];
  return !entry || !entry.fetched;
}

function finishedDatesPending(results, times, store) {
  const dates = new Set();
  for (const id in results || {}) {
    const r = results[id];
    if (!r || r.st !== "FT") continue;
    const fid = parseInt(id, 10);
    if (isNaN(fid) || !fixtureNeedsGoals(fid, store)) continue;
    const d = fixtureDateFromTimes(fid, times);
    if (d) dates.add(d);
  }
  return [...dates].sort();
}

async function loadMatchGoalsStore(kv) {
  const empty = { byFixture: {}, datesFetched: [] };
  if (!kv) return empty;
  try {
    const raw = await kv.get(KV_MATCH_GOALS);
    if (!raw) return empty;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return empty;
    if (!parsed.byFixture) parsed.byFixture = {};
    if (!Array.isArray(parsed.datesFetched)) parsed.datesFetched = [];
    return parsed;
  } catch {
    return empty;
  }
}

async function saveMatchGoalsStore(kv, store) {
  if (!kv) return;
  try {
    store.updatedAt = Date.now();
    await kv.put(KV_MATCH_GOALS, JSON.stringify(store));
  } catch { /* persistence is best-effort */ }
}

function matchGoalsPayload(store) {
  const out = {};
  for (const id in store.byFixture || {}) {
    const entry = store.byFixture[id];
    if (!entry || !entry.fetched) continue;
    out[id] = { goals: entry.goals || [], apiId: entry.apiId || null };
  }
  return out;
}

function isoDateKey(iso) {
  if (!iso || typeof iso !== "string") return null;
  return iso.length >= 10 ? iso.slice(0, 10) : null;
}

function findFixtureSlotForApiEntry(entry, results, times) {
  const h = canonTeam(entry.teams && entry.teams.home);
  const a = canonTeam(entry.teams && entry.teams.away);

  if (h && a) {
    const slot = findFixtureIdByTeams(h, a, results);
    if (slot) return slot;
  }

  const entryDate = isoDateKey(entry.fixture && entry.fixture.date);
  if (h && a && entryDate) {
    for (const mx of MX) {
      const fid = mx[0];
      const r = results[fid];
      if (!r || r.st !== "FT") continue;
      const td = isoDateKey(times && times[fid]) || fixtureDateFromTimes(fid, times);
      if (td !== entryDate) continue;
      const t1 = mx[2];
      const t2 = mx[3];
      if (t1 === h && t2 === a) return { id: fid, homeIsFirst: true };
      if (t1 === a && t2 === h) return { id: fid, homeIsFirst: false };
    }
    for (const k of KO) {
      const t1 = gKT(k[2], results);
      const t2 = gKT(k[3], results);
      if (!t1 || !t2) continue;
      const r = results[k[0]];
      if (!r || r.st !== "FT") continue;
      const td = isoDateKey(times && times[k[0]]) || fixtureDateFromTimes(k[0], times);
      if (td !== entryDate) continue;
      if (t1 === h && t2 === a) return { id: k[0], homeIsFirst: true };
      if (t1 === a && t2 === h) return { id: k[0], homeIsFirst: false };
    }
  }

  const goals = entry.goals || {};
  const gh = goals.home;
  const ga = goals.away;
  if (gh == null || ga == null) return null;

  for (const mx of MX) {
    const fid = mx[0];
    const r = results[fid];
    if (!r || r.st !== "FT") continue;
    const t1 = mx[2];
    const t2 = mx[3];
    if (r.s1 === gh && r.s2 === ga) return { id: fid, homeIsFirst: true };
    if (r.s1 === ga && r.s2 === gh) return { id: fid, homeIsFirst: false };
  }

  for (const k of KO) {
    const t1 = gKT(k[2], results);
    const t2 = gKT(k[3], results);
    if (!t1 || !t2) continue;
    const r = results[k[0]];
    if (!r || r.st !== "FT") continue;
    if (r.s1 === gh && r.s2 === ga) return { id: k[0], homeIsFirst: t1 === (h || t1) };
    if (r.s1 === ga && r.s2 === gh) return { id: k[0], homeIsFirst: t2 === (h || t2) };
  }
  return null;
}

function applyGoalEventsToStore(entry, slot, store) {
  const key = String(slot.id);
  if (!store.byFixture) store.byFixture = {};
  const apiId = (entry.fixture && entry.fixture.id) || null;
  const events = entry.events || [];
  const goals = parseApiFootballGoalEvents(events);
  const prev = store.byFixture[key] ? JSON.stringify(store.byFixture[key]) : "";
  if (goals.length) {
    store.byFixture[key] = { apiId, goals, fetched: true, at: Date.now() };
    return prev !== JSON.stringify(store.byFixture[key]);
  }
  if (apiId) {
    store.byFixture[key] = { apiId, goals: [], fetched: false, needsEvents: true };
    return prev !== JSON.stringify(store.byFixture[key]);
  }
  store.byFixture[key] = { apiId: null, goals: [], fetched: true, at: Date.now() };
  return prev !== JSON.stringify(store.byFixture[key]);
}

function ingestApiFootballFixture(entry, results, times, store) {
  const slot = findFixtureSlotForApiEntry(entry, results, times);
  if (!slot) return false;

  const siteFt = results[slot.id] && results[slot.id].st === "FT";
  const fix = entry.fixture || {};
  const short = fix.status && fix.status.short;
  if (!siteFt && short !== "FT" && short !== "AET" && short !== "PEN") return false;

  return applyGoalEventsToStore(entry, slot, store);
}

function pendingGoalEventFixtures(store) {
  return Object.keys(store.byFixture || {}).filter((id) => {
    const e = store.byFixture[id];
    return e && e.needsEvents && e.apiId;
  });
}

async function fulfillPendingGoalEvents(env, kv, store, now, maxCalls, goalOpts) {
  const keys = pendingGoalEventFixtures(store);
  if (!keys.length) return 0;

  const apiIdToKey = {};
  const apiIds = [];
  for (const key of keys) {
    const entry = store.byFixture[key];
    if (!entry || !entry.apiId) continue;
    apiIdToKey[String(entry.apiId)] = key;
    apiIds.push(entry.apiId);
  }
  if (!apiIds.length) return 0;

  let calls = 0;
  for (let offset = 0; offset < apiIds.length && calls < maxCalls; offset += API_FB_GOALS_IDS_BATCH) {
    if (!await canCallApiFootballGoals(kv, now, goalOpts)) break;
    const batch = apiIds.slice(offset, offset + API_FB_GOALS_IDS_BATCH);
    const rows = await fetchApiFootballFixturesByIds(env, batch);
    if (!rows || !rows.length) break;
    await recordApiFootballGoalsCall(kv, now);
    calls++;

    for (const row of rows) {
      const apiId = row.fixture && row.fixture.id;
      const key = apiId != null ? apiIdToKey[String(apiId)] : null;
      if (!key) continue;
      const entry = store.byFixture[key];
      let goals = parseApiFootballGoalEvents(row.events || []);
      if (!goals.length && entry.apiId && calls < maxCalls && await canCallApiFootballGoals(kv, now, goalOpts)) {
        const ev = await fetchApiFootballEvents(env, entry.apiId);
        await recordApiFootballGoalsCall(kv, now);
        calls++;
        goals = parseApiFootballGoalEvents(ev || []);
      }
      entry.goals = goals;
      entry.fetched = true;
      entry.needsEvents = false;
      entry.at = Date.now();
      if (apiId) entry.apiId = apiId;
    }
  }
  return calls;
}

function matchGoalsStoreStats(store) {
  let fetched = 0;
  let pending = 0;
  for (const id in store.byFixture || {}) {
    const e = store.byFixture[id];
    if (!e) continue;
    if (e.fetched) fetched++;
    else pending++;
  }
  return { fetched, pending };
}

function repairEmptyFetchedGoals(store, results) {
  let touched = false;
  for (const id in store.byFixture || {}) {
    const e = store.byFixture[id];
    const r = results[id];
    if (!e || !e.fetched || !r || r.st !== "FT") continue;
    const total = (r.s1 || 0) + (r.s2 || 0);
    if (total > 0 && (!e.goals || !e.goals.length)) {
      e.fetched = false;
      if (e.apiId) e.needsEvents = true;
      touched = true;
    }
  }
  return touched;
}

async function syncMatchGoalsFromApiFootball(env, kv, results, times, now, isLive) {
  const store = await loadMatchGoalsStore(kv);
  const backfill = !isLive;
  const storeEmpty = !Object.keys(store.byFixture || {}).length;
  const goalOpts = { backfill, bootstrap: storeEmpty };
  const eventBatch = backfill ? API_FB_GOALS_BACKFILL_BATCH : 1;
  const maxRounds = backfill ? (storeEmpty ? 6 : API_FB_GOALS_BACKFILL_ROUNDS) : 1;
  let apiCalls = 0;
  let storeDirty = repairEmptyFetchedGoals(store, results);
  let goalsRows = 0;
  let goalsIngested = 0;
  let goalsErr = "";

  for (let round = 0; round < maxRounds; round++) {
    if (!pendingGoalEventFixtures(store).length) break;
    const batch = await fulfillPendingGoalEvents(env, kv, store, now, eventBatch, goalOpts);
    apiCalls += batch;
    if (batch) storeDirty = true;
    if (!batch) break;
  }

  const pending = finishedDatesPending(results, times, store);
  const pendingEvents = pendingGoalEventFixtures(store).length;
  if (env.API_FOOTBALL_KEY && (pending.length || pendingEvents) && await canCallApiFootballGoals(kv, now, goalOpts)) {
    let rows = null;

    if (backfill && pending.length >= 1) {
      rows = await fetchApiFootballWcFinished(env, pending);
      if (rows && rows.length) {
        await recordApiFootballGoalsCall(kv, now);
        apiCalls++;
      }
    }

    if ((!rows || !rows.length) && pending.length) {
      for (let di = 0; di < Math.min(pending.length, storeEmpty ? 6 : 3); di++) {
        if (!await canCallApiFootballGoals(kv, now, goalOpts)) break;
        const dated = await fetchApiFootballFixturesByDate(env, pending[di]);
        await recordApiFootballGoalsCall(kv, now);
        apiCalls++;
        if (dated && dated.length) {
          rows = (rows || []).concat(dated);
        }
      }
    }

    if ((!rows || !rows.length) && storeEmpty && await canCallApiFootballGoals(kv, now, goalOpts)) {
      const seasonOut = await fetchApiFootballJson(env, "/fixtures?league=" + WC_LEAGUE_ID + "&season=" + WC_SEASON);
      await recordApiFootballGoalsCall(kv, now);
      apiCalls++;
      if (seasonOut && seasonOut.rows && seasonOut.rows.length) {
        rows = filterWcFixtures(seasonOut.rows);
      } else if (seasonOut && seasonOut.err) {
        goalsErr = seasonOut.err;
      }
    }

    if (rows && rows.length) {
      goalsRows = rows.length;
      storeDirty = true;
      for (const row of rows) {
        if (ingestApiFootballFixture(row, results, times, store)) goalsIngested++;
      }
      for (let round = 0; round < maxRounds; round++) {
        if (!pendingGoalEventFixtures(store).length) break;
        const batch = await fulfillPendingGoalEvents(env, kv, store, now, eventBatch, goalOpts);
        apiCalls += batch;
        if (batch) storeDirty = true;
        if (!batch) break;
      }
    } else if (!goalsErr && !apiCalls) {
      goalsErr = "goals sync skipped (budget or no finished matches)";
    }
  }

  if (storeDirty || apiCalls) await saveMatchGoalsStore(kv, store);

  const stats = matchGoalsStoreStats(store);
  const goalsPending = finishedDatesPending(results, times, store).length + pendingGoalEventFixtures(store).length;
  return {
    goals: matchGoalsPayload(store),
    apiCalls,
    goalsPending,
    storeStats: stats,
    goalsRows,
    goalsIngested,
    goalsErr: goalsErr || null,
  };
}

async function goalsBackfillPending(env, kv, results, times) {
  if (!env.API_FOOTBALL_KEY || !kv) return false;
  const store = await loadMatchGoalsStore(kv);
  if (pendingGoalEventFixtures(store).length) return true;
  if (finishedDatesPending(results, times, store).length) return true;
  return false;
}

async function readMatchGoalsFromKv(kv) {
  if (!kv) return {};
  return matchGoalsPayload(await loadMatchGoalsStore(kv));
}

async function resolveMatchGoals(env, kv, results, times, now) {
  let matchGoals = {};
  let apiFbGoals = 0;
  let apiFbGoalsPending = 0;
  let apiFbGoalsStore = "";
  let apiFbGoalsRows = 0;
  let apiFbGoalsIngested = 0;
  let apiFbGoalsErr = "";

  if (!kv) {
    return {
      matchGoals, apiFbGoals, apiFbGoalsPending, apiFbGoalsStore,
      apiFbGoalsRows, apiFbGoalsIngested, apiFbGoalsErr,
    };
  }

  if (env.API_FOOTBALL_KEY) {
    const mgOut = await syncMatchGoalsFromApiFootball(env, kv, results, times, now, false);
    matchGoals = mgOut.goals || {};
    apiFbGoals = mgOut.apiCalls || 0;
    apiFbGoalsPending = mgOut.goalsPending || 0;
    apiFbGoalsRows = mgOut.goalsRows || 0;
    apiFbGoalsIngested = mgOut.goalsIngested || 0;
    apiFbGoalsErr = mgOut.goalsErr || "";
    if (mgOut.storeStats) {
      apiFbGoalsStore = mgOut.storeStats.fetched + "/" + (mgOut.storeStats.fetched + mgOut.storeStats.pending);
    }
  } else {
    matchGoals = await readMatchGoalsFromKv(kv);
  }

  return {
    matchGoals, apiFbGoals, apiFbGoalsPending, apiFbGoalsStore,
    apiFbGoalsRows, apiFbGoalsIngested, apiFbGoalsErr,
  };
}

function supplementFromApiFootball(rawMatches, results, fixtures) {
  let patched = 0;
  for (const entry of fixtures) {
    const h = canonTeam(entry.teams && entry.teams.home);
    const a = canonTeam(entry.teams && entry.teams.away);
    if (!h || !a) continue;
    const slot = findFixtureIdByTeams(h, a, results);
    if (!slot) continue;

    const af = liveResultFromApiFootball(entry, slot.homeIsFirst);
    if (!af) continue;

    const prev = results[slot.id];
    results[slot.id] = mergeApiFootballLive(prev, af);

    if (typeof entry.fixture?.status?.elapsed === "number") {
      for (const m of rawMatches) {
        const mh = canonTeam(m.homeTeam);
        const ma = canonTeam(m.awayTeam);
        if ((mh === h && ma === a) || (mh === a && ma === h)) {
          if (typeof m.minute !== "number") m.minute = af.min;
          break;
        }
      }
    }
    patched++;
  }
  return patched;
}

function isRealHalfTimePause(m, afterHt) {
  if (m.status !== "PAUSED") return false;
  if (halfTimeMatchesCurrentScore(m)) return false;
  if (afterHt) return false;
  const min = typeof m.minute === "number" ? m.minute : null;
  const ht = m.score && m.score.halfTime;
  const hasHt = ht && ht.home != null && ht.away != null;
  if (min != null && min < 40 && !hasHt) return false;
  if (min != null && min >= 40) return true;
  if (hasHt) return true;
  return min == null;
}

function estimatedMinuteFromKickoff(m, htDone) {
  if (!m.utcDate) return null;
  const ko = Date.parse(m.utcDate);
  if (isNaN(ko)) return null;
  let el = Math.floor((Date.now() - ko) / 60000);
  if (el < 0) return null;
  if (htDone) el = Math.max(46, el - 15);
  return el;
}

function livePeriodLabel(m, afterHt) {
  const dur = (m.score && m.score.duration) || "REGULAR";
  if (dur === "PENALTY_SHOOTOUT") return "Penalties";
  const liveMin = typeof m.minute === "number" ? m.minute : null;
  const htDone = afterHt || shouldTrustHalfTimeScore(m, liveMin);
  let min = liveMin;
  if (min == null) min = estimatedMinuteFromKickoff(m, htDone);

  if (m.status === "PAUSED" && isRealHalfTimePause(m, htDone)) return "HALF TIME";

  if (min == null) return htDone ? "2nd Half" : "1st Half";
  if (min > 105) return "2nd Half - Extra Time";
  if (min > 90 || dur === "EXTRA_TIME") return "1st Half - Extra Time";
  if (!htDone && min <= 45) return "1st Half";
  if (!htDone && min > 45) return "1st Half";
  if (htDone && min <= 90) return "2nd Half";
  return "2nd Half";
}

function readGoalsScore(m) {
  const goals = m.goals || (m.score && m.score.goals);
  if (!Array.isArray(goals) || !goals.length) return null;
  const last = goals[goals.length - 1];
  if (last && last.score && last.score.home != null && last.score.away != null) {
    return { s1: last.score.home, s2: last.score.away };
  }
  return null;
}

function readMatchScore(m, live) {
  const sc = m.score || {};
  const ft = sc.fullTime || {};
  const ht = sc.halfTime || {};
  const min = typeof m.minute === "number" ? m.minute : null;
  const fromGoals = readGoalsScore(m);

  if (live && fromGoals) {
    const goalTotal = fromGoals.s1 + fromGoals.s2;
    const ftTotal = (ft.home != null && ft.away != null) ? ft.home + ft.away : -1;
    if (goalTotal > ftTotal) return fromGoals;
  }

  if (ft.home != null && ft.away != null) return { s1: ft.home, s2: ft.away };
  if (ft.home != null || ft.away != null) return { s1: ft.home ?? 0, s2: ft.away ?? 0 };

  if (fromGoals) return fromGoals;

  if (live) {
    /* Never use frozen HT score during 2nd half — that was wiping real goals. */
    if (ht.home != null && ht.away != null && (min == null || min <= 45)) {
      return { s1: ht.home, s2: ht.away };
    }
    if (min == null || min <= 5) return { s1: 0, s2: 0 };
    return null;
  }

  if (ht.home != null && ht.away != null) return { s1: ht.home, s2: ht.away };
  return null;
}

function extractScore(m) {
  const status = m.status;
  const live = LIVE_STATUSES.includes(status);
  if (!live && !DONE_STATUSES.includes(status)) return null;
  const sc = m.score || {};
  const ht = sc.halfTime || {};
  const parsed = readMatchScore(m, live);
  if (!parsed) return null;
  const { s1, s2 } = parsed;
  const out = { s1, s2, st: live ? "LIVE" : "FT" };
  const liveMin = typeof m.minute === "number" ? m.minute : null;
  const htDone = shouldTrustHalfTimeScore(m, liveMin);
  if (htDone && ht.home != null && ht.away != null) { out.ht1 = ht.home; out.ht2 = ht.away; }
  if (live) {
    out.prd = livePeriodLabel(m, htDone);
    if (typeof m.minute === "number") out.min = m.minute;
    else {
      const est = estimatedMinuteFromKickoff(m, htDone);
      if (est != null) out.min = est;
    }
    if (m.status === "PAUSED") {
      out.clk = 1; /* freeze client clock — hydration breaks, VAR, etc. */
      if (isRealHalfTimePause(m, htDone)) {
        out.pp = 1;
        out.aht = 1;
      }
    }
    if (sc.duration) out.dur = sc.duration;
    if (htDone) out.aht = 1;
  }
  const pen = sc.penalties;
  if (pen && pen.home != null && pen.away != null) { out.p1 = pen.home; out.p2 = pen.away; }
  return out;
}

function finalizeScore(sc) {
  if (!sc) return null;
  const out = { ...sc, st: "FT" };
  delete out.min;
  delete out.pp;
  delete out.clk;
  delete out.prd;
  delete out.aht;
  delete out.dur;
  return out;
}

function findGroupFixture(h, a) {
  return MX.find((x) => (x[2] === h && x[3] === a) || (x[2] === a && x[3] === h));
}

/**
 * Maps API matches onto fixture IDs 1-104 and returns
 * { results, times, statuses, refs }
 */
function computeAuto(matches) {
  const results = {};
  const times = {};
  const statuses = {};
  const refs = {};
  const venues = {};

  const groupApi = [];
  const koApi = [];
  for (const m of matches) (isGroupStage(m) ? groupApi : koApi).push(m);

  for (const m of groupApi) {
    const h = canonTeam(m.homeTeam);
    const a = canonTeam(m.awayTeam);
    if (!h || !a) continue;
    const fx = MX.find((x) => (x[2] === h && x[3] === a) || (x[2] === a && x[3] === h));
    if (!fx) continue;
    if (m.utcDate) times[fx[0]] = m.utcDate;
    const ref = extractRef(m);
    if (ref) refs[fx[0]] = ref;
    const ven = extractVenue(m);
    if (ven) venues[fx[0]] = ven;
    if (m.status === "POSTPONED" || m.status === "CANCELLED") statuses[fx[0]] = m.status;
    const sc = extractScore(m);
    if (!sc) continue;
    const oriented = orientScore(sc, fx[2] === h);
    if (oriented.p1 == null) { delete oriented.p1; delete oriented.p2; }
    results[fx[0]] = oriented;
  }

  /* Knockouts chronologically so earlier rounds resolve later brackets */
  koApi.sort((x, y) => String(x.utcDate || "").localeCompare(String(y.utcDate || "")));
  const matched = new Set();
  for (let pass = 0; pass < 3; pass++) {
    let progress = false;
    for (const m of koApi) {
      if (matched.has(m.id)) continue;
      const h = canonTeam(m.homeTeam);
      const a = canonTeam(m.awayTeam);
      if (!h || !a) continue;
      for (const k of KO) {
        if (times[k[0]]) continue;
        if (!stageOk(k[1], m.stage)) continue;
        const t1 = gKT(k[2], results);
        const t2 = gKT(k[3], results);
        if (!t1 || !t2) continue;
        if (!((t1 === h && t2 === a) || (t1 === a && t2 === h))) continue;
        matched.add(m.id);
        if (m.utcDate) times[k[0]] = m.utcDate;
        const ref = extractRef(m);
        if (ref) refs[k[0]] = ref;
        const ven = extractVenue(m);
        if (ven) venues[k[0]] = ven;
        if (m.status === "POSTPONED" || m.status === "CANCELLED") statuses[k[0]] = m.status;
        const sc = extractScore(m);
        if (sc) {
          const oriented = orientScore(sc, t1 === h);
          if (oriented.p1 == null) { delete oriented.p1; delete oriented.p2; }
          results[k[0]] = oriented;
          progress = true;
        }
        break;
      }
    }
    if (!progress) break;
  }

  return { results, times, statuses, refs, venues };
}

/** Force FINISHED upstream matches over stale LIVE entries persisted in KV. */
function applyFinishedFromUpstream(rawMatches, results) {
  for (const m of rawMatches) {
    if (!DONE_STATUSES.includes(m.status)) continue;
    const h = canonTeam(m.homeTeam);
    const a = canonTeam(m.awayTeam);
    if (!h || !a) continue;

    if (isGroupStage(m)) {
      const fx = findGroupFixture(h, a);
      if (!fx) continue;
      let sc = extractScore(m);
      if (!sc) {
        const prev = results[fx[0]];
        if (!prev || prev.s1 == null || prev.s2 == null) continue;
        sc = finalizeScore(prev);
      } else {
        sc = finalizeScore(sc);
      }
      const oriented = orientScore(sc, fx[2] === h);
      if (oriented.p1 == null) { delete oriented.p1; delete oriented.p2; }
      results[fx[0]] = oriented;
      continue;
    }

    for (const k of KO) {
      const t1 = gKT(k[2], results);
      const t2 = gKT(k[3], results);
      if (!t1 || !t2) continue;
      if (!((t1 === h && t2 === a) || (t1 === a && t2 === h))) continue;
      let sc = extractScore(m);
      if (!sc) {
        const prev = results[k[0]];
        if (!prev || prev.s1 == null || prev.s2 == null) continue;
        sc = finalizeScore(prev);
      } else {
        sc = finalizeScore(sc);
      }
      const oriented = orientScore(sc, t1 === h);
      if (oriented.p1 == null) { delete oriented.p1; delete oriented.p2; }
      results[k[0]] = oriented;
      break;
    }
  }
}

/** Promote LIVE → FT when kickoff was longer ago than a match can run. */
function expireStaleLive(results, times, nowMs) {
  for (const id in results) {
    const r = results[id];
    if (!r || r.st !== "LIVE") continue;
    const utc = times[id];
    if (!utc) continue;
    const kickoff = new Date(utc).getTime();
    if (isNaN(kickoff) || nowMs - kickoff <= MATCH_WINDOW_MS) continue;
    if (r.s1 == null || r.s2 == null) continue;
    results[id] = finalizeScore(r);
  }
}

function reconcileResults(prevResults, computedResults, rawMatches, times, nowMs) {
  const results = { ...(prevResults || {}), ...(computedResults || {}) };
  applyFinishedFromUpstream(rawMatches, results);
  expireStaleLive(results, times, nowMs);
  for (const id in results) {
    const r = results[id];
    const prev = prevResults && prevResults[id];
    sanitizeFirstHalfLive(r, times[id], nowMs);
    if (!r || r.st !== "LIVE") continue;
    const htDone = isAfterHalfTime(r, prev, times[id], nowMs);
    if (!htDone) continue;
    r.aht = 1;
    if (r.pp) continue;
    const min = r.min;
    if (min != null && min > 90) r.dur = "EXTRA_TIME";
    else if (r.dur === "EXTRA_TIME") delete r.dur;
    if (min == null || min <= 90) {
      r.prd = "2nd Half";
      if (r.dur === "EXTRA_TIME") delete r.dur;
    } else if (min <= 105) r.prd = "1st Half - Extra Time";
    else r.prd = "2nd Half - Extra Time";
  }
  return results;
}

function anyLiveOrSoon(matches, now) {
  for (const m of matches) {
    if (LIVE_STATUSES.includes(m.status)) return true;
    if (!m.utcDate || DONE_STATUSES.includes(m.status)) continue;
    const diff = new Date(m.utcDate).getTime() - now;
    if (diff < KICKOFF_SOON_MS && diff > -MATCH_WINDOW_MS) return true;
  }
  return false;
}

/* ── Server-side live event feed (KV-backed, shared across all clients) ─ */
const FEED_DONE = { FT: 1, AET: 1, FT_PEN: 1, AP: 1, FINISHED: 1 };

function fixtureTeams(fid, results) {
  const id = parseInt(fid, 10);
  for (const m of MX) {
    if (m[0] === id) return [m[2], m[3]];
  }
  const t = gKM(id, results);
  return t && t[0] && t[1] ? t : [null, null];
}

function feedSnap(r) {
  if (!r) return { st: null, s1: null, s2: null, pp: false, min: null, ht1: null };
  return {
    st: r.st || null,
    s1: r.s1 != null ? r.s1 : null,
    s2: r.s2 != null ? r.s2 : null,
    pp: !!r.pp,
    min: r.min != null ? r.min : null,
    ht1: r.ht1 != null ? r.ht1 : null,
  };
}

function feedFinished(st) {
  return !!(st && FEED_DONE[st]);
}

function feedEventKey(e) {
  if (e.kind === "goal") {
    return e.fid + ":goal:" + e.s1 + "-" + e.s2;
  }
  return e.fid + ":" + e.kind;
}

function pickBetterGoalEvent(a, b) {
  if (!a) return b;
  if (!b) return a;
  if (a.gm != null && b.gm == null) return a;
  if (b.gm != null && a.gm == null) return b;
  return (a.at || 0) >= (b.at || 0) ? a : b;
}

function pruneGoalFeed(feed, results) {
  if (!feed || !feed.length) return [];
  const nonGoals = [];
  const goalsByFid = {};
  for (const e of feed) {
    if (e.kind !== "goal") {
      nonGoals.push(e);
      continue;
    }
    const fid = String(e.fid);
    if (!goalsByFid[fid]) goalsByFid[fid] = [];
    goalsByFid[fid].push(e);
  }

  const keptGoals = [];
  for (const fid in goalsByFid) {
    const r = results && results[fid];
    const target = r ? { s1: r.s1 || 0, s2: r.s2 || 0 } : null;
    const byScore = new Map();
    for (const g of goalsByFid[fid]) {
      const k = g.s1 + "-" + g.s2;
      byScore.set(k, pickBetterGoalEvent(byScore.get(k), g));
    }
    let chain = [...byScore.values()].sort((a, b) => {
      const am = a.gm != null ? a.gm : 999;
      const bm = b.gm != null ? b.gm : 999;
      return am - bm || (a.at || 0) - (b.at || 0);
    });
    const valid = [];
    for (const g of chain) {
      const prev = valid.length ? valid[valid.length - 1] : { s1: 0, s2: 0 };
      const step = (g.s1 + g.s2) - (prev.s1 + prev.s2);
      if (step === 1 && g.s1 >= prev.s1 && g.s2 >= prev.s2) valid.push(g);
    }
    if (!valid.length && target && (target.s1 + target.s2) > 0) {
      const exact = chain.find((g) => g.s1 === target.s1 && g.s2 === target.s2);
      if (exact) valid.push(exact);
    }
    keptGoals.push(...valid);
  }

  return nonGoals.concat(keptGoals)
    .sort((a, b) => (b.at || 0) - (a.at || 0))
    .slice(0, LIVE_FEED_MAX);
}

function feedTitle(kind) {
  return { kick: "Kick Off", goal: "Goal", ht: "Half Time", ft: "Full Time" }[kind] || kind;
}

function makeFeedEvent(kind, fid, t1, t2, s1, s2, scorer, minute, injuryTime, now) {
  const ev = {
    kind,
    fid: String(fid),
    t1,
    t2,
    s1,
    s2,
    title: feedTitle(kind),
    at: now,
  };
  if (scorer) ev.scorer = scorer;
  if (kind === "goal" && minute != null) {
    ev.gm = minute;
    if (injuryTime != null && injuryTime > 0) ev.gi = injuryTime;
  }
  return ev;
}

function normalizeFixtureGoals(m, homeIsFirst, t1, t2) {
  const goals = m.goals || [];
  if (!Array.isArray(goals) || !goals.length) return [];
  const out = [];
  for (const g of goals) {
    const team = canonTeam(g.team) || (g.team && g.team.name);
    if (!team) continue;
    const sc = g.score || {};
    let s1 = sc.home;
    let s2 = sc.away;
    if (s1 == null || s2 == null) continue;
    if (!homeIsFirst) { const tmp = s1; s1 = s2; s2 = tmp; }
    const scorer = team === t1 ? t1 : team === t2 ? t2 : team;
    const minute = typeof g.minute === "number" ? g.minute : null;
    const injuryTime = g.injuryTime != null ? g.injuryTime : null;
    out.push({
      minute,
      injuryTime,
      s1,
      s2,
      scorer,
      key: String(minute) + ":" + String(injuryTime || 0) + ":" + s1 + "-" + s2 + ":" + scorer,
    });
  }
  return out;
}

/** Maps fixture IDs to API goal entries (minute, score after goal, scorer team). */
function buildFixtureGoalIndex(rawMatches, results) {
  const index = {};
  const groupApi = [];
  const koApi = [];
  for (const m of rawMatches) (isGroupStage(m) ? groupApi : koApi).push(m);

  for (const m of groupApi) {
    const h = canonTeam(m.homeTeam);
    const a = canonTeam(m.awayTeam);
    if (!h || !a) continue;
    const fx = findGroupFixture(h, a);
    if (!fx) continue;
    const goals = normalizeFixtureGoals(m, fx[2] === h, fx[2], fx[3]);
    if (goals.length) index[fx[0]] = goals;
  }

  for (const m of koApi) {
    const h = canonTeam(m.homeTeam);
    const a = canonTeam(m.awayTeam);
    if (!h || !a) continue;
    for (const k of KO) {
      const t1 = gKT(k[2], results);
      const t2 = gKT(k[3], results);
      if (!t1 || !t2) continue;
      if (!((t1 === h && t2 === a) || (t1 === a && t2 === h))) continue;
      const goals = normalizeFixtureGoals(m, t1 === h, t1, t2);
      if (goals.length) index[k[0]] = goals;
      break;
    }
  }
  return index;
}

function feedHadHalfTime(feed, fid) {
  const k = String(fid);
  for (const e of feed || []) {
    if (e.fid === k && e.kind === "ht") return true;
  }
  return false;
}

function isFeedHalfTimePause(prev, cur, hadHt) {
  if (!cur.pp || prev.pp) return false;
  if (hadHt) return false;
  if (cur.min != null && cur.min < 40 && cur.ht1 == null) return false;
  return true;
}

function detectFeedEvents(prevResults, newResults, existingFeed, prevGoals, newGoals, now) {
  const events = [];
  const seen = new Set((existingFeed || []).map(feedEventKey));
  const ids = new Set();
  for (const k in prevResults || {}) ids.add(k);
  for (const k in newResults || {}) ids.add(k);

  for (const fid of ids) {
    const nr = newResults && newResults[fid];
    if (!nr) continue;
    const prev = feedSnap(prevResults && prevResults[fid]);
    const cur = feedSnap(nr);
    const [t1, t2] = fixtureTeams(fid, newResults);
    if (!t1 || !t2) continue;
    const hadHt = feedHadHalfTime(existingFeed, fid);

    function push(kind, s1, s2, scorer, minute, injuryTime) {
      const ev = makeFeedEvent(kind, fid, t1, t2, s1, s2, scorer, minute, injuryTime, now);
      const key = feedEventKey(ev);
      if (seen.has(key)) return;
      seen.add(key);
      events.push(ev);
    }

    if (!prevResults || !prevResults[fid]) {
      if (nr.st === "LIVE" && (nr.s1 || 0) === 0 && (nr.s2 || 0) === 0) push("kick", cur.s1, cur.s2, null, null, null);
      continue;
    }

    if (prev.st !== "LIVE" && cur.st === "LIVE") push("kick", cur.s1, cur.s2, null, null, null);

    const prevG = (prevGoals && prevGoals[fid]) || [];
    const newG = (newGoals && newGoals[fid]) || [];
    const prevGoalKeys = new Set(prevG.map((g) => g.key));
    const skipGoalBackfill = !prevG.length && ((prev.s1 || 0) + (prev.s2 || 0) > 0);

    if (newG.length && !skipGoalBackfill) {
      for (const g of newG) {
        if (prevGoalKeys.has(g.key)) continue;
        push("goal", g.s1, g.s2, g.scorer, g.minute, g.injuryTime);
      }
    } else if (!newG.length) {
      const ps1 = prev.s1 != null ? prev.s1 : 0;
      const ps2 = prev.s2 != null ? prev.s2 : 0;
      if (cur.s1 != null && cur.s2 != null) {
        const matchMin = cur.min != null ? cur.min : null;
        let s1 = ps1;
        let s2 = ps2;
        while (s1 < cur.s1) {
          s1++;
          push("goal", s1, s2, t1, matchMin, null);
        }
        while (s2 < cur.s2) {
          s2++;
          push("goal", s1, s2, t2, matchMin, null);
        }
      }
    }

    if (isFeedHalfTimePause(prev, cur, hadHt) || (prev.st !== "HT" && cur.st === "HT")) {
      push("ht", cur.s1, cur.s2, null, null, null);
    }

    if (!feedFinished(prev.st) && feedFinished(cur.st)) push("ft", cur.s1, cur.s2, null, null, null);
  }
  return events;
}

function purgeFinishedFeed(feed, results) {
  if (!feed || !feed.length) return [];
  return feed.filter((e) => {
    const r = results && results[e.fid];
    return !(r && feedFinished(r.st));
  });
}

function mergeLiveFeed(existing, additions) {
  const byKey = new Map();
  const all = (additions || []).concat(existing || []);
  for (const e of all) {
    const key = feedEventKey(e);
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, e);
      continue;
    }
    if (e.kind === "goal") byKey.set(key, pickBetterGoalEvent(prev, e));
    else if ((e.at || 0) > (prev.at || 0)) byKey.set(key, e);
  }
  return [...byKey.values()].slice(0, LIVE_FEED_MAX);
}

function synthesizeMissingFeedGoals(feed, results, now) {
  const goalsByFid = {};
  for (const e of feed || []) {
    if (e.kind !== "goal") continue;
    const fid = String(e.fid);
    if (!goalsByFid[fid]) goalsByFid[fid] = [];
    goalsByFid[fid].push(e);
  }
  const additions = [];
  for (const fid in results || {}) {
    const r = results[fid];
    if (!r || r.st !== "LIVE") continue;
    const targetS1 = r.s1 || 0;
    const targetS2 = r.s2 || 0;
    const targetTotal = targetS1 + targetS2;
    if (!targetTotal) continue;
    const existing = goalsByFid[fid] || [];
    const scoreSet = new Set(existing.map((e) => e.s1 + "-" + e.s2));
    if (existing.length >= targetTotal) continue;
    const [t1, t2] = fixtureTeams(fid, results);
    if (!t1 || !t2) continue;
    let s1 = 0;
    let s2 = 0;
    for (const e of existing) {
      if (e.s1 + e.s2 > s1 + s2) { s1 = e.s1; s2 = e.s2; }
    }
    const needed = [];
    while (s1 < targetS1) {
      s1++;
      const k = s1 + "-" + s2;
      if (!scoreSet.has(k)) needed.push({ s1, s2, scorer: t1 });
      scoreSet.add(k);
    }
    while (s2 < targetS2) {
      s2++;
      const k = s1 + "-" + s2;
      if (!scoreSet.has(k)) needed.push({ s1, s2, scorer: t2 });
      scoreSet.add(k);
    }
    const matchMin = r.min != null ? r.min : null;
    for (const g of needed) {
      additions.push(makeFeedEvent("goal", fid, t1, t2, g.s1, g.s2, g.scorer, matchMin, null, now));
    }
  }
  if (!additions.length) return feed;
  return mergeLiveFeed(feed, additions);
}

async function loadLiveFeed(kv) {
  if (!kv) return [];
  try {
    const raw = await kv.get(KV_LIVE_FEED);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function updateLiveFeed(kv, prevResults, newResults, prevGoals, newGoals, now) {
  if (!kv) return { feed: [], goalSnap: newGoals || {} };
  let feed = await loadLiveFeed(kv);
  feed = purgeFinishedFeed(feed, newResults);
  feed = pruneGoalFeed(feed, newResults);
  const additions = detectFeedEvents(prevResults, newResults, feed, prevGoals, newGoals, now);
  if (additions.length) feed = mergeLiveFeed(feed, additions);
  feed = pruneGoalFeed(feed, newResults);
  feed = synthesizeMissingFeedGoals(feed, newResults, now);
  return { feed, goalSnap: newGoals || {} };
}

/* ── Scorers + Squads (cached separately, lower refresh rate) ───── */

async function fetchScorers(env, kv, now) {
  /* Return cached scorers if fresh enough */
  if (kv) {
    try {
      const raw = await kv.get(KV_SCORERS);
      if (raw) {
        const cached = JSON.parse(raw);
        if (cached.ts && now - cached.ts < SCORERS_TTL_MS) return cached.data;
      }
    } catch { /* refetch below */ }
  }

  const apiKey = env.FOOTBALL_DATA_KEY;
  if (!apiKey) return null;

  try {
    const url = (env.FOOTBALL_DATA_URL || "https://api.football-data.org")
      + "/v4/competitions/WC/scorers?limit=30";
    const res = await fetch(url, { headers: { "X-Auth-Token": apiKey } });
    if (!res.ok) return null;
    const json = await res.json();
    const scorers = (json.scorers || []).map((s) => {
      const teamName = s.team ? canonTeam(s.team) || s.team.name || s.team.shortName : "Unknown";
      return {
        name: s.player ? s.player.name : "Unknown",
        team: teamName,
        goals: s.goals || 0,
        assists: s.assists || 0,
        penalties: s.penalties || 0,
        matchesPlayed: s.playedMatches || 0,
      };
    });
    if (kv && scorers.length) {
      try { await kv.put(KV_SCORERS, JSON.stringify({ ts: now, data: scorers })); } catch {}
    }
    return scorers;
  } catch { return null; }
}

async function fetchSquads(env, kv, now) {
  /* Return cached squads if fresh enough */
  if (kv) {
    try {
      const raw = await kv.get(KV_SQUADS);
      if (raw) {
        const cached = JSON.parse(raw);
        if (cached.ts && now - cached.ts < SQUADS_TTL_MS) return cached.data;
      }
    } catch { /* refetch below */ }
  }

  const apiKey = env.FOOTBALL_DATA_KEY;
  if (!apiKey) return null;

  try {
    const url = (env.FOOTBALL_DATA_URL || "https://api.football-data.org")
      + "/v4/competitions/WC/teams";
    const res = await fetch(url, { headers: { "X-Auth-Token": apiKey } });
    if (!res.ok) return null;
    const json = await res.json();
    const squads = {};
    for (const team of (json.teams || [])) {
      const name = canonTeam(team) || team.name || team.shortName;
      if (!name || !team.squad || !team.squad.length) continue;
      squads[name] = team.squad.map((p) => ({
        name: p.name,
        position: ({"Defence":"Defender","Midfield":"Midfielder","Offence":"Forward"})[p.position] || p.position || "Other",
        number: p.shirtNumber || null,
        nationalityCode: p.nationality ? p.nationality.substring(0, 2).toLowerCase() : null,
      }));
    }
    if (kv && Object.keys(squads).length) {
      try { await kv.put(KV_SQUADS, JSON.stringify({ ts: now, data: squads })); } catch {}
    }
    return squads;
  } catch { return null; }
}

/* ── Request handling ────────────────────────────────────────────────── */
function jsonResp(body, extra = {}) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", ...extra },
  });
}

function getEdgeCache() {
  try { return typeof caches !== "undefined" && caches.default ? caches.default : null; }
  catch { return null; }
}

const LIVE_RESULT_STATUSES = { LIVE: 1, HT: 1, "1H": 1, "2H": 1, ET: 1, P: 1, BT: 1, PEN: 1 };

function payloadNeedsRevalidate(cached, now) {
  if (!cached) return true;
  const age = now - (cached.syncedAt || 0);
  if (age < LIVE_REVALIDATE_MS) return false;
  if (cached.live) return true;
  for (const id in cached.results || {}) {
    const r = cached.results[id];
    if (r && LIVE_RESULT_STATUSES[r.st]) return true;
  }
  for (const m of cached.matches || []) {
    if (LIVE_STATUSES.includes(m.status)) return true;
    if (!m.utcDate || DONE_STATUSES.includes(m.status)) continue;
    const diff = new Date(m.utcDate).getTime() - now;
    if (diff < KICKOFF_SOON_MS && diff > -MATCH_WINDOW_MS) return true;
  }
  for (const id in cached.times || {}) {
    const utc = cached.times[id];
    if (!utc) continue;
    const diff = new Date(utc).getTime() - now;
    if (diff < KICKOFF_SOON_MS && diff > -MATCH_WINDOW_MS) return true;
  }
  return age > IDLE_TTL_S * 1000;
}

async function enrichCachedPayload(cached, kv) {
  if (!cached || !kv) return cached;
  const feed = await loadLiveFeed(kv);
  if (!feed.length) return cached;
  return {
    ...cached,
    liveFeed: feed,
    results: applyFeedToResults(cached.results || {}, feed),
  };
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const now = Date.now();
  const edge = getEdgeCache();
  const cacheKey = new Request(new URL("/api/matches", request.url).toString(), { method: "GET" });
  const kv = env.WC_LEAGUE;

  if (edge) {
    const hit = await edge.match(cacheKey);
    if (hit) {
      let cached;
      try { cached = await hit.json(); } catch { cached = null; }
      if (cached && !payloadNeedsRevalidate(cached, now)) {
        if (kv) cached = await enrichCachedPayload(cached, kv);
        if (kv) {
          const kvGoals = env.API_FOOTBALL_KEY ? await readMatchGoalsFromKv(kv) : {};
          let autoGoals = {};
          try {
            const raw = await kv.get(KV_AUTO);
            if (raw) autoGoals = (JSON.parse(raw).matchGoals) || {};
          } catch { /* best-effort */ }
          cached.matchGoals = { ...(cached.matchGoals || {}), ...(autoGoals || {}), ...kvGoals };
        }
        const resp = jsonResp(cached, {
          "X-Cache": "HIT",
          "Cache-Control": cached.live ? "no-store" : "public, max-age=15, s-maxage=30",
          ...(env.API_FOOTBALL_KEY ? { "X-Api-Football-Configured": "1" } : {}),
          ...(Object.keys(cached.matchGoals || {}).length ? { "X-Match-Goals": String(Object.keys(cached.matchGoals).length) } : {}),
        });
        if (kv) {
          context.waitUntil((async () => {
            try {
              let auto = {};
              const raw = await kv.get(KV_AUTO);
              if (raw) auto = JSON.parse(raw);
              const results = auto.results || cached.results || {};
              const times = auto.times || cached.times || {};
              const needsGoals = !Object.keys(cached.matchGoals || {}).length
                || (env.API_FOOTBALL_KEY && await goalsBackfillPending(env, kv, results, times));
              if (!needsGoals) return;
              const mg = await resolveMatchGoals(env, kv, results, times, Date.now());
              if (JSON.stringify(auto.matchGoals) !== JSON.stringify(mg.matchGoals)) {
                await kv.put(KV_AUTO, JSON.stringify({ ...auto, results, times, matchGoals: mg.matchGoals, syncedAt: Date.now() }));
              }
            } catch { /* backfill is best-effort */ }
          })());
        }
        return resp;
      }
      if (!cached) {
        const resp = new Response(hit.body, hit);
        resp.headers.set("X-Cache", "HIT");
        return resp;
      }
      /* Stale during live window — fall through to upstream refresh */
    }
  }

  let kvBlob = null;
  if (kv) {
    try {
      const raw = await kv.get(KV_CACHE);
      if (raw) kvBlob = JSON.parse(raw);
    } catch { /* corrupt cache — refetch */ }
  }

  const apiKey = env.FOOTBALL_DATA_KEY;
  let upstreamJson = null;
  let upstreamErr = null;
  if (!apiKey) {
    upstreamErr = "FOOTBALL_DATA_KEY env var not set";
  } else {
    try {
      /* FOOTBALL_DATA_URL is only for local dev/testing against a mock */
      const upstream = await fetch(env.FOOTBALL_DATA_URL || UPSTREAM, { headers: { "X-Auth-Token": apiKey } });
      if (!upstream.ok) upstreamErr = "Upstream HTTP " + upstream.status;
      else upstreamJson = await upstream.json();
    } catch (err) {
      upstreamErr = err.message;
    }
  }

  /* The matches list omits the live match clock — only the per-match
     endpoint has `minute`. Fetch details for currently-live matches only
     (≤4 at a time at a World Cup), so worst case ~5 upstream calls per
     refresh, and refreshes are edge-cache-gated to ~1/min. */
  if (upstreamJson && Array.isArray(upstreamJson.matches)) {
    const liveNow = upstreamJson.matches.filter((m) => LIVE_STATUSES.includes(m.status)).slice(0, 6);
    await Promise.all(liveNow.map(async (m) => {
      try {
        const r = await fetch(matchDetailUrl(env, m.id), { headers: apiDetailHeaders(apiKey) });
        if (!r.ok) return;
        const detail = await r.json();
        applyLiveDetail(m, detail);
      } catch { /* clock is cosmetic — never fail the refresh over it */ }
    }));
  }

  if (!upstreamJson || !Array.isArray(upstreamJson.matches)) {
    if (kvBlob && kvBlob.payload) {
      const stale = { ...kvBlob.payload, source: "stale" };
      if (!stale.liveFeed) stale.liveFeed = await loadLiveFeed(kv);
      if (stale.liveFeed && stale.liveFeed.length && stale.results) {
        stale.results = applyFeedToResults(stale.results, stale.liveFeed);
      }
      if (kv) {
        const results = stale.results || {};
        const times = stale.times || {};
        const mg = await resolveMatchGoals(env, kv, results, times, now);
        stale.matchGoals = mg.matchGoals;
        context.waitUntil((async () => {
          try {
            let prev = null;
            const prevRaw = await kv.get(KV_AUTO);
            if (prevRaw) prev = JSON.parse(prevRaw);
            if (!prev || JSON.stringify(prev.matchGoals) !== JSON.stringify(mg.matchGoals)) {
              await kv.put(KV_AUTO, JSON.stringify({
                results: prev && prev.results ? prev.results : results,
                times: prev && prev.times ? prev.times : times,
                statuses: prev && prev.statuses ? prev.statuses : stale.statuses || {},
                refs: prev && prev.refs ? prev.refs : stale.refs || {},
                venues: prev && prev.venues ? prev.venues : stale.venues || {},
                goalSnap: prev && prev.goalSnap ? prev.goalSnap : stale.goalSnap || {},
                matchGoals: mg.matchGoals,
                syncedAt: now,
              }));
            }
          } catch { /* persistence is best-effort */ }
        })());
      }
      /* Short edge TTL so we retry upstream soon, but absorb bursts */
      const resp = jsonResp(stale, {
        "Cache-Control": "public, max-age=10, s-maxage=30",
        "X-Cache": "KV-STALE",
        "X-Upstream-Error": String(upstreamErr).slice(0, 100),
        ...(env.API_FOOTBALL_KEY ? { "X-Api-Football-Configured": "1" } : {}),
        ...(Object.keys(stale.matchGoals || {}).length ? { "X-Match-Goals": String(Object.keys(stale.matchGoals).length) } : {}),
      });
      if (edge) context.waitUntil(edge.put(cacheKey, resp.clone()));
      return resp;
    }
    return new Response(JSON.stringify({ error: upstreamErr || "Upstream error" }), {
      status: 502, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }

  const rawMatches = upstreamJson.matches;
  const matches = rawMatches.map(trimMatch);
  const computed = computeAuto(rawMatches);

  let prevAuto = null;
  if (kv) {
    try {
      const prevRaw = await kv.get(KV_AUTO);
      if (prevRaw) prevAuto = JSON.parse(prevRaw);
    } catch { /* reconcile from empty prev */ }
  }

  const times = mergeMeta(prevAuto && prevAuto.times, computed.times);
  let results = reconcileResults(prevAuto && prevAuto.results, computed.results, rawMatches, times, now);
  const statuses = mergeMeta(prevAuto && prevAuto.statuses, computed.statuses);
  const refs = mergeMeta(prevAuto && prevAuto.refs, computed.refs);
  const venues = mergeMeta(prevAuto && prevAuto.venues, computed.venues);

  const goalSnap = buildFixtureGoalIndex(rawMatches, results);
  applyGoalSnapToLiveResults(results, goalSnap);

  let apiFbSupplement = 0;
  if (env.API_FOOTBALL_KEY && await canCallApiFootball(kv, now) && needsApiFootballSupplement(rawMatches, results, goalSnap)) {
    const afLive = await fetchApiFootballLive(env);
    if (afLive && afLive.length) {
      apiFbSupplement = supplementFromApiFootball(rawMatches, results, afLive);
      if (apiFbSupplement > 0) await recordApiFootballCall(kv, now);
    }
  }

  let matchGoals = {};
  let apiFbGoals = 0;
  let apiFbGoalsPending = 0;
  let apiFbGoalsStore = "";
  let apiFbGoalsRows = 0;
  let apiFbGoalsIngested = 0;
  let apiFbGoalsErr = "";
  if (kv) {
    const mg = await resolveMatchGoals(env, kv, results, times, now);
    matchGoals = mg.matchGoals;
    apiFbGoals = mg.apiFbGoals;
    apiFbGoalsPending = mg.apiFbGoalsPending;
    apiFbGoalsStore = mg.apiFbGoalsStore;
    apiFbGoalsRows = mg.apiFbGoalsRows || 0;
    apiFbGoalsIngested = mg.apiFbGoalsIngested || 0;
    apiFbGoalsErr = mg.apiFbGoalsErr || "";
  }

  const prevResults = prevAuto && prevAuto.results ? prevAuto.results : {};
  const prevGoalSnap = prevAuto && prevAuto.goalSnap ? prevAuto.goalSnap : {};

  /* Fetch scorers + squads in parallel (non-blocking, cached) */
  const [scorers, squads, feedOut] = await Promise.all([
    fetchScorers(env, kv, now).catch(() => null),
    fetchSquads(env, kv, now).catch(() => null),
    updateLiveFeed(kv, prevResults, results, prevGoalSnap, goalSnap, now),
  ]);
  const liveFeed = feedOut.feed || [];
  applyFeedScoresToLiveResults(results, liveFeed);
  const live = anyLiveOrSoon(matches, now);
  const payload = { syncedAt: now, live, results, times, statuses, refs, venues, scorers: scorers || [], squads: squads || {}, matches, liveFeed: liveFeed || [], matchGoals, source: "api" };
  const ttl = live ? LIVE_TTL_S : IDLE_TTL_S;
  const browserMaxAge = live ? 0 : 20;

  const resp = jsonResp(payload, {
    "Cache-Control": "public, max-age=" + browserMaxAge + ", s-maxage=" + ttl,
    "X-Cache": "MISS",
    "X-Live": String(live),
    ...(env.API_FOOTBALL_KEY ? { "X-Api-Football-Configured": "1" } : {}),
    ...(apiFbSupplement > 0 ? { "X-Api-Football": String(apiFbSupplement) } : {}),
    ...(apiFbGoals > 0 ? { "X-Api-Football-Goals": String(apiFbGoals) } : {}),
    ...(typeof apiFbGoalsPending === "number" && apiFbGoalsPending > 0 ? { "X-Api-Football-Goals-Pending": String(apiFbGoalsPending) } : {}),
    ...(apiFbGoalsStore ? { "X-Api-Football-Goals-Store": apiFbGoalsStore } : {}),
    ...(apiFbGoalsRows > 0 ? { "X-Api-Football-Goals-Rows": String(apiFbGoalsRows) } : {}),
    ...(apiFbGoalsIngested > 0 ? { "X-Api-Football-Goals-Ingested": String(apiFbGoalsIngested) } : {}),
    ...(apiFbGoalsErr ? { "X-Api-Football-Goals-Err": String(apiFbGoalsErr).slice(0, 120) } : {}),
    ...(Object.keys(matchGoals).length ? { "X-Match-Goals": String(Object.keys(matchGoals).length) } : {}),
  });

  context.waitUntil((async () => {
    try {
      if (edge) await edge.put(cacheKey, resp.clone());
      if (!kv) return;
      /* Persist auto results only when they changed (KV write budget) */
      let prev = null;
      try {
        const prevRaw = await kv.get(KV_AUTO);
        if (prevRaw) prev = JSON.parse(prevRaw);
      } catch { /* rewrite below */ }
      /* Ignore the live match clock (min/pp) when deciding whether to
         write — otherwise every refresh during a live match would burn a
         KV write even with no goals. */
      const stripClock = (rs) => {
        const out = {};
        for (const id in rs || {}) {
          const { min, pp, clk, prd, dur, aht, ...rest } = rs[id];
          out[id] = rest;
        }
        return out;
      };
      const changed = !prev ||
        JSON.stringify({ r: stripClock(prev.results), t: prev.times, s: prev.statuses, rf: prev.refs, v: prev.venues }) !==
        JSON.stringify({ r: stripClock(results), t: times, s: statuses, rf: refs, v: venues });
      const goalSnapChanged = JSON.stringify(prev && prev.goalSnap) !== JSON.stringify(goalSnap);
      const matchGoalsChanged = JSON.stringify(prev && prev.matchGoals) !== JSON.stringify(matchGoals);
      if (changed || goalSnapChanged || matchGoalsChanged) {
        await kv.put(KV_AUTO, JSON.stringify({ results, times, statuses, refs, venues, goalSnap, matchGoals, syncedAt: now }));
      }
      let prevFeed = [];
      try {
        const feedRaw = await kv.get(KV_LIVE_FEED);
        if (feedRaw) prevFeed = JSON.parse(feedRaw);
        if (!Array.isArray(prevFeed)) prevFeed = [];
      } catch { prevFeed = []; }
      if (JSON.stringify(prevFeed) !== JSON.stringify(liveFeed)) {
        await kv.put(KV_LIVE_FEED, JSON.stringify(liveFeed));
      }
      const kvStaleAge = kvBlob && kvBlob.ts ? now - kvBlob.ts : Infinity;
      if (changed || kvStaleAge > KV_REWRITE_MS) {
        await kv.put(KV_CACHE, JSON.stringify({ ts: now, payload }));
      }
    } catch { /* persistence is best-effort */ }
  })());

  return resp;
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" },
  });
}

/* Exported for tests only — Pages routing ignores non-handler exports */
export { MX, KO, computeAuto, detectFeedEvents, mergeLiveFeed, purgeFinishedFeed, reconcileResults, buildFixtureGoalIndex };
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
 * KV binding: WC_LEAGUE
 */

const UPSTREAM = "https://api.football-data.org/v4/competitions/WC/matches";
const KV_CACHE = "cache:matches:v2";
const KV_AUTO = "global:auto";
const LIVE_TTL_S = 55;
const IDLE_TTL_S = 300;
const KV_REWRITE_MS = 10 * 60 * 1000;
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
};

function norm(s) {
  return String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

const TEAM_LOOKUP = {};
for (const g of GL) for (const t of GRP[g]) TEAM_LOOKUP[norm(t)] = t;
for (const a in ALIASES) TEAM_LOOKUP[norm(a)] = ALIASES[a];

function canonTeam(team) {
  if (!team) return null;
  for (const candidate of [team.name, team.shortName, team.tla]) {
    const hit = TEAM_LOOKUP[norm(candidate)];
    if (hit) return hit;
  }
  return null;
}

/* ── Group standings + bracket resolution (port of index.html logic) ── */
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
  arr.sort((a, b) => b[1].pts - a[1].pts || b[1].gd - a[1].gd || b[1].gf - a[1].gf);
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

function extractScore(m) {
  const status = m.status;
  const live = LIVE_STATUSES.includes(status);
  if (!live && !DONE_STATUSES.includes(status)) return null;
  const sc = m.score || {};
  const ft = sc.fullTime || {};
  const ht = sc.halfTime || {};
  let s1 = ft.home != null ? ft.home : ht.home != null ? ht.home : (live ? 0 : null);
  let s2 = ft.away != null ? ft.away : ht.away != null ? ht.away : (live ? 0 : null);
  if (s1 == null || s2 == null) return null;
  const out = { s1, s2, st: live ? "LIVE" : "FT" };
  if (live) {
    /* The feed's own match clock lags with its scores, so the client can
       show a clock consistent with the (delayed) scoreline. */
    if (typeof m.minute === "number") out.min = m.minute;
    if (status === "PAUSED") out.pp = 1;
  }
  const pen = sc.penalties;
  if (pen && pen.home != null && pen.away != null) { out.p1 = pen.home; out.p2 = pen.away; }
  return out;
}

/**
 * Maps API matches onto fixture IDs 1-104 and returns
 * { results: {id:{s1,s2,st,p1?,p2?}}, times: {id:utcDate} }
 */
function computeAuto(matches) {
  const results = {};
  const times = {};

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
    const sc = extractScore(m);
    if (!sc) continue;
    const oriented = fx[2] === h ? sc : { ...sc, s1: sc.s2, s2: sc.s1, p1: sc.p2, p2: sc.p1 };
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
        const sc = extractScore(m);
        if (sc) {
          const oriented = t1 === h ? sc : { ...sc, s1: sc.s2, s2: sc.s1, p1: sc.p2, p2: sc.p1 };
          if (oriented.p1 == null) { delete oriented.p1; delete oriented.p2; }
          results[k[0]] = oriented;
          progress = true;
        }
        break;
      }
    }
    if (!progress) break;
  }

  return { results, times };
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

export async function onRequestGet(context) {
  const { request, env } = context;
  const now = Date.now();
  const edge = getEdgeCache();
  const cacheKey = new Request(new URL("/api/matches", request.url).toString(), { method: "GET" });

  if (edge) {
    const hit = await edge.match(cacheKey);
    if (hit) {
      const resp = new Response(hit.body, hit);
      resp.headers.set("X-Cache", "HIT");
      return resp;
    }
  }

  const kv = env.WC_LEAGUE;
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
    const liveNow = upstreamJson.matches.filter((m) => LIVE_STATUSES.includes(m.status)).slice(0, 4);
    await Promise.all(liveNow.map(async (m) => {
      try {
        const detailUrl = env.FOOTBALL_DATA_URL
          ? new URL("/v4/matches/" + m.id, env.FOOTBALL_DATA_URL).toString()
          : "https://api.football-data.org/v4/matches/" + m.id;
        const r = await fetch(detailUrl, { headers: { "X-Auth-Token": apiKey } });
        if (!r.ok) return;
        const detail = await r.json();
        const src = detail && typeof detail.minute !== "undefined" ? detail : detail && detail.match;
        const min = src ? parseInt(src.minute, 10) : NaN;
        if (!isNaN(min)) m.minute = min;
      } catch { /* clock is cosmetic — never fail the refresh over it */ }
    }));
  }

  if (!upstreamJson || !Array.isArray(upstreamJson.matches)) {
    if (kvBlob && kvBlob.payload) {
      const stale = { ...kvBlob.payload, source: "stale" };
      /* Short edge TTL so we retry upstream soon, but absorb bursts */
      const resp = jsonResp(stale, { "Cache-Control": "public, max-age=10, s-maxage=30", "X-Cache": "KV-STALE", "X-Upstream-Error": String(upstreamErr).slice(0, 100) });
      if (edge) context.waitUntil(edge.put(cacheKey, resp.clone()));
      return resp;
    }
    return new Response(JSON.stringify({ error: upstreamErr || "Upstream error" }), {
      status: 502, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }

  const matches = upstreamJson.matches.map(trimMatch);
  const { results, times } = computeAuto(matches);
  const live = anyLiveOrSoon(matches, now);
  const payload = { syncedAt: now, live, results, times, matches, source: "api" };
  const ttl = live ? LIVE_TTL_S : IDLE_TTL_S;

  const resp = jsonResp(payload, {
    "Cache-Control": "public, max-age=20, s-maxage=" + ttl,
    "X-Cache": "MISS",
    "X-Live": String(live),
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
          const { min, pp, ...rest } = rs[id];
          out[id] = rest;
        }
        return out;
      };
      const changed = !prev ||
        JSON.stringify({ r: stripClock(prev.results), t: prev.times }) !== JSON.stringify({ r: stripClock(results), t: times });
      if (changed) {
        await kv.put(KV_AUTO, JSON.stringify({ results, times, syncedAt: now }));
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
export { MX, KO, computeAuto };

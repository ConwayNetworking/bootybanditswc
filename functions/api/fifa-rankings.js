/**
 * GET /api/fifa-rankings
 *
 * Proxies FIFA men's world rankings from inside.fifa.com (unofficial JSON feed
 * used by their site — no public API). Cached in KV to avoid hammering FIFA.
 *
 * KV binding: WC_LEAGUE
 */

const FIFA_PAGE = "https://inside.fifa.com/fifa-world-ranking/men";
const FIFA_API = "https://inside.fifa.com/api/ranking-overview";
const FIFA_LIVE_API = "https://inside.fifa.com/api/live-world-ranking/get-rankings";
const KV_KEY = "global:fifa_rankings";
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const EDGE_TTL_S = 300;

const WC_TEAMS = [
  "Algeria", "Argentina", "Australia", "Austria", "Belgium", "Bosnia & Herzegovina",
  "Brazil", "Canada", "Cape Verde", "Colombia", "Croatia", "Curacao", "Czech Republic",
  "DR Congo", "Ecuador", "Egypt", "England", "France", "Germany", "Ghana", "Haiti",
  "Iran", "Iraq", "Ivory Coast", "Japan", "Jordan", "Mexico", "Morocco", "Netherlands",
  "New Zealand", "Norway", "Panama", "Paraguay", "Portugal", "Qatar", "Saudi Arabia",
  "Scotland", "Senegal", "South Africa", "South Korea", "Spain", "Sweden", "Switzerland",
  "Tunisia", "Turkey", "Uruguay", "USA", "Uzbekistan",
];

const ALIASES = {
  "Korea Republic": "South Korea",
  "Czechia": "Czech Republic",
  "Cote d'Ivoire": "Ivory Coast",
  "Côte d'Ivoire": "Ivory Coast",
  "Cabo Verde": "Cape Verde",
  "Congo DR": "DR Congo",
  "Congo": "DR Congo",
  "Bosnia and Herzegovina": "Bosnia & Herzegovina",
  "Bosnia-Herzegovina": "Bosnia & Herzegovina",
  "IR Iran": "Iran",
  "Turkiye": "Turkey",
  "Türkiye": "Turkey",
  "United States": "USA",
  "United States of America": "USA",
  "Saudi-Arabia": "Saudi Arabia",
  "Curaçao": "Curacao",
};

function norm(s) {
  return String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

const WC_SET = new Set(WC_TEAMS);
const TEAM_LOOKUP = {};
for (const t of WC_TEAMS) TEAM_LOOKUP[norm(t)] = t;
for (const a in ALIASES) {
  const mapped = ALIASES[a];
  if (WC_SET.has(mapped)) TEAM_LOOKUP[norm(a)] = mapped;
}

function canonName(name) {
  if (!name) return null;
  const hit = TEAM_LOOKUP[norm(name)];
  return hit && WC_SET.has(hit) ? hit : null;
}

function jsonResp(body, extra = {}) {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", ...extra },
  });
}

function getEdgeCache() {
  try { return typeof caches !== "undefined" && caches.default ? caches.default : null; }
  catch { return null; }
}

const FIFA_HEADERS = {
  "User-Agent": "wc2026-fantasy/1.0 (+https://itsimplywc.pages.dev)",
  Accept: "application/json, text/html",
};

function parseDateIds(html) {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return [];
  let data;
  try { data = JSON.parse(m[1]); } catch { return []; }
  const years = data?.props?.pageProps?.pageData?.ranking?.dates;
  if (!Array.isArray(years)) return [];
  const out = [];
  for (const y of years) {
    for (const d of y.dates || []) {
      if (d && d.id) out.push({ id: d.id, iso: d.iso || null, label: d.dateText || null });
    }
  }
  return out;
}

async function fetchOverview(dateId) {
  const url = FIFA_API + "?locale=en&dateId=" + encodeURIComponent(dateId);
  const res = await fetch(url, { headers: FIFA_HEADERS });
  if (!res.ok) return null;
  const json = await res.json();
  if (!json || !Array.isArray(json.rankings) || !json.rankings.length) return null;
  return json;
}

function buildPayload(overview, meta) {
  const rankings = {};
  for (const row of overview.rankings) {
    const item = row.rankingItem;
    if (!item || item.rank == null) continue;
    const team = canonName(item.name);
    if (!team) continue;
    rankings[team] = {
      rank: item.rank,
      points: Math.round(item.totalPoints || 0),
      previousRank: item.previousRank != null ? item.previousRank : undefined,
      previousPoints: row.previousPoints != null ? Math.round(row.previousPoints) : undefined,
      pointsChange: row.previousPoints != null
        ? Math.round(item.totalPoints - row.previousPoints)
        : undefined,
    };
  }
  return {
    rankings,
    dateId: meta.id,
    dateIso: meta.iso,
    dateLabel: meta.label,
    syncedAt: Date.now(),
    teamCount: Object.keys(rankings).length,
    source: "official",
  };
}

function parsePageMeta(html) {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return {};
  try {
    const data = JSON.parse(m[1]);
    const ranking = data?.props?.pageProps?.pageData?.ranking || {};
    return {
      lastUpdateDate: ranking.lastUpdateDate || null,
      nextUpdateDate: ranking.nextUpdateDate || null,
    };
  } catch {
    return {};
  }
}

function buildLivePayload(rows, pageMeta) {
  const rankings = {};
  for (const row of rows) {
    if (!row || row.rank == null) continue;
    const team = canonName(row.teamName || row.name);
    if (!team) continue;
    const prevPts = row.previousPoints != null ? row.previousPoints : null;
    rankings[team] = {
      rank: row.rank,
      points: Math.round(row.totalPoints || 0),
      previousRank: row.previousRank != null ? row.previousRank : undefined,
      previousPoints: prevPts != null ? Math.round(prevPts) : undefined,
      pointsChange: prevPts != null ? Math.round(row.totalPoints - prevPts) : undefined,
    };
  }
  const iso = pageMeta.lastUpdateDate || null;
  let label = null;
  if (iso) {
    try {
      label = new Date(iso).toLocaleDateString("en-GB", {
        day: "numeric", month: "long", year: "numeric",
      });
    } catch { /* use iso */ }
  }
  return {
    rankings,
    dateId: "live",
    dateIso: iso,
    dateLabel: label ? "Live · " + label : "Live",
    syncedAt: Date.now(),
    teamCount: Object.keys(rankings).length,
    source: "live",
  };
}

async function fetchLiveRankingsApi() {
  const url = FIFA_LIVE_API
    + "?mode=live&gender=1&locale=en&rankingType=football&count=250";
  const res = await fetch(url, { headers: FIFA_HEADERS });
  if (!res.ok) return null;
  const json = await res.json();
  if (!json || !Array.isArray(json.rankings) || !json.rankings.length) return null;
  return json.rankings;
}

async function fetchLiveRankings() {
  const pageRes = await fetch(FIFA_PAGE, { headers: FIFA_HEADERS });
  if (!pageRes.ok) throw new Error("FIFA page HTTP " + pageRes.status);
  const html = await pageRes.text();
  const pageMeta = parsePageMeta(html);

  const liveRows = await fetchLiveRankingsApi();
  if (liveRows) return buildLivePayload(liveRows, pageMeta);

  const dateIds = parseDateIds(html);
  if (!dateIds.length) {
    const fallback = await fetchOverview("id14870");
    if (!fallback) throw new Error("No FIFA ranking data");
    return buildPayload(fallback, { id: "id14870", iso: null, label: null });
  }
  for (const meta of dateIds) {
    const overview = await fetchOverview(meta.id);
    if (overview) return buildPayload(overview, meta);
  }
  throw new Error("No FIFA ranking period returned data");
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const now = Date.now();
  const edge = getEdgeCache();
  const cacheKey = new Request(new URL("/api/fifa-rankings", request.url).toString(), { method: "GET" });

  if (edge) {
    const hit = await edge.match(cacheKey);
    if (hit) {
      const resp = new Response(hit.body, hit);
      resp.headers.set("X-Cache", "HIT");
      return resp;
    }
  }

  const kv = env.WC_LEAGUE;
  if (kv) {
    try {
      const raw = await kv.get(KV_KEY);
      if (raw) {
        const cached = JSON.parse(raw);
        if (cached.syncedAt && now - cached.syncedAt < CACHE_TTL_MS && cached.rankings) {
          const resp = jsonResp(cached, {
            "Cache-Control": "public, max-age=60, s-maxage=" + EDGE_TTL_S,
            "X-Cache": "KV-HIT",
          });
          if (edge) context.waitUntil(edge.put(cacheKey, resp.clone()));
          return resp;
        }
      }
    } catch { /* refetch */ }
  }

  try {
    const payload = await fetchLiveRankings();
    const resp = jsonResp(payload, {
      "Cache-Control": "public, max-age=60, s-maxage=" + EDGE_TTL_S,
      "X-Cache": "MISS",
    });
    context.waitUntil((async () => {
      try {
        if (kv) await kv.put(KV_KEY, JSON.stringify(payload));
        if (edge) await edge.put(cacheKey, resp.clone());
      } catch { /* non-fatal */ }
    })());
    return resp;
  } catch (err) {
    if (kv) {
      try {
        const raw = await kv.get(KV_KEY);
        if (raw) {
          const stale = { ...JSON.parse(raw), source: "stale" };
          const resp = jsonResp(stale, {
            "Cache-Control": "public, max-age=30, s-maxage=60",
            "X-Cache": "KV-STALE",
            "X-Upstream-Error": String(err.message).slice(0, 120),
          });
          return resp;
        }
      } catch { /* fall through */ }
    }
    return jsonResp({ error: err.message || "FIFA rankings unavailable" }, { status: 502 });
  }
}

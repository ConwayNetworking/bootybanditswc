/**
 * GET /api/matches
 * Proxies football-data.org, hiding the API key server-side.
 * Caches in KV: 25s when a match is live, 5min otherwise.
 *
 * Env vars (Cloudflare Pages → Settings → Environment Variables):
 *   FOOTBALL_DATA_KEY
 *
 * KV binding (Pages → Settings → Functions → KV namespace bindings):
 *   WC_LEAGUE
 */
const CACHE_KEY_DATA = "cache:matches:data";
const CACHE_KEY_TS   = "cache:matches:ts";
const LIVE_TTL  = 25_000;
const IDLE_TTL  = 300_000;

export async function onRequestGet({ env }) {
  try {
    const kv = env.WC_LEAGUE;
    const [cachedData, cachedTs] = await Promise.all([
      kv.get(CACHE_KEY_DATA),
      kv.get(CACHE_KEY_TS),
    ]);
    const now = Date.now();
    const age = cachedTs ? now - parseInt(cachedTs, 10) : Infinity;
    const isLive = cachedData ? isAnyMatchLive(JSON.parse(cachedData)) : false;
    const ttl = isLive ? LIVE_TTL : IDLE_TTL;

    if (cachedData && age < ttl) {
      return jsonResp(cachedData, { "X-Cache": "HIT", "X-Cache-Age": Math.round(age/1000)+"s" });
    }

    const apiKey = env.FOOTBALL_DATA_KEY;
    if (!apiKey) {
      return cachedData
        ? jsonResp(cachedData, { "X-Cache": "STALE-NO-KEY" })
        : new Response(JSON.stringify({ error: "FOOTBALL_DATA_KEY env var not set" }), { status: 500, headers: { "Content-Type": "application/json" } });
    }

    const upstream = await fetch(
      "https://api.football-data.org/v4/competitions/WC/matches",
      { headers: { "X-Auth-Token": apiKey } }
    );

    if (!upstream.ok) {
      if (cachedData) return jsonResp(cachedData, { "X-Cache": "STALE", "X-Upstream-Status": String(upstream.status) });
      return new Response(JSON.stringify({ error: "Upstream error", status: upstream.status }), { status: 502, headers: { "Content-Type": "application/json" } });
    }

    const fresh = await upstream.text();
    kv.put(CACHE_KEY_DATA, fresh).catch(() => {});
    kv.put(CACHE_KEY_TS, String(now)).catch(() => {});
    return jsonResp(fresh, { "X-Cache": "MISS" });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
}

function jsonResp(body, extra = {}) {
  return new Response(body, { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", ...extra } });
}

function isAnyMatchLive(data) {
  if (!data?.matches) return false;
  const now = Date.now();
  return data.matches.some(m => {
    const elapsed = (now - new Date(m.utcDate).getTime()) / 60000;
    return elapsed >= -5 && elapsed <= 130;
  });
}

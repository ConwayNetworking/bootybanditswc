/**
 * GET  /api/league-data?league=work|boys|family
 * POST /api/league-data  { league, key, value, adminToken }
 *
 * Env vars:  ADMIN_PASSWORD
 * KV binding: WC_LEAGUE
 *
 * KV key schema:
 *   global:auto          → { results, times, syncedAt }   (written by /api/matches)
 *   global:live_feed     → live match event timeline
 *   league:<id>:results  → { [matchId]: { s1, s2 } }      (admin manual overrides only)
 *   league:<id>:autosync → "true"|"false"
 *   global:theme         → "dark"|"light"
 */
import { applyFeedToResults } from "../lib/apply-feed-results.js";

const ALLOWED = ["work", "boys", "family"];
const PROTECTED = ["results"];
const KV_LIVE_FEED = "global:live_feed";
const STALE_MS = 60 * 1000;

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const league = url.searchParams.get("league");
  if (!league || !ALLOWED.includes(league)) return err("Invalid league", 400);
  const kv = env.WC_LEAGUE;
  const now = Date.now();
  const [manualRaw, autoRaw, feedRaw, autosync, theme] = await Promise.all([
    kv.get(`league:${league}:results`),
    kv.get("global:auto"),
    kv.get(KV_LIVE_FEED),
    kv.get(`league:${league}:autosync`),
    kv.get("global:theme"),
  ]);
  const auto = safeParse(autoRaw) || {};
  let autoResults = auto.results || {};
  const liveFeed = safeParse(feedRaw);
  const feed = Array.isArray(liveFeed) ? liveFeed : [];
  if (feed.length) autoResults = applyFeedToResults(autoResults, feed);

  let manual = safeParse(manualRaw) || {};

  /* Drop manual entries identical to the auto feed (incl. legacy data saved
     by old clients that synced client-side) so they don't mask live updates. */
  const pruned = {};
  for (const id in manual) {
    const m = manual[id];
    const a = autoResults[id];
    if (a && m && a.s1 === m.s1 && a.s2 === m.s2) continue;
    pruned[id] = m;
  }
  manual = pruned;

  const syncedAt = auto.syncedAt || 0;
  const dataAge = syncedAt ? now - syncedAt : null;

  return ok({
    results: { ...autoResults, ...manual },
    manual,
    auto: autoResults,
    times: auto.times || {},
    statuses: auto.statuses || {},
    refs: auto.refs || {},
    venues: auto.venues || {},
    matchGoals: auto.matchGoals || {},
    liveFeed: feed,
    syncedAt,
    stale: dataAge != null && dataAge > STALE_MS,
    autosync: autosync !== null ? autosync === "true" : true,
    theme: theme || "dark",
  });
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return err("Invalid JSON", 400); }
  const { league, key, value, adminToken } = body;
  if (!league || !ALLOWED.includes(league)) return err("Invalid league", 400);
  if (!key) return err("Missing key", 400);
  if (PROTECTED.includes(key)) {
    if (!adminToken || adminToken !== env.ADMIN_PASSWORD) return err("Unauthorised", 401);
  }
  const kv = env.WC_LEAGUE;
  if (key === "theme") {
    await kv.put("global:theme", value || "dark");
  } else {
    await kv.put(`league:${league}:${key}`, typeof value === "string" ? value : JSON.stringify(value));
  }
  return ok({ ok: true });
}

export async function onRequestOptions() {
  return new Response(null, { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" } });
}

function safeParse(raw) {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
function ok(data)      { return new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" } }); }
function err(msg, s=400) { return new Response(JSON.stringify({ error: msg }), { status: s, headers: { "Content-Type": "application/json" } }); }

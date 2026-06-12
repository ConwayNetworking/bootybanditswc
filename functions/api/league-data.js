/**
 * GET  /api/league-data?league=work|boys|family
 * POST /api/league-data  { league, key, value, adminToken }
 *
 * Env vars:  ADMIN_PASSWORD
 * KV binding: WC_LEAGUE
 *
 * KV key schema:
 *   global:auto          → { results, times, syncedAt }   (written by /api/matches)
 *   league:<id>:results  → { [matchId]: { s1, s2 } }      (admin manual overrides only)
 *   league:<id>:autosync → "true"|"false"
 *   global:theme         → "dark"|"light"
 *
 * Scores now sync automatically server-side: /api/matches maps the live
 * football-data.org feed onto fixture IDs and stores them in global:auto,
 * shared by all three leagues. The per-league results key only holds manual
 * admin overrides, which win over the auto feed when both exist.
 */
const ALLOWED = ["work", "boys", "family"];
const PROTECTED = ["results"];

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const league = url.searchParams.get("league");
  if (!league || !ALLOWED.includes(league)) return err("Invalid league", 400);
  const kv = env.WC_LEAGUE;
  const [manualRaw, autoRaw, autosync, theme] = await Promise.all([
    kv.get(`league:${league}:results`),
    kv.get("global:auto"),
    kv.get(`league:${league}:autosync`),
    kv.get("global:theme"),
  ]);
  const auto = safeParse(autoRaw) || {};
  const autoResults = auto.results || {};
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

  return ok({
    results: { ...autoResults, ...manual },
    manual,
    auto: autoResults,
    times: auto.times || {},
    syncedAt: auto.syncedAt || 0,
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
function ok(data)      { return new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }); }
function err(msg, s=400) { return new Response(JSON.stringify({ error: msg }), { status: s, headers: { "Content-Type": "application/json" } }); }

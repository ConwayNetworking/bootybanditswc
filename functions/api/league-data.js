/**
 * GET  /api/league-data?league=work|boys|family
 * POST /api/league-data  { league, key, value, adminToken }
 *
 * Env vars:  ADMIN_PASSWORD
 * KV binding: WC_LEAGUE
 *
 * KV key schema:
 *   league:<id>:results  → { [matchId]: { s1, s2 } }
 *   league:<id>:autosync → "true"|"false"
 *   global:theme         → "dark"|"light"
 */
const ALLOWED = ["work", "boys", "family"];
const PROTECTED = ["results"];

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const league = url.searchParams.get("league");
  if (!league || !ALLOWED.includes(league)) return err("Invalid league", 400);
  const kv = env.WC_LEAGUE;
  const [results, autosync, theme] = await Promise.all([
    kv.get(`league:${league}:results`),
    kv.get(`league:${league}:autosync`),
    kv.get("global:theme"),
  ]);
  return ok({ results: results ? JSON.parse(results) : {}, autosync: autosync !== null ? autosync === "true" : true, theme: theme || "dark" });
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

function ok(data)      { return new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }); }
function err(msg, s=400) { return new Response(JSON.stringify({ error: msg }), { status: s, headers: { "Content-Type": "application/json" } }); }

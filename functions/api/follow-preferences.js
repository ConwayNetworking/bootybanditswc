// follow-preferences-worker-snippet.js
// Add this route to your existing Cloudflare Worker that already serves /api/league-data and /api/matches.
// Create/bind a KV namespace, for example binding name: FOLLOW_PREFS
// wrangler.toml/jsonc binding example:
// [[kv_namespaces]]
// binding = "FOLLOW_PREFS"
// id = "YOUR_NAMESPACE_ID"

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type"
    }
  });
}

function prefKey(league, manager) {
  return `follow:${encodeURIComponent(league)}:${encodeURIComponent(manager)}`;
}

export async function handleFollowPreferences(request, env) {
  if (request.method === "OPTIONS") return json({ ok: true });
  const url = new URL(request.url);

  if (!env.FOLLOW_PREFS) {
    return json({ error: "Missing FOLLOW_PREFS KV binding" }, 500);
  }

  if (request.method === "GET") {
    const league = url.searchParams.get("league") || "boys";
    const manager = url.searchParams.get("manager") || "";
    if (!manager) return json({ following: { players: [], countries: [] } });
    const saved = await env.FOLLOW_PREFS.get(prefKey(league, manager), { type: "json" });
    return json({ following: saved || { players: [], countries: [] } });
  }

  if (request.method === "POST") {
    const body = await request.json().catch(() => null);
    if (!body || !body.league || !body.manager) return json({ error: "league and manager are required" }, 400);
    const value = {
      players: Array.isArray(body.following?.players) ? body.following.players.slice(0, 200) : [],
      countries: Array.isArray(body.following?.countries) ? body.following.countries.slice(0, 80) : [],
      updatedAt: new Date().toISOString()
    };
    await env.FOLLOW_PREFS.put(prefKey(body.league, body.manager), JSON.stringify(value));
    return json({ ok: true, following: value });
  }

  return json({ error: "Method not allowed" }, 405);
}

// In your existing Worker's fetch handler, add something like:
// if (new URL(request.url).pathname === "/api/follow-preferences") {
//   return handleFollowPreferences(request, env);
// }

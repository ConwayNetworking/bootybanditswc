function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function prefKey(league, manager) {
  return `follow:${encodeURIComponent(league)}:${encodeURIComponent(manager)}`;
}

function cleanFollowing(input, existing = {}) {
  const src = input || existing || {};
  return {
    players: Array.isArray(src.players) ? src.players.slice(0, 200) : [],
    countries: Array.isArray(src.countries) ? src.countries.slice(0, 80) : [],
    pinnedMatches: Array.isArray(src.pinnedMatches)
      ? src.pinnedMatches.map(Number).filter(Number.isFinite).slice(0, 120)
      : []
  };
}

function cleanSettings(input, existing = {}) {
  const out = {
    liveStandings: typeof existing.liveStandings === "boolean" ? existing.liveStandings : true,
    elimFlagDiscolour: typeof existing.elimFlagDiscolour === "boolean" ? existing.elimFlagDiscolour : true
  };
  if (input && typeof input.liveStandings === "boolean") out.liveStandings = input.liveStandings;
  if (input && typeof input.elimFlagDiscolour === "boolean") out.elimFlagDiscolour = input.elimFlagDiscolour;
  return out;
}

export async function onRequest(context) {
  const { request, env } = context;

  if (!env.FOLLOW_PREFS) {
    return json({ error: "Missing FOLLOW_PREFS KV binding" }, 500);
  }

  const url = new URL(request.url);

  if (request.method === "GET") {
    const league = url.searchParams.get("league") || "boys";
    const manager = url.searchParams.get("manager") || "";

    if (!manager) {
      return json({
        following: { players: [], countries: [], pinnedMatches: [] },
        settings: { liveStandings: true, elimFlagDiscolour: true }
      });
    }

    const saved = await env.FOLLOW_PREFS.get(prefKey(league, manager), { type: "json" });
    return json({
      following: cleanFollowing(saved?.following || saved),
      settings: cleanSettings(saved?.settings),
      updatedAt: saved?.updatedAt || null
    });
  }

  if (request.method === "POST") {
    const body = await request.json().catch(() => null);

    if (!body || !body.league || !body.manager) {
      return json({ error: "league and manager are required" }, 400);
    }

    const existing = await env.FOLLOW_PREFS.get(prefKey(body.league, body.manager), { type: "json" });
    const value = {
      following: cleanFollowing(body.following, existing?.following || existing),
      settings: cleanSettings(body.settings, existing?.settings),
      updatedAt: new Date().toISOString()
    };

    await env.FOLLOW_PREFS.put(prefKey(body.league, body.manager), JSON.stringify(value));

    return json({ ok: true, following: value.following, settings: value.settings, updatedAt: value.updatedAt });
  }

  return json({ error: "Method not allowed" }, 405);
}

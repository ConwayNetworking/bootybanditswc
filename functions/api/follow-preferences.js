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
        following: {
          players: [],
          countries: []
        }
      });
    }

    const saved = await env.FOLLOW_PREFS.get(prefKey(league, manager), {
      type: "json"
    });

    return json({
      following: saved || {
        players: [],
        countries: []
      }
    });
  }

  if (request.method === "POST") {
    const body = await request.json().catch(() => null);

    if (!body || !body.league || !body.manager) {
      return json({ error: "league and manager are required" }, 400);
    }

    const value = {
      players: Array.isArray(body.following?.players)
        ? body.following.players.slice(0, 200)
        : [],
      countries: Array.isArray(body.following?.countries)
        ? body.following.countries.slice(0, 80)
        : [],
      updatedAt: new Date().toISOString()
    };

    await env.FOLLOW_PREFS.put(
      prefKey(body.league, body.manager),
      JSON.stringify(value)
    );

    return json({
      ok: true,
      following: value
    });
  }

  return json({ error: "Method not allowed" }, 405);
}

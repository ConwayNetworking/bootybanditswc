/**
 * GET /api/wc-data?type=scorers|teams|team&name=Germany&id=123
 *
 * Cached football-data.org enrichment endpoints (scorers, squads).
 * Heavy edge/KV caching to stay within free-tier rate limits.
 *
 * Env vars: FOOTBALL_DATA_KEY
 * KV binding: WC_LEAGUE
 */

const API_BASE = "https://api.football-data.org/v4";
const KV_SCORERS = "cache:scorers:v1";
const KV_TEAMS = "cache:teams:v1";
const SCORERS_TTL_S = 1800;
const TEAMS_TTL_S = 86400;

const GL = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L"];

const ALL_TEAMS = [
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
  "Cabo Verde": "Cape Verde",
  "Congo DR": "DR Congo",
  "Bosnia and Herzegovina": "Bosnia & Herzegovina",
  "Bosnia-Herzegovina": "Bosnia & Herzegovina",
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
for (const t of ALL_TEAMS) TEAM_LOOKUP[norm(t)] = t;
for (const a in ALIASES) TEAM_LOOKUP[norm(a)] = ALIASES[a];

function canonTeam(team) {
  if (!team) return null;
  for (const candidate of [team.name, team.shortName, team.tla]) {
    const hit = TEAM_LOOKUP[norm(candidate)];
    if (hit) return hit;
  }
  return null;
}

function apiUrl(env, path) {
  return env.FOOTBALL_DATA_URL
    ? new URL(path, env.FOOTBALL_DATA_URL).toString()
    : API_BASE + path;
}

function jsonResp(body, extra = {}) {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", ...extra },
  });
}

function err(msg, status = 400) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}

function getEdgeCache() {
  try { return typeof caches !== "undefined" && caches.default ? caches.default : null; }
  catch { return null; }
}

async function cachedFetch(context, cacheKey, kvKey, ttlS, fetchFn) {
  const { env } = context;
  const edge = getEdgeCache();
  const req = new Request(new URL("/api/wc-data/" + cacheKey, context.request.url).toString(), { method: "GET" });

  if (edge) {
    const hit = await edge.match(req);
    if (hit) {
      const resp = new Response(hit.body, hit);
      resp.headers.set("X-Cache", "HIT");
      return resp;
    }
  }

  const kv = env.WC_LEAGUE;
  if (kv) {
    try {
      const raw = await kv.get(kvKey);
      if (raw) {
        const blob = JSON.parse(raw);
        if (blob.ts && Date.now() - blob.ts < ttlS * 1000 && blob.data) {
          const resp = jsonResp(blob.data, {
            "Cache-Control": "public, max-age=60, s-maxage=" + ttlS,
            "X-Cache": "KV-HIT",
          });
          if (edge) context.waitUntil(edge.put(req, resp.clone()));
          return resp;
        }
      }
    } catch { /* refetch */ }
  }

  const data = await fetchFn();
  const resp = jsonResp(data, {
    "Cache-Control": "public, max-age=60, s-maxage=" + ttlS,
    "X-Cache": "MISS",
  });

  context.waitUntil((async () => {
    try {
      if (edge) await edge.put(req, resp.clone());
      if (kv) await kv.put(kvKey, JSON.stringify({ ts: Date.now(), data }));
    } catch { /* best-effort */ }
  })());

  return resp;
}

function trimScorers(raw) {
  const list = Array.isArray(raw.scorers) ? raw.scorers : [];
  return list.map((row) => {
    const player = row.player || {};
    const team = row.team || {};
    return {
      player: player.name || "Unknown",
      team: canonTeam(team) || team.name || "Unknown",
      goals: row.goals != null ? row.goals : 0,
      assists: row.assists != null ? row.assists : 0,
      penalties: row.penalties != null ? row.penalties : 0,
    };
  }).filter((r) => r.goals > 0 || r.assists > 0);
}

function trimTeamList(raw) {
  const list = Array.isArray(raw.teams) ? raw.teams : [];
  const byName = {};
  for (const t of list) {
    const name = canonTeam(t);
    if (!name) continue;
    byName[name] = {
      id: t.id,
      name,
      crest: t.crest || "",
      coach: t.coach && t.coach.name ? t.coach.name : "",
      venue: t.venue || "",
      website: t.website || "",
    };
  }
  return { teams: byName };
}

function trimTeamDetail(raw) {
  const t = raw;
  const name = canonTeam(t) || t.name || "Unknown";
  const squad = Array.isArray(t.squad) ? t.squad : [];
  const players = squad.map((p) => ({
    name: p.name || "Unknown",
    position: p.position || "",
    nationality: p.nationality || "",
    dateOfBirth: p.dateOfBirth || "",
  }));
  players.sort((a, b) => {
    const order = { Goalkeeper: 0, Defence: 1, Midfield: 2, Offence: 3 };
    const pa = order[a.position] != null ? order[a.position] : 9;
    const pb = order[b.position] != null ? order[b.position] : 9;
    return pa - pb || a.name.localeCompare(b.name);
  });
  return {
    id: t.id,
    name,
    crest: t.crest || "",
    coach: t.coach && t.coach.name ? t.coach.name : "",
    venue: t.venue || "",
    website: t.website || "",
    tla: t.tla || "",
    squad: players,
  };
}

async function fetchUpstream(env, path) {
  const apiKey = env.FOOTBALL_DATA_KEY;
  if (!apiKey) throw new Error("FOOTBALL_DATA_KEY not set");
  const r = await fetch(apiUrl(env, path), { headers: { "X-Auth-Token": apiKey } });
  if (!r.ok) throw new Error("Upstream HTTP " + r.status);
  return r.json();
}

async function getScorers(context) {
  return cachedFetch(context, "scorers", KV_SCORERS, SCORERS_TTL_S, async () => {
    const raw = await fetchUpstream(context.env, "/competitions/WC/scorers");
    return { scorers: trimScorers(raw), syncedAt: Date.now() };
  });
}

async function getTeamsList(context) {
  return cachedFetch(context, "teams", KV_TEAMS, TEAMS_TTL_S, async () => {
    const raw = await fetchUpstream(context.env, "/competitions/WC/teams");
    const trimmed = trimTeamList(raw);
    return { ...trimmed, syncedAt: Date.now() };
  });
}

async function getTeamDetail(context) {
  const url = new URL(context.request.url);
  const name = url.searchParams.get("name");
  const idParam = url.searchParams.get("id");
  let teamId = idParam ? parseInt(idParam, 10) : NaN;

  if (!teamId && name) {
    const listResp = await getTeamsList(context);
    const listData = await listResp.json();
    const entry = listData.teams && listData.teams[name];
    if (!entry) return err("Team not found: " + name, 404);
    teamId = entry.id;
  }

  if (!teamId || isNaN(teamId)) return err("Missing team id or name", 400);

  return cachedFetch(context, "team-" + teamId, "cache:team:" + teamId + ":v1", TEAMS_TTL_S, async () => {
    const raw = await fetchUpstream(context.env, "/teams/" + teamId);
    return { team: trimTeamDetail(raw), syncedAt: Date.now() };
  });
}

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const type = url.searchParams.get("type");
  try {
    if (type === "scorers") return await getScorers(context);
    if (type === "teams") return await getTeamsList(context);
    if (type === "team") return await getTeamDetail(context);
    return err("Invalid type — use scorers, teams, or team", 400);
  } catch (e) {
    return err(e.message || "Upstream error", 502);
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}

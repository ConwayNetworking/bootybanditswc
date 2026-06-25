/**
 * Merge live-feed goal/FT events into fixture results when the upstream
 * API is lagging behind (common on football-data.org free tier).
 */
export function applyFeedToResults(results, feed) {
  if (!results || !feed || !feed.length) return results || {};
  const out = {};
  for (const id in results) out[id] = { ...results[id] };

  const latestGoal = {};
  for (const e of feed) {
    if (e.kind === "goal" && e.s1 != null && e.s2 != null) {
      const fid = String(e.fid);
      const rank = (e.gm != null ? e.gm * 1000 : 0) + (e.at || 0) / 1000;
      const prev = latestGoal[fid];
      const prevRank = prev ? ((prev.gm != null ? prev.gm * 1000 : 0) + (prev.at || 0) / 1000) : -1;
      if (!prev || rank >= prevRank) latestGoal[fid] = e;
    }
  }

  for (const fid in latestGoal) {
    const ev = latestGoal[fid];
    const r = out[fid];
    if (!r) continue;
    if (r.st === "FT" || r.st === "AET" || r.st === "FT_PEN" || r.st === "AP") continue;
    const curTotal = (r.s1 || 0) + (r.s2 || 0);
    const evTotal = ev.s1 + ev.s2;
    if (evTotal <= curTotal && r.st !== "LIVE") continue;
    out[fid] = { ...r, s1: ev.s1, s2: ev.s2, st: r.st || "LIVE" };
    if (ev.gm != null) out[fid].min = ev.gm;
  }

  for (const e of feed) {
    if (e.kind !== "ft") continue;
    const fid = String(e.fid);
    const r = out[fid];
    if (!r) continue;
    if (e.s1 != null && e.s2 != null) {
      out[fid] = { ...r, s1: e.s1, s2: e.s2, st: "FT" };
    } else if (r.st === "LIVE" || r.st === "HT" || r.st === "1H" || r.st === "2H") {
      out[fid] = { ...r, st: "FT" };
    }
  }

  return out;
}

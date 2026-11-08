// Turns leaderboard rows into team standings.

import { NO_TIME } from "./config.js";

// Matching form: lowercase letters and digits only, "(Beta Tester)" removed.
// This also strips invisible marks some Velocidrone names carry.
export const norm = (s) => String(s).toLowerCase().replace(/\(beta tester\)/g, "").replace(/[^a-z0-9]/g, "");

// Whether a time counts for a track's required quad. Rows saved before model
// data was collected carry no model and are kept.
export function quadAllowed(row, quad) {
  if (!quad) return true;
  if (row.model == null && row.modelId == null) return true;
  if (row.modelId != null && (quad.ids || []).includes(row.modelId)) return true;
  return row.model != null && norm(row.model) === norm(quad.name);
}

export function computeStandings(rows, teams, aliases = {}, quad = null) {
  const best = new Map();
  for (const r of rows) {
    if (!quadAllowed(r, quad)) continue;
    const k = norm(r.name);
    if (k && (!best.has(k) || best.get(k).time > r.time)) best.set(k, r);
  }
  const find = (name) => {
    const k = norm(name);
    return best.get(k) || best.get(aliases[k]) || null;
  };

  const ranked = teams
    .map((t) => {
      const pilots = [t.captain, ...t.pilots]
        .map((name, i) => {
          const hit = find(name);
          return {
            name,
            captain: i === 0,
            posted: !!hit,
            time: hit ? hit.time : NO_TIME,
            lb: hit ? hit.rank : null,
            // As recorded on Velocidrone; null when unknown (page source has no IDs).
            velocidroneName: hit ? hit.name : null,
            userId: hit?.userId ?? null,
            model: hit?.model ?? null,
            modelId: hit?.modelId ?? null,
          };
        })
        .sort((a, b) => a.time - b.time || a.name.localeCompare(b.name));
      const total = round3(pilots.reduce((s, p) => s + p.time, 0));
      return { sponsor: t.sponsor, captain: t.captain, total, posted: pilots.filter((p) => p.posted).length, size: pilots.length, pilots };
    })
    .sort((a, b) => a.total - b.total || b.posted - a.posted || a.sponsor.localeCompare(b.sponsor));

  const lead = ranked.length ? ranked[0].total : 0;
  ranked.forEach((t, i) => {
    t.position = i + 1;
    t.gap = round3(t.total - lead);
  });
  return { teams: ranked };
}

// League-set times (see TIME_OVERRIDES): a pilot's time becomes the override when it
// is faster than what Velocidrone lists, and team totals and order are worked out again.
// Safe to apply more than once.
export function applyOverrides(standings, overrides) {
  if (!standings || !overrides || !Object.keys(overrides).length) return standings;
  const teams = standings.teams
    .map((t) => {
      const pilots = t.pilots
        .map((p) => {
          const o = overrides[p.name];
          if (!o || (p.posted && p.time <= o.time)) return p;
          return { ...p, posted: true, time: o.time, lb: null, override: { listed: p.posted ? p.time : null, note: o.note || "" } };
        })
        .sort((a, b) => a.time - b.time || a.name.localeCompare(b.name));
      return { ...t, pilots, total: round3(pilots.reduce((s, p) => s + p.time, 0)), posted: pilots.filter((p) => p.posted).length };
    })
    .sort((a, b) => a.total - b.total || b.posted - a.posted || a.sponsor.localeCompare(b.sponsor));
  const lead = teams.length ? teams[0].total : 0;
  return { ...standings, teams: teams.map((t, i) => ({ ...t, position: i + 1, gap: round3(t.total - lead) })) };
}

// The same for one hourly save, from the override's `since` on.
export function overrideSnapshot(snap, overrides) {
  if (!overrides) return snap;
  let out = snap;
  for (const [name, o] of Object.entries(overrides)) {
    if (o.since && snap.at < o.since) continue;
    const cur = out.pilots?.[name];
    if (cur == null || cur <= o.time) continue;
    const team = o.team;
    const delta = cur - o.time;
    out = {
      ...out,
      pilots: { ...out.pilots, [name]: o.time },
      teams: (out.teams || []).map((r) => (r[0] === team ? [r[0], round3(r[1] - delta), r[2]] : r)),
    };
  }
  return out;
}

// What changed between two saves of a board: a pilot's first time ("debut") or a
// faster personal best ("pb"). Only times on the track's required quad count.
// Event: { at, name, kind, prev, time, prevRank, rank, userId }
export function diffEvents(prevRows, rows, at, quad = null) {
  const bestBy = (list) => {
    const m = new Map();
    for (const r of list || []) {
      if (!quadAllowed(r, quad)) continue;
      const k = norm(r.name);
      if (k && (!m.has(k) || m.get(k).time > r.time)) m.set(k, r);
    }
    return m;
  };
  const before = bestBy(prevRows);
  const out = [];
  for (const [k, r] of bestBy(rows)) {
    const p = before.get(k);
    if (!p) out.push({ at, name: r.name, kind: "debut", prev: null, time: r.time, prevRank: null, rank: r.rank, userId: r.userId ?? null });
    else if (r.time < p.time - 0.0005) out.push({ at, name: r.name, kind: "pb", prev: p.time, time: r.time, prevRank: p.rank, rank: r.rank, userId: r.userId ?? p.userId ?? null });
  }
  return out.sort((a, b) => a.rank - b.rank);
}

// Small per-hour record of where everyone stood, for charts later.
export function compactSnapshot(standings, at) {
  return {
    at,
    teams: standings.teams.map((t) => [t.sponsor, t.total, t.posted]),
    pilots: Object.fromEntries(standings.teams.flatMap((t) => t.pilots.filter((p) => p.posted).map((p) => [p.name, p.time]))),
    ids: Object.fromEntries(standings.teams.flatMap((t) => t.pilots.filter((p) => p.userId != null).map((p) => [p.name, p.userId]))),
  };
}

const round3 = (n) => Math.round(n * 1000) / 1000;

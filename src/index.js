// weBLEEDfpv standings backend.
//
//   Timers (wrangler.jsonc "triggers")        -> hourly refresh of live tracks; lock run Saturdays 11:59 PM Eastern
//   GET  /api/tracks                          -> every track with its status, for the tabs
//   GET  /api/tracks/:id                      -> one track's standings
//   GET  /api/tracks/:id/history              -> that track's hourly snapshots
//   GET  /api/tracks/:id/races                -> that track's race day: lineups, 4 tiers x 8 races, times, points
//   GET  /api/tracks/:id/races/live           -> WebSocket: sends {"type":"update"} whenever race day changes
//   GET  /api/tracks/:id/stats                -> team totals over time, time cut, most improved, biggest drops, activity
//   GET  /api/overall                         -> season table: Smash and Race points per team per week
//   GET  /api/health/source/:id               -> read-only check that the game endpoint answers (cached 5 min)
//   POST /api/admin/tracks/:id/refresh|lock   -> manual controls (needs the ADMIN_TOKEN secret)
//   Race director page. Sign in once; the pass goes in an x-admin-session header:
//   POST  /api/admin/login                       -> x-admin-password: <password>  =>  { session, expiresAt } (24 hours)
//   GET   /api/admin/tracks/:id/races            -> race day plus who sat out in earlier weeks
//   PATCH /api/admin/tracks/:id/races/lineup     -> { sitting: { "<sponsor>": "<pilot>" | null } }
//   PATCH /api/admin/tracks/:id/races/tiers/:n   -> { results: { "<race>": { "<sponsor>": "45.123" | "DNF" | null } } }
//   PATCH /api/admin/tracks/:id/races/bonus      -> { results: { "<match>": { "<heat>": { "<sponsor>": { "<tier>": "45.123" | "DNF" | null } } } } }
//
// The page in /public is served as static files and only reads from /api.

import { ADMIN_PASSWORD_SHA256, ALIASES, LATE_LOCK_AFTER_MINUTES, RACES, REFRESH_MINUTES, SEASON_POINTS, LEAGUE, TEAMS, NO_VISIT_REFRESH_BEFORE_LOCK_MINUTES, SEASON, STALE_MINUTES, TEAM_NAMES, TRACKS } from "./config.js";
import { applyOverrides, computeStandings, norm, quadAllowed } from "./standings.js";
import { computeRaces } from "./races.js";
import { raceStore } from "./racestore.js";
export { RaceRoom } from "./raceroom.js";
import { fetchGameLeaderboard, gameRows } from "./gameapi.js";
import { trackIdFromUrl } from "./leaderboard.js";
import { getEvents, getHistory, getRecord } from "./store.js";
import { computeStats } from "./stats.js";
import { DRAFT_ORDER, DRAFT_RANKS } from "./draft.js";
import { seedFor } from "./seed/index.js";
import { findTrack, lockTrack, lockTime, overridesFor, runSchedule, standingsFor, syncTrack, teamsFor, trackStatus } from "./sync.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      return await route(request, url, env, ctx, Date.now());
    } catch (err) {
      console.error(err);
      return json({ error: String(err?.message || err) }, 500, "no-store");
    }
  },

  async scheduled(event, env, ctx) {
    // Use the real clock if the timer runs late, so a late final fetch is recognized as late.
    const now = Math.max(Date.now(), event.scheduledTime);
    ctx.waitUntil(
      runSchedule(env, now).then((results) => console.log(JSON.stringify({ scheduled: new Date(event.scheduledTime).toISOString(), results: results.map(({ record, ...r }) => r) })))
    );
  },
};

export async function route(request, url, env, ctx, now, deps = {}) {
  const parts = url.pathname.replace(/\/+$/, "").split("/").filter(Boolean);

  // Old single-track page (before Nov 3) polls /data. Keep it working until those tabs are reloaded.
  if (request.method === "GET" && parts.length === 1 && parts[0] === "data") {
    const track = TRACKS.find((t) => t.leaderboardUrl);
    const record = track ? await getRecord(env, track.id) : null;
    if (!record) return json({ error: "no times saved yet" }, 503, "no-store");
    return json({ rows: record.rows, fetchedAt: record.fetchedAt }, 200, "public, max-age=60");
  }

  if (parts[0] !== "api") return new Response("Not found", { status: 404 });

  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors() });

  // /api/tracks
  if (request.method === "GET" && parts[1] === "tracks" && parts.length === 2) {
    const tracks = await Promise.all(
      TRACKS.map(async (t) => {
        const rec = t.leaderboardUrl ? await getRecord(env, t.id) : null;
        return summary(t, rec, now);
      })
    );
    return json({ league: LEAGUE, season: SEASON, now: new Date(now).toISOString(), tracks }, 200, "public, max-age=60");
  }

  // /api/overall
  if (request.method === "GET" && parts[1] === "overall" && parts.length === 2) {
    return json(await overall(env, now), 200, "public, max-age=60");
  }

  // /api/export: everything the site has, as one JSON file (cached at the edge for 5 minutes).
  if (request.method === "GET" && parts[1] === "export" && parts.length === 2) {
    const cache = typeof caches !== "undefined" ? caches.default : null;
    const key = new Request(`https://export.cache/${Math.floor(now / 300_000)}`);
    const hit = cache && (await cache.match(key));
    if (hit) return hit;
    const body = await exportAll(env, now);
    const res = new Response(JSON.stringify(body, null, 1), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="webleed-s5-data-${new Date(now).toISOString().slice(0, 10)}.json"`,
        "cache-control": "public, max-age=300",
        ...cors(),
      },
    });
    if (cache && ctx?.waitUntil) ctx.waitUntil(cache.put(key, res.clone()));
    return res;
  }

  // /api/tracks/:id/stats
  if (request.method === "GET" && parts[1] === "tracks" && parts.length === 4 && parts[3] === "stats") {
    const track = findTrack(parts[2]);
    if (!track) return json({ error: "no such track" }, 404, "no-store");
    const [history, events, record] = await Promise.all([getHistory(env, track.id), getEvents(env, track.id), track.leaderboardUrl ? getRecord(env, track.id) : null]);
    const teams = record?.status === "locked" && record.teams ? record.teams : teamsFor(track);
    const seed = seedFor(track.id, env.STATS_SEEDS);
    return json(computeStats(track, withSeedHistory(seed.history, history), withSeedEvents(seed.events, events), teams), 200, record?.status === "locked" ? "public, max-age=3600" : "public, max-age=120");
  }

  // /api/tracks/:id/races/live
  if (request.method === "GET" && parts[1] === "tracks" && parts.length === 5 && parts[3] === "races" && parts[4] === "live") {
    const track = findTrack(parts[2]);
    if (!track) return json({ error: "no such track" }, 404, "no-store");
    return raceStore(env, track.id).connect(request);
  }

  // /api/tracks/:id/races
  if (request.method === "GET" && parts[1] === "tracks" && parts.length === 4 && parts[3] === "races") {
    const track = findTrack(parts[2]);
    if (!track) return json({ error: "no such track" }, 404, "no-store");
    return json(await racesFor(env, track, now), 200, "no-store");
  }

  // Race director page
  if (parts[1] === "admin" && (parts[2] === "login" || (parts[2] === "tracks" && parts[4] === "races"))) {
    if (parts[2] === "login") {
      if (request.method !== "POST" || !(await passwordOk(env, request.headers.get("x-admin-password")))) return json({ error: "wrong password" }, 403, "no-store");
      const expiresAt = now + SESSION_HOURS * 3_600_000;
      return json({ session: await signSession(env, expiresAt), expiresAt: new Date(expiresAt).toISOString() }, 200, "no-store");
    }
    if (!(await sessionOk(env, request.headers.get("x-admin-session"), now))) return json({ error: "signed out" }, 403, "no-store");
    const track = findTrack(parts[3]);
    if (!track) return json({ error: "no such track" }, 404, "no-store");

    if (request.method === "GET" && parts.length === 5) {
      return json({ ...(await racesFor(env, track, now)), satBefore: await satBefore(env, track) }, 200, "no-store");
    }
    if (request.method === "PATCH" && (parts[5] === "lineup" || parts[5] === "tiers" || parts[5] === "bonus")) {
      const body = await request.json().catch(() => null);
      if (!body) return json({ error: "send JSON" }, 400, "no-store");
      const teams = teamsFor(track);
      const stamp = new Date(now).toISOString();
      const store = raceStore(env, track.id);
      try {
        if (parts[5] === "lineup" && parts.length === 6) {
          await store.patch("lineup", null, body.sitting, teams, stamp);
        } else if (parts[5] === "bonus" && parts.length === 6) {
          await store.patch("bonus", null, body.results, teams, stamp);
        } else if (parts[5] === "tiers" && parts.length === 7) {
          const tier = Number(parts[6]);
          if (!Number.isInteger(tier) || tier < 1 || tier > RACES.tiers) return json({ error: "no such tier" }, 404, "no-store");
          await store.patch("tier", tier, body.results, teams, stamp);
        } else return json({ error: "not found" }, 404, "no-store");
      } catch (err) {
        return json({ error: String(err?.message || err) }, 400, "no-store");
      }
      return json(await racesFor(env, track, now), 200, "no-store");
    }
    return json({ error: "not found" }, 404, "no-store");
  }

  // /api/tracks/:id and /api/tracks/:id/history
  if (request.method === "GET" && parts[1] === "tracks" && (parts.length === 3 || (parts.length === 4 && parts[3] === "history"))) {
    const track = findTrack(parts[2]);
    if (!track) return json({ error: "no such track" }, 404, "no-store");

    if (parts[3] === "history") {
      return json({ track: track.id, entries: await getHistory(env, track.id) }, 200, "public, max-age=300");
    }

    let record = track.leaderboardUrl ? await getRecord(env, track.id) : null;
    const status = trackStatus(track, record, now);

    // Locked tracks: served from the saved final copy only. Nothing below runs for them.
    if (status === "locking" && now - lockTime(track) > LATE_LOCK_AFTER_MINUTES * 60_000 && record) {
      // The lock timer never ran: lock from the times saved before the deadline. Never fetches.
      record = (await lockTrack(env, track, record, now, { ...deps, allowFetch: false })).record;
    } else if (status === "live" && !record) {
      // First visit before the timer has ever run.
      record = (await syncTrack(env, track, now, { ...deps, force: true, record })).record;
    } else if (
      status === "live" &&
      now - Date.parse(record.fetchedAt) > STALE_MINUTES * 60_000 &&
      now < lockTime(track) - NO_VISIT_REFRESH_BEFORE_LOCK_MINUTES * 60_000
    ) {
      // The hourly timer was missed: catch up in the background, answer with what's saved.
      ctx.waitUntil(syncTrack(env, track, now, { ...deps, staleMs: STALE_MINUTES * 60_000, record }).catch((e) => console.error(e)));
    }
    // "locking" within LATE_LOCK_AFTER_MINUTES: show saved data, fetch nothing, leave the lock to the timer.

    return json(detail(track, record, now), 200, record?.status === "locked" ? "public, max-age=3600" : "public, max-age=60");
  }

  // Read-only source check: calls the game endpoint once, saves nothing.
  //   ?velocidroneTrack=2174  check another Velocidrone track ID (e.g. a tryout track)
  //   ?pilot=xer              show exactly how one roster name matches
  if (request.method === "GET" && parts[1] === "health" && parts[2] === "source" && parts.length === 4) {
    const track = findTrack(parts[3]);
    if (!track?.leaderboardUrl) return json({ error: "no such live track" }, 404, "no-store");
    const vdTrack = /^\d{1,7}$/.test(url.searchParams.get("velocidroneTrack") || "") ? url.searchParams.get("velocidroneTrack") : trackIdFromUrl(track.leaderboardUrl);
    const pilot = (url.searchParams.get("pilot") || "").slice(0, 40);
    const cache = typeof caches !== "undefined" ? caches.default : null;
    const key = new Request(`https://health.cache/source/${track.id}/${vdTrack}/${encodeURIComponent(pilot)}`);
    const hit = cache && (await cache.match(key));
    if (hit) return hit;
    let body;
    try {
      const rows = gameRows(await fetchGameLeaderboard({ trackId: vdTrack }, deps.fetchImpl));
      const standings = computeStandings(rows, teamsFor(track), ALIASES, track.quad || null);
      const pilots = standings.teams.flatMap((t) => t.pilots.map((p) => ({ ...p, team: t.sponsor })));
      const models = rows.reduce((a, r) => ((a[r.model || r.modelId || "unknown"] = (a[r.model || r.modelId || "unknown"] || 0) + 1), a), {});
      body = {
        ok: rows.length > 0, source: "game", velocidroneTrack: vdTrack, checkedAt: new Date(now).toISOString(), count: rows.length, models,
        withUserIds: rows.filter((r) => r.userId != null).length,
        rosterPosted: pilots.filter((p) => p.posted).length, rosterTotal: pilots.length,
        rosterMissing: pilots.filter((p) => !p.posted).map((p) => `${p.name} (${p.team})`),
        top: rows.slice(0, 3).map(({ rank, time, name, model }) => ({ rank, time, name, model })),
      };
      if (pilot) {
        const k = norm(pilot);
        const target = ALIASES[k] || k;
        const raw = rows.filter((r) => norm(r.name) === target || norm(r.name) === k);
        body.pilot = {
          rosterName: pilot,
          matchKey: target,
          velocidroneRows: raw.map((r) => ({
            name: r.name, nameCodes: [...r.name].map((c) => c.codePointAt(0).toString(16)),
            time: r.time, rank: r.rank, model: r.model, modelId: r.modelId, userId: r.userId, countsForQuad: quadAllowed(r, track.quad || null),
          })),
          inStandings: pilots.find((p) => norm(p.name) === k) || null,
        };
      }
    } catch (err) {
      body = { ok: false, source: "game", velocidroneTrack: vdTrack, checkedAt: new Date(now).toISOString(), error: String(err?.message || err).slice(0, 300) };
    }
    const res = json(body, 200, "public, max-age=300");
    if (cache) ctx.waitUntil(cache.put(key, res.clone()));
    return res;
  }

  // Manual controls
  if (request.method === "POST" && parts[1] === "admin" && parts[2] === "tracks" && parts.length === 5) {
    if (!env.ADMIN_TOKEN || request.headers.get("authorization") !== `Bearer ${env.ADMIN_TOKEN}`) {
      return json({ error: "not allowed" }, 403, "no-store");
    }
    const track = findTrack(parts[3]);
    if (!track || !track.leaderboardUrl) return json({ error: "no such live track" }, 404, "no-store");
    const record = await getRecord(env, track.id);
    if (record?.status === "locked") return json({ error: "track is locked" }, 409, "no-store");
    const result =
      parts[4] === "lock"
        ? await lockTrack(env, track, record, now, deps)
        : parts[4] === "refresh"
          ? await syncTrack(env, track, now, { ...deps, force: true, record })
          : null;
    if (!result) return json({ error: "unknown action" }, 404, "no-store");
    return json({ action: result.action, track: summary(track, result.record, now) }, 200, "no-store");
  }

  return json({ error: "not found" }, 404, "no-store");
}

// Season table. Each week's points are worked out from that track:
//   Smash: place in the locked team standings -> SEASON_POINTS.smash (10 for 1st ... 1 for 10th)
//   Race:  place by tier race points once every tier has finished -> SEASON_POINTS.race (20 ... 2),
//          plus the bonus round's 3/2/1/0 for the top four once it's done.
// Teams level on points share the higher place. A value saved in KV under "overall"
// ({ points: { "<sponsor>": { "<week>": { smash, race } } } }) replaces the worked-out one.
const placePoints = (list, key, table) => {
  const out = new Map();
  for (const t of list) {
    if (t[key] == null) continue;
    const place = 1 + list.filter((o) => o[key] != null && o[key] > t[key]).length;
    out.set(t.sponsor, table[place - 1] ?? 0);
  }
  return out;
};

async function weekPoints(env, track, now) {
  if (!track.leaderboardUrl) return null;
  const record = await getRecord(env, track.id);
  const smash = new Map();
  if (record?.status === "locked" && record.standings) {
    const s = applyOverrides(record.standings, overridesFor(track));
    // Lower total is better: flip the sign so placePoints ranks fastest first.
    for (const [k, v] of placePoints(s.teams.map((t) => ({ sponsor: t.sponsor, score: -t.total })), "score", SEASON_POINTS.smash)) smash.set(k, v);
  }
  const race = new Map();
  const bonus = new Map();
  const r = await racesFor(env, track, now);
  const done = r.tierResults.every((t) => t.racesRun === r.racesPerTier);
  const bonusDone = !r.bonus || r.bonus.places.length === r.bonus.seeds.length;
  if (done && bonusDone) {
    for (const [k, v] of placePoints(r.teams, "raceTotal", SEASON_POINTS.race)) race.set(k, v);
    for (const p of r.bonus?.places || []) bonus.set(p.sponsor, p.points);
  }
  return { smash, race, bonus };
}

async function overall(env, now) {
  const saved = (await env.STANDINGS.get("overall", "json")) || {};
  const points = saved.points || {};
  const weeks = TRACKS.map((t) => ({ id: t.id, name: t.name, label: `Week ${t.id}` }));
  const computed = Object.fromEntries(await Promise.all(TRACKS.map(async (t) => [t.id, await weekPoints(env, t, now).catch((e) => (console.error(e), null))])));
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const teams = TEAMS.map((t, order) => {
    const byWeek = {};
    let total = null;
    for (const w of weeks) {
      const p = points[t.sponsor]?.[w.id] || {};
      const c = computed[w.id];
      const racePlace = c?.race.get(t.sponsor);
      const bonus = c?.bonus.get(t.sponsor) ?? null;
      const cell = {
        smash: num(p.smash) ?? c?.smash.get(t.sponsor) ?? null,
        race: num(p.race) ?? (racePlace != null ? racePlace + (bonus || 0) : null),
        raceBonus: num(p.race) == null && racePlace != null ? bonus : null,
      };
      for (const v of [cell.smash, cell.race]) if (v != null) total = (total ?? 0) + v;
      byWeek[w.id] = cell;
    }
    return { sponsor: t.sponsor, captain: t.captain, order, weeks: byWeek, total };
  });
  const anyPoints = teams.some((t) => t.total != null);
  // Most points first once any exist; until then, draft order.
  teams.sort((a, b) => (anyPoints ? (b.total ?? -Infinity) - (a.total ?? -Infinity) : 0) || a.order - b.order);
  teams.forEach((t, i) => { t.position = anyPoints && t.total != null ? 1 + teams.filter((o) => (o.total ?? -Infinity) > t.total).length : null; delete t.order; });
  return { weeks, points: SEASON_POINTS, teams, updatedAt: saved.updatedAt || null };
}

// Race director sign-in pass: "<expiry ms>.<HMAC-SHA256 of it>", keyed on the password
// (so changing the password signs everyone out). Good for SESSION_HOURS.
const SESSION_HOURS = 24;
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
async function sessionKey(env) {
  const secret = env.ADMIN_PASSWORD ? `pw:${env.ADMIN_PASSWORD}` : `hash:${ADMIN_PASSWORD_SHA256}`;
  return crypto.subtle.importKey("raw", new TextEncoder().encode(`webleed-session|${secret}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}
async function signSession(env, expiresAt) {
  const sig = await crypto.subtle.sign("HMAC", await sessionKey(env), new TextEncoder().encode(String(expiresAt)));
  return `${expiresAt}.${hex(sig)}`;
}
async function sessionOk(env, session, now) {
  const m = /^(\d{10,16})\.([0-9a-f]{64})$/.exec(session || "");
  if (!m || Number(m[1]) <= now || Number(m[1]) > now + SESSION_HOURS * 3_600_000 + 60_000) return false;
  const expected = (await signSession(env, Number(m[1]))).split(".")[1];
  let diff = 0;
  for (let i = 0; i < 64; i++) diff |= expected.charCodeAt(i) ^ m[2].charCodeAt(i);
  return diff === 0;
}

// Repo-kept hours count only before our own history began; our saved hours always win.
function withSeedHistory(seed, mine) {
  const earliest = mine.length ? mine.map((h) => h.at).sort()[0] : "9999";
  return [...seed.filter((h) => h.at < earliest), ...mine];
}

// Repo-kept events plus any recorded here, without counting the same new best twice.
function withSeedEvents(seed, mine) {
  const key = (e) => `${e.name.toLowerCase()}|${e.kind}|${e.time}`;
  const seen = new Set(seed.map(key));
  return [...seed, ...mine.filter((e) => !seen.has(key(e)))].sort((a, b) => a.at.localeCompare(b.at));
}

async function passwordOk(env, given) {
  if (!given) return false;
  if (env.ADMIN_PASSWORD) return given === env.ADMIN_PASSWORD;
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(given))) === ADMIN_PASSWORD_SHA256;
}

// Race day for a track, with lineups set from its Smash standings.
async function racesFor(env, track, now) {
  const store = raceStore(env, track.id);
  const [docs, record] = await Promise.all([store.docs(), track.leaderboardUrl ? getRecord(env, track.id) : null]);
  const standings = record ? (record.status === "locked" ? applyOverrides(record.standings, overridesFor(track)) : standingsFor(track, record.rows)) : null;
  return { track: track.id, live: store.live, version: docs.version ?? null, ...computeRaces(track, docs, teamsFor(track), standings) };
}

// Who each team sat out in the other weeks: { "<sponsor>": { "<pilot>": [weekIds] } }
async function satBefore(env, track) {
  const others = TRACKS.filter((t) => t.id !== track.id);
  const docs = await Promise.all(others.map((t) => raceStore(env, t.id).docs()));
  const out = {};
  docs.forEach((doc, i) => {
    for (const [sponsor, pilot] of Object.entries(doc?.lineup?.sitting || {})) ((out[sponsor] ||= {})[pilot] ||= []).push(others[i].id);
  });
  return out;
}

function summary(track, record, now) {
  const status = trackStatus(track, record, now);
  return {
    id: track.id,
    name: track.name,
    status,
    locksAt: track.locksAt || null,
    leaderboardUrl: track.leaderboardUrl || null,
    fetchedAt: record?.fetchedAt || null,
    lockedAt: record?.lockedAt || null,
  };
}

function detail(track, record, now) {
  const base = summary(track, record, now);
  if (!record) return { track: base, standings: null };
  // A locked track's saved standings stay as they were; league-set times are applied on top.
  const standings = record.status === "locked" ? applyOverrides(record.standings, overridesFor(track)) : standingsFor(track, record.rows);
  return {
    track: base,
    rowCount: record.rowCount,
    lockMethod: record.lockMethod || null,
    source: record.source || "page",
    quad: (record.status === "locked" ? record.quad : track.quad)?.name || null,
    nextUpdateAt: base.status === "live" ? nextHour(now, lockTime(track)) : null,
    standings,
  };
}

// The next scheduled refresh (every REFRESH_MINUTES), or the lock time if that comes first.
function nextHour(now, lockAt) {
  const step = REFRESH_MINUTES * 60_000;
  const t = Math.min(Math.floor(now / step) * step + step, lockAt);
  return new Date(t).toISOString();
}

const cors = () => ({ "access-control-allow-origin": "*", "access-control-allow-methods": "GET, OPTIONS" }); // admin writes are same-site only

function json(body, status, cacheControl) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": cacheControl, ...cors() },
  });
}

// ---------- data export ----------
// One organized dump: league info, teams and draft, the season table, and per track the
// Smash standings, race day, stats, every new best by a league pilot, and the hourly saves.
const teamName = (sponsor) => TEAM_NAMES[sponsor]?.name || sponsor;

async function exportAll(env, now) {
  const tracks = await Promise.all(TRACKS.map((t) => exportTrack(env, t, now).catch((e) => ({ id: t.id, name: t.name, error: String(e?.message || e) }))));
  const drafted = new Map(DRAFT_ORDER.map((d) => [d.pilot, d]));
  return {
    about: {
      league: LEAGUE,
      season: SEASON,
      exportedAt: new Date(now).toISOString(),
      site: "https://webleed-s5-leaderboard.blastaa.workers.dev/",
      notes: [
        "Times are seconds. Timestamps are UTC (ISO 8601).",
        "team is the sponsor key used throughout; teamName is the league's team name.",
        "vdroneLb is the position on the full Velocidrone leaderboard; leagueLb is the place among the league's own pilots (ties share a place).",
        "Race points per heat: 10 for 1st down to 1 for 10th. Bonus heats: 8 down to 1. Season table: Smash 10..1, Race 20..2, bonus round +3/+2/+1/0.",
        "newBests lists every first time (debut) and new personal best by a league pilot that the site saw, from its 5-minute checks and the league Discord bot's posts.",
      ],
    },
    teams: TEAMS.map((t, i) => ({
      team: t.sponsor,
      teamName: teamName(t.sponsor),
      color: TEAM_NAMES[t.sponsor]?.color || null,
      draftOrder: i + 1,
      captain: t.captain,
      pilots: [t.captain, ...t.pilots].map((p) => ({ pilot: p, captain: p === t.captain, tryoutRank: DRAFT_RANKS[p] ?? null, draftPosition: drafted.get(p)?.pos ?? null, draftRound: drafted.get(p)?.round ?? null, draftPick: drafted.get(p)?.pick ?? null })),
    })),
    draft: DRAFT_ORDER.map((d) => ({ position: d.pos, pilot: d.pilot, captain: d.captain, round: d.round, pick: d.pick, pickedBy: d.by, tryoutRank: DRAFT_RANKS[d.pilot] ?? null })),
    seasonTable: await overall(env, now),
    tracks,
  };
}

async function exportTrack(env, track, now) {
  const record = track.leaderboardUrl ? await getRecord(env, track.id) : null;
  const status = trackStatus(track, record, now);
  const info = {
    id: track.id, name: track.name, status, leaderboardUrl: track.leaderboardUrl || null,
    quad: track.quad?.name || null, opensAt: track.opensAt || null, locksAt: track.locksAt || null, raceDay: track.raceDay || null,
    lastCheckedAt: record?.fetchedAt || null, lockedAt: record?.lockedAt || null,
  };
  if (!record) return { ...info, smash: null, races: null, stats: null, newBests: [], hourly: [] };

  const d = detail(track, record, now);
  const all = d.standings.teams.flatMap((t) => t.pilots).filter((p) => p.posted && p.time != null).map((p) => p.time);
  const smash = d.standings.teams.map((t) => ({
    position: t.position, team: t.sponsor, teamName: teamName(t.sponsor), total: t.total, gap: t.gap ?? null, posted: t.posted,
    pilots: t.pilots.map((p) => ({
      pilot: p.name, captain: !!p.captain, posted: !!p.posted, time: p.posted ? p.time : null,
      vdroneLb: p.lb ?? null, leagueLb: p.posted && p.time != null ? 1 + all.filter((v) => v < p.time).length : null,
      leagueSetTime: p.override ? { listedTime: p.override.listed, note: p.override.note } : null,
    })),
  }));

  const r = await racesFor(env, track, now);
  const anyRace = r.tierResults.some((t) => t.racesRun > 0);
  const races = anyRace ? {
    raceDay: r.raceDay,
    satOut: Object.fromEntries(r.teams.map((t) => [t.sponsor, t.sitting])),
    teams: r.teams.map((t) => ({ place: t.place, team: t.sponsor, teamName: teamName(t.sponsor), raceTotal: t.raceTotal, byTier: t.byTier, sitting: t.sitting, lineup: t.lineup, bonusSeed: t.seed, bonusPlace: t.bonusPlace, bonusPoints: t.bonus })),
    tiers: r.tierResults.map((tr) => ({
      tier: tr.tier, heatsRun: tr.racesRun,
      teams: tr.entries.map((e) => ({ place: e.place, team: e.sponsor, teamName: teamName(e.sponsor), pilot: e.pilot, total: e.total })),
      heats: Array.from({ length: r.racesPerTier }, (_, hi) => ({
        heat: hi + 1,
        results: tr.entries.filter((e) => e.times[hi] != null).map((e) => ({ place: e.positions[hi], team: e.sponsor, teamName: teamName(e.sponsor), pilot: e.pilot, time: e.times[hi] === "dnf" ? "DNF" : e.times[hi], points: e.points[hi] })).sort((a, b) => (a.place || 99) - (b.place || 99)),
      })).filter((h) => h.results.length),
    })),
    bonus: r.bonus?.seeds?.length ? {
      seeds: r.bonus.seeds.map((s, i) => ({ seed: i + 1, team: s, teamName: teamName(s) })),
      places: r.bonus.places.map((p) => ({ place: p.place, team: p.sponsor, teamName: teamName(p.sponsor), points: p.points })),
      matches: r.bonus.matches.map((m) => ({
        match: m.label, teams: m.teams.map(teamName), winner: m.winner ? teamName(m.winner) : null, totals: m.totals ? Object.fromEntries(Object.entries(m.totals).map(([k, v]) => [teamName(k), v])) : null,
        heats: m.heats.filter((h) => h.run).map((h) => ({ heat: h.heat, score: Object.fromEntries(Object.entries(h.score || {}).map(([k, v]) => [teamName(k), v])), results: h.entries.map((e) => ({ place: e.position, team: e.sponsor, teamName: teamName(e.sponsor), tier: e.tier, pilot: e.pilot, time: e.time === "dnf" ? "DNF" : e.time, points: e.points })) })),
      })),
    } : null,
  } : null;

  const seed = seedFor(track.id, env.STATS_SEEDS);
  const [history, events] = await Promise.all([getHistory(env, track.id), getEvents(env, track.id)]);
  const hist = withSeedHistory(seed.history, history);
  const evts = withSeedEvents(seed.events, events);
  const teams = record.status === "locked" && record.teams ? record.teams : teamsFor(track);
  const stats = computeStats(track, hist, evts, teams);
  const roster = new Map();
  for (const t of teams) for (const p of [t.captain, ...t.pilots]) { roster.set(norm(p), { pilot: p, team: t.sponsor }); if (ALIASES[norm(p)]) roster.set(ALIASES[norm(p)], { pilot: p, team: t.sponsor }); }
  const newBests = evts.map((e) => ({ e, who: roster.get(norm(e.name)) })).filter((x) => x.who).sort((a, b) => a.e.at.localeCompare(b.e.at))
    .map(({ e, who }) => ({ at: e.at, pilot: who.pilot, team: who.team, teamName: teamName(who.team), kind: e.kind === "pb" ? "new best" : "first time", time: e.time, previous: e.prev ?? null, vdroneLb: e.rank ?? null }));
  const hourly = [...hist].sort((a, b) => a.at.localeCompare(b.at)).map((h) => ({
    at: h.at, final: !!h.final,
    teams: (h.teams || []).map(([team, total, posted]) => ({ team, teamName: teamName(team), total, posted })),
    pilots: h.pilots || {},
  }));
  const statLists = {
    from: stats.from, to: stats.to, newBestsCount: stats.summary.newBests,
    biggestGrinders: stats.grinders, smallestGrinders: stats.smallestGrinders,
    teamDepth: stats.depth, topOfEachTier: stats.tiers, tiersAt: stats.tiersAt,
    mostImprovedVsTryout: stats.sandbaggers, biggestDropsVsTryout: stats.dropoffs,
    mostImprovedVsDraftPick: stats.pickSandbaggers, biggestDropsVsDraftPick: stats.pickDropoffs,
    draftPositionVsLb: stats.draftBoard,
  };
  return { ...info, smash, races, stats: statLists, newBests, hourly };
}

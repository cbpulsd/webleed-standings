// weBLEEDfpv standings backend.
//
//   Timers (wrangler.jsonc "triggers")        -> hourly refresh of live tracks; lock run Saturdays 11:59 PM Eastern
//   GET  /api/tracks                          -> every track with its status, for the tabs
//   GET  /api/tracks/:id                      -> one track's standings
//   GET  /api/tracks/:id/history              -> that track's hourly snapshots
//   GET  /api/health/source/:id               -> read-only check that the game endpoint answers (cached 5 min)
//   POST /api/admin/tracks/:id/refresh|lock   -> manual controls (needs the ADMIN_TOKEN secret)
//
// The page in /public is served as static files and only reads from /api.

import { ALIASES, LATE_LOCK_AFTER_MINUTES, LEAGUE, NO_VISIT_REFRESH_BEFORE_LOCK_MINUTES, SEASON, STALE_MINUTES, TRACKS } from "./config.js";
import { computeStandings, norm, quadAllowed } from "./standings.js";
import { fetchGameLeaderboard, gameRows } from "./gameapi.js";
import { trackIdFromUrl } from "./leaderboard.js";
import { getHistory, getRecord } from "./store.js";
import { findTrack, lockTrack, lockTime, runSchedule, standingsFor, syncTrack, teamsFor, trackStatus } from "./sync.js";

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
  const standings = record.status === "locked" ? record.standings : standingsFor(track, record.rows);
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

// The next top of the hour, or the lock time if that comes first.
function nextHour(now, lockAt) {
  const t = Math.min(Math.floor(now / 3_600_000) * 3_600_000 + 3_600_000, lockAt);
  return new Date(t).toISOString();
}

const cors = () => ({ "access-control-allow-origin": "*", "access-control-allow-methods": "GET, OPTIONS" });

function json(body, status, cacheControl) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": cacheControl, ...cors() },
  });
}

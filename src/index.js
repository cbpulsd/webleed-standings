// weBLEEDfpv standings backend.
//
//   Timers (wrangler.jsonc "triggers")        -> hourly refresh of live tracks; lock run Saturdays 11:59 PM Eastern
//   GET  /api/tracks                          -> every track with its status, for the tabs
//   GET  /api/tracks/:id                      -> one track's standings
//   GET  /api/tracks/:id/history              -> that track's hourly snapshots
//   POST /api/admin/tracks/:id/refresh|lock   -> manual controls (needs the ADMIN_TOKEN secret)
//
// The page in /public is served as static files and only reads from /api.

import { ALIASES, LATE_LOCK_AFTER_MINUTES, LEAGUE, NO_VISIT_REFRESH_BEFORE_LOCK_MINUTES, SEASON, STALE_MINUTES, TRACKS } from "./config.js";
import { computeStandings, norm } from "./standings.js";
import { fetchGameLeaderboard } from "./gameapi.js";
import { TEAMS } from "./config.js";
import { getHistory, getRecord } from "./store.js";
import { findTrack, lockTrack, lockTime, runSchedule, syncTrack, teamsFor, trackStatus } from "./sync.js";

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

  // TEMPORARY test-branch probe (never merged to main): one read-only call to the game endpoint.
  if (request.method === "GET" && parts[1] === "_probe" && parts[2] === "game") {
    const trackId = url.searchParams.get("track") || "2207";
    const results = [];
    for (const v of (url.searchParams.get("v") || "1.16").split(",")) {
      try {
        const data = await fetchGameLeaderboard({ trackId, simVersion: v });
        const times = data.tracktimes || [];
        const names = new Set(times.map((t) => norm(t.playername)));
        const roster = TEAMS.flatMap((t) => [t.captain, ...t.pilots]);
        const models = times.reduce((a, t) => ((a[t.model_name || t.model_id] = (a[t.model_name || t.model_id] || 0) + 1), a), {});
        results.push({
          simVersion: v, success: data.success, message: data.message || null, count: times.length,
          fields: times[0] ? Object.keys(times[0]) : [], first: times.slice(0, 3), models,
          rosterFound: roster.filter((n) => names.has(norm(n))).length, rosterTotal: roster.length,
        });
      } catch (e) {
        results.push({ simVersion: v, error: String(e.message || e) });
      }
    }
    return json({ trackId, results }, 200, "no-store");
  }

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
  const standings = record.status === "locked" ? record.standings : computeStandings(record.rows, teamsFor(track), ALIASES);
  return {
    track: base,
    rowCount: record.rowCount,
    lockMethod: record.lockMethod || null,
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

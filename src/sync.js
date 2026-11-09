// Keeps each track's saved record current, and freezes it at the track's lock time.

import { ALIASES, FINAL_FETCH_WINDOW_SECONDS, TEAMS, TIME_OVERRIDES, TRACKS } from "./config.js";
import { fetchLeaderboard } from "./leaderboard.js";
import { applyOverrides, compactSnapshot, computeStandings, diffEvents } from "./standings.js";
import { appendEvents, appendHistory, getRecord, putRecord } from "./store.js";

export const findTrack = (id) => TRACKS.find((t) => String(t.id) === String(id)) || null;
export const teamsFor = (track) => track.teams || TEAMS;
export const lockTime = (track) => (track.locksAt ? Date.parse(track.locksAt) : Infinity);
export const overridesFor = (track) => TIME_OVERRIDES[track.id] || null;
export const standingsFor = (track, rows) => applyOverrides(computeStandings(rows, teamsFor(track), ALIASES, track.quad || null), overridesFor(track));

// "upcoming": no leaderboard yet, tab grayed out
// "live":     fetched every hour until its lock time
// "locking":  past its lock time, final save not done yet; never fetched, saved data shown
// "locked":   final standings saved, never fetched again
export function trackStatus(track, record, now) {
  if (record?.status === "locked") return "locked";
  if (!track.leaderboardUrl) return "upcoming";
  if (track.opensAt && now < Date.parse(track.opensAt)) return "upcoming";
  if (now >= lockTime(track)) return "locking";
  return "live";
}

// The hourly timer: refresh every live track, lock any that have reached their lock time.
export async function runSchedule(env, now, deps = {}) {
  const results = [];
  for (const track of TRACKS) {
    if (!track.leaderboardUrl) continue;
    try {
      results.push({ id: track.id, ...(await syncTrack(env, track, now, { ...deps, force: true })) });
    } catch (err) {
      results.push({ id: track.id, action: "error", error: String(err?.message || err) });
    }
  }
  return results;
}

// One track. `force` refreshes even if the saved data is recent.
export async function syncTrack(env, track, now, { force = false, staleMs = 0, fetchImpl, record } = {}) {
  record = record === undefined ? await getRecord(env, track.id) : record;
  const status = trackStatus(track, record, now);
  if (status === "locked") return { action: "skip-locked", record };
  if (status === "upcoming") return { action: "skip-upcoming", record: null };
  if (status === "locking") return lockTrack(env, track, record, now, { fetchImpl });

  if (!force && record && now - Date.parse(record.fetchedAt) < staleMs) return { action: "skip-fresh", record };

  const { rows, source, sourceError } = await fetchLeaderboard(track.leaderboardUrl, fetchImpl);
  const fetchedAt = new Date(now).toISOString();
  const next = { trackId: track.id, status: "live", fetchedAt, rowCount: rows.length, rows, source, sourceError };
  // A refresh that was still running when the lock happened must not overwrite it.
  const current = await getRecord(env, track.id);
  if (current?.status === "locked") return { action: "skip-locked", record: current };
  await putRecord(env, track.id, next);
  // Record new pilots and personal bests (only written when something changed).
  if (record?.rows) await appendEvents(env, track.id, diffEvents(record.rows, rows, fetchedAt, track.quad || null));
  // History keeps one snapshot an hour (the run on the hour), to stay well under KV's daily write limit.
  if (new Date(now).getUTCMinutes() === 0) await appendHistory(env, track.id, compactSnapshot(standingsFor(track, rows), fetchedAt));
  return { action: "refreshed", record: next };
}

// Freeze a track. A fresh fetch counts as final only when the lock timer runs within
// FINAL_FETCH_WINDOW_SECONDS of the lock time; otherwise the last times saved before
// the deadline are used. Page visits pass allowFetch: false.
export async function lockTrack(env, track, record, now, { fetchImpl, attempts = 3, retryDelayMs = 4000, allowFetch = true } = {}) {
  const deadline = lockTime(track);
  const lateBy = now - deadline;
  const inWindow = lateBy < FINAL_FETCH_WINDOW_SECONDS * 1000;
  let rows = null, fetchedAt = null, lockMethod = null, source = record?.source || null;

  if (allowFetch && inWindow) {
    for (let i = 0; i < attempts && !rows; i++) {
      try {
        ({ rows, source } = await fetchLeaderboard(track.leaderboardUrl, fetchImpl));
        fetchedAt = new Date(now).toISOString();
        lockMethod = "final-fetch";
      } catch (err) {
        if (i < attempts - 1 && retryDelayMs) await new Promise((r) => setTimeout(r, retryDelayMs));
      }
    }
  }
  if (!rows && record?.rows && Date.parse(record.fetchedAt) <= deadline) {
    rows = record.rows;
    fetchedAt = record.fetchedAt;
    lockMethod = allowFetch && inWindow ? "last-before-deadline (final fetch failed)" : "last-before-deadline";
  }
  if (!rows) throw new Error("no times saved before the lock time, and no final fetch was allowed or it failed");

  // Another run may have locked it while this one was fetching.
  const current = await getRecord(env, track.id);
  if (current?.status === "locked") return { action: "skip-locked", record: current };

  const teams = teamsFor(track);
  const standings = standingsFor(track, rows);
  const lockedAt = new Date(now).toISOString();
  const locked = {
    trackId: track.id,
    status: "locked",
    fetchedAt,
    lockedAt,
    locksAt: track.locksAt,
    lockMethod,
    source,
    quad: track.quad || null,
    rowCount: rows.length,
    rows,
    teams, // roster as it stood at the lock
    standings, // frozen: later roster or name fixes don't change a locked track
  };
  await putRecord(env, track.id, locked);
  if (lockMethod === "final-fetch" && record?.rows) await appendEvents(env, track.id, diffEvents(record.rows, rows, fetchedAt, track.quad || null));
  await appendHistory(env, track.id, { ...compactSnapshot(standings, fetchedAt), final: true });
  return { action: "locked", record: locked };
}

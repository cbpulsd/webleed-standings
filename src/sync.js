// Keeps each track's saved record current, and freezes it at the track's lock time.

import { ALIASES, LOCK_GRACE_MINUTES, TEAMS, TRACKS } from "./config.js";
import { fetchLeaderboard } from "./leaderboard.js";
import { compactSnapshot, computeStandings } from "./standings.js";
import { appendHistory, getRecord, putRecord } from "./store.js";

export const findTrack = (id) => TRACKS.find((t) => String(t.id) === String(id)) || null;
export const teamsFor = (track) => track.teams || TEAMS;
export const lockTime = (track) => (track.locksAt ? Date.parse(track.locksAt) : Infinity);

// "upcoming": no leaderboard yet, tab grayed out
// "live":     fetched every hour until its lock time
// "locking":  past its lock time, final save not done yet (done on the next run or visit)
// "locked":   final standings saved, never fetched again
export function trackStatus(track, record, now) {
  if (record?.status === "locked") return "locked";
  if (!track.leaderboardUrl) return "upcoming";
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

  const rows = await fetchLeaderboard(track.leaderboardUrl, fetchImpl);
  const fetchedAt = new Date(now).toISOString();
  const next = { trackId: track.id, status: "live", fetchedAt, rowCount: rows.length, rows };
  await putRecord(env, track.id, next);
  await appendHistory(env, track.id, compactSnapshot(computeStandings(rows, teamsFor(track), ALIASES), fetchedAt));
  return { action: "refreshed", record: next };
}

// Freeze a track. A fresh fetch counts as final only within the grace window after
// the lock time; otherwise the last times saved before the deadline are used.
export async function lockTrack(env, track, record, now, { fetchImpl, attempts = 3, retryDelayMs = 4000 } = {}) {
  const deadline = lockTime(track);
  const lateBy = now - deadline;
  let rows = null, fetchedAt = null, lockMethod = null;

  if (lateBy <= LOCK_GRACE_MINUTES * 60_000) {
    for (let i = 0; i < attempts && !rows; i++) {
      try {
        rows = await fetchLeaderboard(track.leaderboardUrl, fetchImpl);
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
    lockMethod = lateBy <= LOCK_GRACE_MINUTES * 60_000 ? "last-before-deadline (final fetch failed)" : "last-before-deadline";
  }
  if (!rows) throw new Error("no times saved before the lock time and the final fetch failed");

  // Another run may have locked it while this one was fetching.
  const current = await getRecord(env, track.id);
  if (current?.status === "locked") return { action: "skip-locked", record: current };

  const teams = teamsFor(track);
  const standings = computeStandings(rows, teams, ALIASES);
  const lockedAt = new Date(now).toISOString();
  const locked = {
    trackId: track.id,
    status: "locked",
    fetchedAt,
    lockedAt,
    locksAt: track.locksAt,
    lockMethod,
    rowCount: rows.length,
    rows,
    teams, // roster as it stood at the lock
    standings, // frozen: later roster or name fixes don't change a locked track
  };
  await putRecord(env, track.id, locked);
  await appendHistory(env, track.id, { ...compactSnapshot(standings, fetchedAt), final: true });
  return { action: "locked", record: locked };
}

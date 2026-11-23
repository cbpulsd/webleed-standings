// Turns test/fixtures/pilot-weeks.json (real Weeks 1-3) into the weeks computePilotStats reads,
// scoring the races with the site's own computeRaces. Used by the tests and the test preview.
import { computeRaces } from "../src/races.js";
import { TEAMS } from "../src/config.js";
import { findTrack } from "../src/sync.js";

export function fixtureWeeks(fx) {
  return fx.weeks.map((w) => {
    const track = findTrack(w.id);
    const results = (bySponsor) => Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8].map((r) => [r, Object.fromEntries(Object.entries(bySponsor).map(([sp, ts]) => [sp, ts[r - 1]]))]));
    const docs = { lineup: { sitting: w.sitting }, tiers: Object.fromEntries(Object.entries(w.tiers).map(([t, bySp]) => [t, { results: results(bySp) }])), bonus: { results: w.bonus } };
    return { id: w.id, name: `Week ${w.id}`, quad: track.quad?.name || null, lockedAt: w.lockedAt, smash: w.standings, races: computeRaces(track, docs, TEAMS, w.standings), bests: w.bests };
  });
}

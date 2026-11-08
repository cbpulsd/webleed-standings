// Stats data kept in the repo for hours a track ran before this site recorded them.
import track1 from "./track1.js";

const SEEDS = { 1: track1 };

// Tests can pass their own seeds (env.STATS_SEEDS) in place of the real ones.
export const seedFor = (id, seeds = SEEDS) => seeds[id] || { history: [], events: [] };

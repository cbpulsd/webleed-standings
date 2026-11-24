// Stats data kept in the repo for hours a track ran before this site recorded them.
import track1 from "./track1.js";
import track2 from "./track2.js";
import track3 from "./track3.js";
import track4 from "./track4.js";

const SEEDS = { 1: track1, 2: track2, 3: track3, 4: track4 };

// Tests can pass their own seeds (env.STATS_SEEDS) in place of the real ones.
export const seedFor = (id, seeds = SEEDS) => seeds[id] || { history: [], events: [] };

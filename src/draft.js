// Season 5 draft. `rank` is each pilot's tryout leaderboard rank going into the draft
// (captains included); `picks` is the snake draft order. Names match the rosters in config.js.

export const DRAFT_RANKS = {
  // Captains
  "Raimon Shaigne": 1, MonsterDuke: 2, "Fife Flyer": 5, AyyyKayyy: 6, PacoFPV: 7,
  AnnihilationRobo: 8, "caleb.": 9, Blastaa: 12, TMAD: 13, BenDaOctopus: 15,
  // Drafted pilots
  FPV_Cam: 17, asiy: 18, Mgescapades: 20, Doomburgerfpv: 28, "Cha Cha": 29, paszkevi4: 30,
  Senko: 31, "Hypnos FPV": 33, FulcrumFPV: 34, Dinglez: 37, ZAR: 39, FPVRossco: 40,
  NightwingFPV: 41, Blockfpv: 42, JAMUSXIII: 44, OmegaZenon: 45, Royden99: 46, "-Zip-": 47,
  "_-Crimson-_": 49, "Perc.FPV": 51, FakeitFPV: 53, "Sir Tarzan": 54, Wheelman: 55,
  SpookyV9: 56, Skittles: 58, xer: 61, ".MrE.": 62, Fastodon: 63, ZEBRA_THREE: 65,
  wolfgoat: 66, burnerXIII: 67, SteadyTrekker: 68, BallHawk: 69, LOUNDS: 70, Britchot: 77,
  BACONFEATURES: 85, redeux: 87, BrokenParts: 90, ZOETEK: 94, Lord_Lanny: 97,
};

// [pick, captain, pilot]
export const DRAFT_PICKS = [
  [1, "BenDaOctopus", "asiy"], [2, "TMAD", "FPV_Cam"], [3, "Blastaa", "Mgescapades"],
  [4, "caleb.", "Doomburgerfpv"], [5, "AnnihilationRobo", "Senko"], [6, "PacoFPV", "FulcrumFPV"],
  [7, "AyyyKayyy", "NightwingFPV"], [8, "Fife Flyer", "Cha Cha"], [9, "MonsterDuke", "Dinglez"],
  [10, "Raimon Shaigne", "FPVRossco"],
  [11, "Raimon Shaigne", "burnerXIII"], [12, "MonsterDuke", "OmegaZenon"], [13, "Fife Flyer", ".MrE."],
  [14, "AyyyKayyy", "Hypnos FPV"], [15, "PacoFPV", "Fastodon"], [16, "AnnihilationRobo", "paszkevi4"],
  [17, "caleb.", "Perc.FPV"], [18, "Blastaa", "xer"], [19, "TMAD", "Blockfpv"], [20, "BenDaOctopus", "ZAR"],
  [21, "BenDaOctopus", "ZEBRA_THREE"], [22, "TMAD", "Wheelman"], [23, "Blastaa", "SpookyV9"],
  [24, "caleb.", "_-Crimson-_"], [25, "AnnihilationRobo", "JAMUSXIII"], [26, "PacoFPV", "-Zip-"],
  [27, "AyyyKayyy", "Skittles"], [28, "Fife Flyer", "Royden99"], [29, "MonsterDuke", "Sir Tarzan"],
  [30, "Raimon Shaigne", "FakeitFPV"],
  [31, "Raimon Shaigne", "BallHawk"], [32, "MonsterDuke", "wolfgoat"], [33, "Fife Flyer", "LOUNDS"],
  [34, "AyyyKayyy", "BACONFEATURES"], [35, "PacoFPV", "ZOETEK"], [36, "AnnihilationRobo", "SteadyTrekker"],
  [37, "caleb.", "redeux"], [38, "Blastaa", "Britchot"], [39, "TMAD", "BrokenParts"], [40, "BenDaOctopus", "Lord_Lanny"],
];

// One draft position per league pilot, for comparing with the league LB: captains first
// (1-10, best captain first by tryout rank), then the 40 snake picks as positions 11-50.
// In the snake the lowest captain (BenDaOctopus) picks first in odd rounds and last in even ones.
const CAPTAINS = [...new Set(DRAFT_PICKS.map(([, captain]) => captain))].sort((a, b) => DRAFT_RANKS[a] - DRAFT_RANKS[b]);
export const DRAFT_ORDER = [
  ...CAPTAINS.map((pilot, i) => ({ pos: i + 1, pilot, captain: true, round: null, pick: null, by: null })),
  ...DRAFT_PICKS.map(([pick, by, pilot]) => ({ pos: CAPTAINS.length + pick, pilot, captain: false, round: Math.ceil(pick / CAPTAINS.length), pick, by })),
];

// Captain availability notes from the draft sheet.
export const AVAILABILITY = {
  "Fife Flyer": "Out Dec 13",
  PacoFPV: "Dec 20 uncertain",
};

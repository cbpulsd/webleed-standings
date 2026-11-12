// Season settings. Edit this file to add tracks, change lock times or fix roster names.

export const LEAGUE = "weBLEEDfpv";
export const SEASON = "Season 5";

// A pilot with no posted time counts as this many seconds.
export const NO_TIME = 999.99;

// Live tracks refresh every REFRESH_MINUTES (the timer in wrangler.jsonc must match).
// If the timer is missed, a visit to a live track refreshes data older than STALE_MINUTES.
// Visits never refresh in the last few minutes before a lock time.
export const REFRESH_MINUTES = 5;
export const STALE_MINUTES = 12;
export const NO_VISIT_REFRESH_BEFORE_LOCK_MINUTES = 5;

// Only the lock timer may fetch a track's final times, and only within this many seconds
// of the lock time. Otherwise the lock uses the last times saved before the deadline,
// so times posted after the deadline never count. Page visits never fetch a past-deadline track.
export const FINAL_FETCH_WINDOW_SECONDS = 60;

// If the lock timer never ran, the first visit this long after the lock time
// locks the track from its saved data (no fetch).
export const LATE_LOCK_AFTER_MINUTES = 30;

// Tracks, in order. Add more by appending { id, name, leaderboardUrl, locksAt }.
//   leaderboardUrl: the Velocidrone leaderboard page. Leave it out and the tab stays grayed out.
//   locksAt: when standings freeze, as a UTC timestamp. After it, the track is never fetched again.
//            Must line up with a timer in wrangler.jsonc (Saturdays 11:59 PM Eastern is set up).
//   quad: the required quad model. Only times on it count. { name, ids } — name as shown on
//         the leaderboard page, ids as Velocidrone's model IDs (121 = Hummingbird RS).
//   raceDay: the Sunday race day for this track's week (YYYY-MM-DD, Eastern).
//   teams: optional roster for just this track (defaults to TEAMS below).
export const TRACKS = [
  {
    id: 1,
    name: "Track 1",
    leaderboardUrl: "https://www.velocidrone.com/leaderboard/29/2207/All",
    locksAt: "2026-11-08T04:59:00Z", // Sat Nov 7, 11:59 PM Eastern
    quad: { name: "Hummingbird RS", ids: [121] },
    raceDay: "2026-11-08",
  },
  {
    id: 2,
    name: "Track 2",
    leaderboardUrl: "https://www.velocidrone.com/leaderboard/22/2214/All",
    opensAt: "2026-11-08T05:00:00Z", // right after Track 1 locks
    locksAt: "2026-11-15T04:59:00Z", // Sat Nov 14, 11:59 PM Eastern
    quad: { name: "Cetus PRO", ids: [] },
    raceDay: "2026-11-15",
  },
  { id: 3, name: "Track 3" },
  { id: 4, name: "Track 4" },
  { id: 5, name: "Track 5" },
  { id: 6, name: "Track 6" },
];

// Race director page password, stored as a SHA-256 hash so it isn't in the code.
// An ADMIN_PASSWORD secret on the Worker overrides it.
export const ADMIN_PASSWORD_SHA256 = "fdd233504638ffd87cdb5f1fc13b75ca808710e08b4029da8ed612d3f169a28d";

// Race day: each team races four of its five pilots, one per tier, and sits one.
// Every tier runs racesPerTier races; points[i] is what finishing position i+1 earns.
export const RACES = {
  tiers: 4,
  racesPerTier: 8,
  points: [10, 9, 8, 7, 6, 5, 4, 3, 2, 1],
  // Bonus round for the top four teams by race points: #1 v #4 and #2 v #3 fly
  // three heats each (all four racers per team, eight pilots a heat, heatPoints by place),
  // then the winners fly three heats for 1st/2nd and the losers for 3rd/4th.
  // Finishing 1st-4th adds these to the team's race points for the week.
  bonus: { teams: 4, heats: 3, heatPoints: [8, 7, 6, 5, 4, 3, 2, 1], points: [3, 2, 1, 0] },
};

// Season table points each week, by place. Smash (locked team standings): 1st 10
// down to 10th 1. Races (tier race points, before bonus): 1st 20 down to 10th 2.
// The bonus round's 3/2/1/0 is then added to the Race points of the top four.
export const SEASON_POINTS = {
  smash: [10, 9, 8, 7, 6, 5, 4, 3, 2, 1], // max 10
  race: [20, 18, 16, 14, 12, 10, 8, 6, 4, 2], // max 20
};

// The league's team names and colors, by sponsor (public/app.js keeps the same list for the page).
export const TEAM_NAMES = {
  "EMAX USA": { name: "BaguetteMax", color: "#00ff40" },
  MEPSKING: { name: "Five Crowns", color: "#b9f20d" },
  Happymodel: { name: "Loch & Load", color: "#ff0000" },
  "Fractal Engineering": { name: "Fractal Engineering", color: "#8000ff" },
  BETAFPV: { name: "SuperD Troopers", color: "#00ffff" },
  DamagD: { name: "Emotional DamageD", color: "#ff00ff" },
  NewBeeDrone: { name: "Wasted Ram", color: "#ffff00" },
  WREKD: { name: "ÉWREKD", color: "#0000ff" },
  Velocidrone: { name: "Two Weeks", color: "#ff8000" },
  RadioMaster: { name: "Zeeb team 5", color: "#ff80ff" },
};

// Season roster: captain plus four drafted pilots per team.
export const TEAMS = [
  { sponsor: "EMAX USA", captain: "Raimon Shaigne", pilots: ["FPVRossco", "FakeitFPV", "burnerXIII", "BallHawk"] },
  { sponsor: "MEPSKING", captain: "MonsterDuke", pilots: ["Dinglez", "OmegaZenon", "Sir Tarzan", "wolfgoat"] },
  { sponsor: "Happymodel", captain: "Fife Flyer", pilots: ["Cha Cha", "Royden99", ".MrE.", "LOUNDS"] },
  { sponsor: "Fractal Engineering", captain: "AyyyKayyy", pilots: ["Hypnos FPV", "NightwingFPV", "Skittles", "BACONFEATURES"] },
  { sponsor: "BETAFPV", captain: "PacoFPV", pilots: ["FulcrumFPV", "-Zip-", "Fastodon", "ZOETEK"] },
  { sponsor: "DamagD", captain: "AnnihilationRobo", pilots: ["paszkevi4", "Senko", "JAMUSXIII", "SteadyTrekker"] },
  { sponsor: "NewBeeDrone", captain: "caleb.", pilots: ["Doomburgerfpv", "_-Crimson-_", "Perc.FPV", "redeux"] },
  { sponsor: "WREKD", captain: "Blastaa", pilots: ["Mgescapades", "SpookyV9", "xer", "Britchot"] },
  { sponsor: "Velocidrone", captain: "TMAD", pilots: ["FPV_Cam", "Blockfpv", "Wheelman", "BrokenParts"] },
  { sponsor: "RadioMaster", captain: "BenDaOctopus", pilots: ["asiy", "ZAR", "ZEBRA_THREE", "Lord_Lanny"] },
];

// League-set times that replace what Velocidrone lists, by track and roster name.
// `since`: the override applies to saves from then on (stats history included).
export const TIME_OVERRIDES = {
  // e.g. 1: { AyyyKayyy: { time: 72.98, since: "2026-11-03T21:00:00Z", note: "why" } }
};

// Roster name -> Velocidrone name, only where they differ beyond capitals, spaces,
// punctuation or a "(Beta Tester)" tag. Both sides are written in matching form:
// lowercase letters and digits only.
export const ALIASES = {
  skittles: "theskittles",
  wheelman: "wheelman1",
};

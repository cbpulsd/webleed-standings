// Season settings. Edit this file to add tracks, change lock times or fix roster names.

export const LEAGUE = "weBLEEDfpv";
export const SEASON = "Season 5";

// A pilot with no posted time counts as this many seconds.
export const NO_TIME = 999.99;

// If the hourly timer is missed, a visit to a live track refreshes data older than this.
// Visits never refresh in the last few minutes before a lock time.
export const STALE_MINUTES = 65;
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
//   teams: optional roster for just this track (defaults to TEAMS below).
export const TRACKS = [
  {
    id: 1,
    name: "Track 1",
    leaderboardUrl: "https://www.velocidrone.com/leaderboard/29/2207/All",
    locksAt: "2026-11-08T04:59:00Z", // Sat Nov 7, 11:59 PM Eastern
  },
  { id: 2, name: "Track 2" },
  { id: 3, name: "Track 3" },
  { id: 4, name: "Track 4" },
  { id: 5, name: "Track 5" },
  { id: 6, name: "Track 6" },
];

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

// Roster name -> Velocidrone name, only where they differ beyond capitals, spaces,
// punctuation or a "(Beta Tester)" tag. Both sides are written in matching form:
// lowercase letters and digits only.
export const ALIASES = {
  skittles: "theskittles",
  wheelman: "wheelman1",
};

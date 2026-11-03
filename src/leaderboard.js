// Gets a track's leaderboard: the Velocidrone game endpoint first, the public
// leaderboard page as backup.
import { fetchGameLeaderboard, gameRows } from "./gameapi.js";

const FETCH_HEADERS = {
  "user-agent": "Mozilla/5.0 (compatible; weBLEEDfpv-standings/2.0)",
  accept: "text/html",
};

// "https://www.velocidrone.com/leaderboard/29/2207/All" -> "2207"
export const trackIdFromUrl = (url) => (String(url).match(/\/leaderboard\/\d+\/(\d+)/) || [])[1] || null;

// Returns { rows, source: "game" | "page", sourceError }.
export async function fetchLeaderboard(url, fetchImpl = fetch) {
  let sourceError = null;
  const trackId = trackIdFromUrl(url);
  if (trackId) {
    try {
      const rows = gameRows(await fetchGameLeaderboard({ trackId }, fetchImpl));
      if (rows.length) return { rows, source: "game", sourceError: null };
      sourceError = "game endpoint returned no times";
    } catch (err) {
      sourceError = String(err?.message || err).slice(0, 200);
    }
  }
  return { rows: await fetchPageLeaderboard(url, fetchImpl), source: "page", sourceError };
}

export async function fetchPageLeaderboard(url, fetchImpl = fetch) {
  const res = await fetchImpl(url, { headers: FETCH_HEADERS });
  if (!res.ok) throw new Error(`leaderboard returned ${res.status}`);
  const rows = parseLeaderboard(await res.text());
  if (!rows.length) throw new Error("no times found on the leaderboard page");
  return rows;
}

// Reads table rows shaped like: rank | time | player | country | ranking | model | date
export function parseLeaderboard(html) {
  const rows = [];
  for (const tr of html.split(/<tr[\s>]/i).slice(1)) {
    const cells = [...tr.split(/<\/tr>/i)[0].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)]
      .map((m) => decode(m[1].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim());
    if (cells.length < 3 || !/^\d+$/.test(cells[0])) continue;
    const time = toSeconds(cells[1]);
    if (time == null) continue;
    rows.push({ rank: +cells[0], time, name: cells[2], model: cells[5] || null });
  }
  return rows;
}

function toSeconds(s) {
  const m = s.match(/^(?:(\d+):)?(\d+\.\d{3})$/);
  return m ? Math.round(((m[1] ? +m[1] * 60 : 0) + parseFloat(m[2])) * 1000) / 1000 : null;
}

const NAMED = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function decode(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, e) => {
    const k = e.toLowerCase();
    if (k[0] === "#") {
      const code = k[1] === "x" ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    }
    // Unknown named entities (&lrm; and friends) are invisible marks: drop them.
    return NAMED[k] ?? "";
  });
}

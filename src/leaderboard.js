// Gets a track's leaderboard: the Velocidrone game endpoint first, the public
// leaderboard page as backup.
import { fetchGameLeaderboard, gameRows } from "./gameapi.js";

const normName = (s) => String(s).toLowerCase().replace(/\(beta tester\)/g, "").replace(/[^a-z0-9]/g, "");

const FETCH_HEADERS = {
  "user-agent": "Mozilla/5.0 (compatible; weBLEEDfpv-standings/2.0)",
  accept: "text/html",
};

// "https://www.velocidrone.com/leaderboard/29/2207/All" -> "2207"
export const trackIdFromUrl = (url) => (String(url).match(/\/leaderboard\/\d+\/(\d+)/) || [])[1] || null;

// Returns { rows, source: "game" | "page", sourceError, learned }.
// The game endpoint names quads only by id. `models` is what we already know
// ({ "<id>": "<name>" }); when the track's required quad isn't among them yet, the
// public page (which shows quad names) is read once to learn the ids it shows.
// `learned` holds any new ids, for the caller to save.
export async function fetchLeaderboard(url, fetchImpl = fetch, { quad = null, models = {} } = {}) {
  let sourceError = null;
  const trackId = trackIdFromUrl(url);
  if (trackId) {
    try {
      const rows = gameRows(await fetchGameLeaderboard({ trackId }, fetchImpl));
      if (rows.length) {
        const named = (list, map) => list.map((r) => (r.model || r.modelId == null || !map[r.modelId] ? r : { ...r, model: map[r.modelId] }));
        let out = named(rows, models);
        let learned = null;
        const quadKnown = !quad || (quad.ids || []).length || Object.values(models).some((n) => normName(n) === normName(quad.name));
        if (!quadKnown && out.some((r) => r.model == null && r.modelId != null)) {
          learned = await learnModels(url, out, fetchImpl).catch(() => null);
          if (learned) out = named(out, learned);
        }
        return { rows: out, source: "game", sourceError: null, learned };
      }
      sourceError = "game endpoint returned no times";
    } catch (err) {
      sourceError = String(err?.message || err).slice(0, 200);
    }
  }
  return { rows: await fetchPageLeaderboard(url, fetchImpl), source: "page", sourceError };
}

// Match game rows (with model ids) to page rows (with model names) by pilot and time.
async function learnModels(url, rows, fetchImpl) {
  const page = await fetchPageLeaderboard(url, fetchImpl);
  const byPilot = new Map(page.filter((p) => p.model).map((p) => [`${normName(p.name)}|${p.time.toFixed(3)}`, p.model]));
  const learned = {};
  for (const r of rows) {
    if (r.modelId == null || r.model) continue;
    const name = byPilot.get(`${normName(r.name)}|${r.time.toFixed(3)}`);
    if (name) learned[r.modelId] = name;
  }
  return Object.keys(learned).length ? learned : null;
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

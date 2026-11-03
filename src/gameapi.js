// Velocidrone in-game leaderboard endpoint (the one last season's spreadsheet bot used,
// approved by the Velocidrone developer for weBLEEDfpv). Requests and replies are
// AES-128-ECB encrypted with the game's key and base64-encoded.

const ENDPOINT = "https://velocidrone.co.uk/api/leaderboard/getLeaderBoard";
const KEY = "BatCaveGGevaCtaB";
const HEADERS = {
  "user-agent": "UnityPlayer/2020.3.8f1 (UnityWebRequest/1.0, libcurl/7.52.0-DEV)",
  accept: "*/*",
  "content-type": "application/x-www-form-urlencoded",
  "x-unity-version": "2020.3.8f1",
};

const enc = new TextEncoder();
const dec = new TextDecoder();
const IV = new Uint8Array(16);
let keyPromise = null;
const aesKey = () => (keyPromise ||= crypto.subtle.importKey("raw", enc.encode(KEY), { name: "AES-CBC" }, false, ["encrypt", "decrypt"]));

// WebCrypto has no ECB mode; one block of CBC with a zero IV is the same thing.
async function encryptBlock(block) {
  return new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv: IV }, await aesKey(), block)).slice(0, 16);
}
async function decryptBlock(block) {
  // Append a block that decrypts to valid padding so WebCrypto's padding check passes.
  const tail = await encryptBlock(block.map((b) => b ^ 16));
  const both = new Uint8Array(32);
  both.set(block);
  both.set(tail, 16);
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-CBC", iv: IV }, await aesKey(), both));
}

export async function encrypt(text) {
  const data = enc.encode(text);
  const n = 16 - (data.length % 16);
  const padded = new Uint8Array(data.length + n);
  padded.set(data);
  padded.fill(n, data.length);
  const out = new Uint8Array(padded.length);
  for (let i = 0; i < padded.length; i += 16) out.set(await encryptBlock(padded.slice(i, i + 16)), i);
  return btoa(String.fromCharCode(...out));
}

export async function decrypt(base64) {
  const bytes = Uint8Array.from(atob(base64.trim()), (c) => c.charCodeAt(0));
  if (!bytes.length || bytes.length % 16) throw new Error("reply is not an encrypted leaderboard");
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i += 16) out.set(await decryptBlock(bytes.slice(i, i + 16)), i);
  const n = out[out.length - 1];
  if (n < 1 || n > 16) throw new Error("bad padding in reply");
  return dec.decode(out.slice(0, out.length - n));
}

// Known model IDs, for replies that only carry the ID.
export const MODEL_NAMES = { 121: "Hummingbird RS" };

// Game reply -> rows in the same shape the page reader produces, plus IDs.
export function gameRows(data) {
  const times = Array.isArray(data?.tracktimes) ? data.tracktimes : [];
  return times
    .map((t) => {
      const modelId = t.model_id != null ? Number(t.model_id) : null;
      return {
        time: Math.round(parseFloat(t.lap_time) * 1000) / 1000,
        name: String(t.playername ?? "").trim(),
        model: t.model_name || MODEL_NAMES[modelId] || null,
        modelId,
        userId: t.user_id != null ? Number(t.user_id) : null,
      };
    })
    .filter((r) => r.name && Number.isFinite(r.time))
    .sort((a, b) => a.time - b.time)
    .map((r, i) => ({ rank: i + 1, ...r }));
}

export async function fetchGameLeaderboard({ trackId, simVersion = "1.16", count = 200, raceMode = 6, protectedTrack = 1 }, fetchImpl = fetch) {
  const query = `track_id=${trackId}&sim_version=${simVersion}&offset=0&count=${count}&protected_track_value=${protectedTrack}&race_mode=${raceMode}`;
  const body = "post_data=" + encodeURIComponent(await encrypt(query));
  const res = await fetchImpl(ENDPOINT, { method: "POST", headers: HEADERS, body });
  const text = await res.text();
  if (!res.ok) throw new Error(`game endpoint returned ${res.status}: ${text.slice(0, 80).replace(/\s+/g, " ")}`);
  return JSON.parse(await decrypt(text));
}

// Where race-day data lives: the RaceRoom Durable Object when the Worker has it
// (live updates, and the once-a-minute Copilot import on race day), otherwise KV
// (tests and the preview), where the Copilot import runs from the 5-minute schedule.

import { RACES } from "./config.js";
import { copilotTick } from "./copilot.js";
import { applyBonusPatch, applyResultsPatch, applySittingPatch, bonusKey, copilotKey, lineupKey, loadRaceDocs, tierKey } from "./races.js";

export function raceStore(env, trackId) {
  if (env.RACES_DO) {
    const stub = () => env.RACES_DO.get(env.RACES_DO.idFromName(`track-${trackId}`));
    const post = async (path, body) => {
      const res = await stub().fetch(`https://raceroom${path}`, { method: "POST", body: JSON.stringify(body) });
      const out = await res.json();
      if (!res.ok) throw new Error(out.error || `HTTP ${res.status}`);
      return out;
    };
    return {
      live: true,
      async docs() {
        const res = await stub().fetch("https://raceroom/docs");
        return res.json();
      },
      patch: (kind, tier, patch, teams, at) => post("/patch", { kind, tier, patch, teams, at }),
      connect: (request) => stub().fetch(new Request("https://raceroom/live", request)),
      // Copilot import, run inside the RaceRoom (its alarm checks once a minute).
      copilot: (action, body = {}) => post(`/copilot/${action}`, { ...body, trackId }),
    };
  }
  const store = {
    live: false,
    docs: () => loadRaceDocs(env, trackId),
    async patch(kind, tier, patch, teams, at) {
      if (kind === "lineup") {
        const next = applySittingPatch(await env.STANDINGS.get(lineupKey(trackId), "json"), patch, teams);
        await env.STANDINGS.put(lineupKey(trackId), JSON.stringify({ ...next, updatedAt: at }));
      } else if (kind === "tier" && tier >= 1 && tier <= RACES.tiers) {
        const next = applyResultsPatch(await env.STANDINGS.get(tierKey(trackId, tier), "json"), patch, teams);
        await env.STANDINGS.put(tierKey(trackId, tier), JSON.stringify({ ...next, updatedAt: at }));
      } else if (kind === "bonus") {
        const next = applyBonusPatch(await env.STANDINGS.get(bonusKey(trackId), "json"), patch, teams);
        await env.STANDINGS.put(bonusKey(trackId), JSON.stringify({ ...next, updatedAt: at }));
      } else throw new Error("unknown edit");
      return { ok: true };
    },
    getImport: () => env.STANDINGS.get(copilotKey(trackId), "json"),
    setImport: (state) => env.STANDINGS.put(copilotKey(trackId), JSON.stringify(state)),
    connect: async () => new Response("live updates need the RaceRoom Durable Object", { status: 501 }),
    // Without the Durable Object, "kick" and "run" check Copilot right away.
    async copilot(action, { track, now, fetchImpl, enabled } = {}) {
      if (action === "config") {
        const state = (await store.getImport()) || {};
        await store.setImport({ ...state, enabled: !!enabled, ...(enabled ? {} : { phase: "off" }) });
        if (!enabled) return { state: await store.getImport() };
      }
      return copilotTick(env, track, now, { store, fetchImpl, force: action === "run" });
    },
  };
  return store;
}

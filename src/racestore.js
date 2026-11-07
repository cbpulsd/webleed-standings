// Where race-day data lives: the RaceRoom Durable Object when the Worker has it
// (live updates), otherwise KV (tests and the preview).

import { RACES } from "./config.js";
import { applyResultsPatch, applySittingPatch, lineupKey, loadRaceDocs, tierKey } from "./races.js";

export function raceStore(env, trackId) {
  if (env.RACES_DO) {
    const stub = () => env.RACES_DO.get(env.RACES_DO.idFromName(`track-${trackId}`));
    return {
      live: true,
      async docs() {
        const res = await stub().fetch("https://raceroom/docs");
        return res.json();
      },
      async patch(kind, tier, patch, teams, at) {
        const res = await stub().fetch("https://raceroom/patch", { method: "POST", body: JSON.stringify({ kind, tier, patch, teams, at }) });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
        return body;
      },
      connect: (request) => stub().fetch(new Request("https://raceroom/live", request)),
    };
  }
  return {
    live: false,
    docs: () => loadRaceDocs(env, trackId),
    async patch(kind, tier, patch, teams, at) {
      if (kind === "lineup") {
        const next = applySittingPatch(await env.STANDINGS.get(lineupKey(trackId), "json"), patch, teams);
        await env.STANDINGS.put(lineupKey(trackId), JSON.stringify({ ...next, updatedAt: at }));
      } else if (kind === "tier" && tier >= 1 && tier <= RACES.tiers) {
        const next = applyResultsPatch(await env.STANDINGS.get(tierKey(trackId, tier), "json"), patch, teams);
        await env.STANDINGS.put(tierKey(trackId, tier), JSON.stringify({ ...next, updatedAt: at }));
      } else throw new Error("unknown edit");
      return { ok: true };
    },
    connect: async () => new Response("live updates need the RaceRoom Durable Object", { status: 501 }),
  };
}

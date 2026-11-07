// RaceRoom: one Durable Object per track's race day.
// Holds the lineup and race times (consistent for everyone, unlike KV's edge caching),
// applies race director edits one at a time, and pushes "update" to every page that
// has the Races tab or race director page open over a WebSocket.

import { RACES } from "./config.js";
import { applyResultsPatch, applySittingPatch } from "./races.js";

const tierIds = Array.from({ length: RACES.tiers }, (_, i) => i + 1);

export class RaceRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async docs() {
    const [lineup, version, ...tiers] = await Promise.all([
      this.state.storage.get("lineup"),
      this.state.storage.get("version"),
      ...tierIds.map((t) => this.state.storage.get(`tier:${t}`)),
    ]);
    return { lineup: lineup || {}, tiers: Object.fromEntries(tierIds.map((t, i) => [t, tiers[i] || {}])), version: version || 0 };
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/live") {
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("expected a WebSocket", { status: 426 });
      const pair = new WebSocketPair();
      this.state.acceptWebSocket(pair[1]);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    if (url.pathname === "/docs" && request.method === "GET") return Response.json(await this.docs());

    if (url.pathname === "/patch" && request.method === "POST") {
      const { kind, tier, patch, teams, at } = await request.json();
      try {
        if (kind === "lineup") {
          const next = applySittingPatch(await this.state.storage.get("lineup"), patch, teams);
          await this.state.storage.put("lineup", { ...next, updatedAt: at });
        } else if (kind === "tier" && tierIds.includes(tier)) {
          const key = `tier:${tier}`;
          const next = applyResultsPatch(await this.state.storage.get(key), patch, teams);
          await this.state.storage.put(key, { ...next, updatedAt: at });
        } else return Response.json({ error: "unknown edit" }, { status: 400 });
      } catch (err) {
        return Response.json({ error: String(err?.message || err) }, { status: 400 });
      }
      const version = ((await this.state.storage.get("version")) || 0) + 1;
      await this.state.storage.put("version", version);
      this.broadcast({ type: "update", version, kind, tier: tier ?? null });
      return Response.json({ ok: true, version });
    }

    return new Response("not found", { status: 404 });
  }

  broadcast(message) {
    const text = JSON.stringify(message);
    for (const ws of this.state.getWebSockets()) {
      try { ws.send(text); } catch (e) { /* closed */ }
    }
  }

  webSocketMessage(ws, message) {
    if (message === "ping") ws.send("pong");
  }

  webSocketClose(ws, code) {
    try { ws.close(code === 1005 ? 1000 : code, "bye"); } catch (e) {}
  }

  webSocketError() {}
}

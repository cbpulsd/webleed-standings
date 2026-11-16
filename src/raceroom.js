// RaceRoom: one Durable Object per track's race day.
// Holds the lineup and race times (consistent for everyone, unlike KV's edge caching),
// applies race director edits one at a time, and pushes "update" to every page that
// has the Races tab or race director page open over a WebSocket.
//
// On race day it also imports times from Copilot: the 5-minute schedule "kicks" it, and
// its alarm then checks Copilot once a minute until every heat is in and the end-of-day
// check passes (see copilot.js).

import { COPILOT, RACES } from "./config.js";
import { copilotTick, publicImport } from "./copilot.js";
import { applyBonusPatch, applyResultsPatch, applySittingPatch } from "./races.js";
import { findTrack } from "./sync.js";

const tierIds = Array.from({ length: RACES.tiers }, (_, i) => i + 1);

export class RaceRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async docs() {
    const [lineup, version, bonus, copilot, ...tiers] = await Promise.all([
      this.state.storage.get("lineup"),
      this.state.storage.get("version"),
      this.state.storage.get("bonus"),
      this.state.storage.get("copilot"),
      ...tierIds.map((t) => this.state.storage.get(`tier:${t}`)),
    ]);
    return { lineup: lineup || {}, bonus: bonus || {}, copilot: copilot || null, tiers: Object.fromEntries(tierIds.map((t, i) => [t, tiers[i] || {}])), version: version || 0 };
  }

  // One edit (from a race director or the Copilot import), then tell every open page.
  async applyEdit({ kind, tier, patch, teams, at }) {
    if (kind === "lineup") {
      const next = applySittingPatch(await this.state.storage.get("lineup"), patch, teams);
      await this.state.storage.put("lineup", { ...next, updatedAt: at });
    } else if (kind === "tier" && tierIds.includes(tier)) {
      const key = `tier:${tier}`;
      const next = applyResultsPatch(await this.state.storage.get(key), patch, teams);
      await this.state.storage.put(key, { ...next, updatedAt: at });
    } else if (kind === "bonus") {
      const next = applyBonusPatch(await this.state.storage.get("bonus"), patch, teams);
      await this.state.storage.put("bonus", { ...next, updatedAt: at });
    } else throw new Error("unknown edit");
    const version = ((await this.state.storage.get("version")) || 0) + 1;
    await this.state.storage.put("version", version);
    this.broadcast({ type: "update", version, kind, tier: tier ?? null });
    return { ok: true, version };
  }

  // The store copilotTick works with, backed by this object's own storage.
  localStore() {
    return {
      docs: () => this.docs(),
      patch: (kind, tier, patch, teams, at) => this.applyEdit({ kind, tier, patch, teams, at }),
      getImport: () => this.state.storage.get("copilot"),
      setImport: async (s) => {
        const before = JSON.stringify(publicFlags(await this.state.storage.get("copilot")));
        await this.state.storage.put("copilot", s);
        // A new or cleared notice shows on open pages without waiting for a time to change.
        if (JSON.stringify(publicFlags(s)) !== before) this.broadcast({ type: "update", kind: "copilot" });
      },
    };
  }

  async runCopilot(force = false) {
    const trackId = await this.state.storage.get("trackId");
    const track = trackId != null ? findTrack(trackId) : null;
    if (!track) return { state: null, again: false };
    const result = await copilotTick(this.env, track, Date.now(), { store: this.localStore(), force });
    if (result.again) await this.state.storage.setAlarm(Date.now() + COPILOT.pollSeconds * 1000);
    else await this.state.storage.deleteAlarm();
    return result;
  }

  async alarm() {
    try {
      await this.runCopilot();
    } catch (err) {
      console.error("copilot import", err);
      await this.state.storage.setAlarm(Date.now() + COPILOT.pollSeconds * 1000);
    }
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
      try {
        return Response.json(await this.applyEdit(await request.json()));
      } catch (err) {
        return Response.json({ error: String(err?.message || err) }, { status: 400 });
      }
    }

    // Copilot import controls: kick (start the minute checks if they aren't running),
    // run (check now, even outside race day), config ({ enabled }).
    if (url.pathname.startsWith("/copilot/") && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      if (body.trackId != null) await this.state.storage.put("trackId", body.trackId);
      const action = url.pathname.slice("/copilot/".length);
      try {
        if (action === "kick") {
          if (!(await this.state.storage.getAlarm())) await this.state.storage.setAlarm(Date.now() + 1000);
          return Response.json({ ok: true });
        }
        if (action === "config") {
          const s = (await this.state.storage.get("copilot")) || {};
          await this.localStore().setImport({ ...s, enabled: !!body.enabled, ...(body.enabled ? {} : { phase: "off" }) });
          if (!body.enabled) { await this.state.storage.deleteAlarm(); return Response.json({ state: publicImport(await this.state.storage.get("copilot")) }); }
        }
        if (action === "run" || action === "config") {
          const { state } = await this.runCopilot(action === "run");
          return Response.json({ state: publicImport(state) });
        }
      } catch (err) {
        return Response.json({ error: String(err?.message || err) }, { status: 500 });
      }
      return Response.json({ error: "unknown action" }, { status: 404 });
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

const publicFlags = (s) => (s ? { phase: s.phase, flags: s.flags, enabled: s.enabled, check: s.check } : null);

// Standings page. Reads only from /api; the backend does all fetching and locking.
(() => {
  const api = (path) => (window.STANDINGS_FETCH || fetch)("/api" + path, { cache: "no-store" });
  const now = () => (window.STANDINGS_NOW ? window.STANDINGS_NOW() : Date.now());
  const NO_TIME = 999.99;
  const POLL_AFTER_HOUR_MS = 90_000; // check for the new hourly data 90 s after the hour
  const RETRY_MS = 5 * 60_000;

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const fmt = (t) => t.toFixed(3);
  const timeFmt = new Intl.DateTimeFormat([], { hour: "numeric", minute: "2-digit" });
  const dayFmt = new Intl.DateTimeFormat([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });

  const state = { tracks: [], current: null, data: null, view: "teams", pollTimer: null, loading: false, error: null, stopped: false };

  // Lets a page restart the app cleanly (used by the test preview's scenario switch).
  if (window.__standingsStop) window.__standingsStop();
  window.__standingsStop = () => { state.stopped = true; clearTimeout(state.pollTimer); clearInterval(tickTimer); };

  // ---------- helpers ----------
  function ago(iso) {
    const m = Math.round((now() - Date.parse(iso)) / 60000);
    if (m < 1) return "just now";
    if (m < 60) return `${m} min ago`;
    const h = Math.floor(m / 60);
    return h < 24 ? `${h} hr ${m % 60} min ago` : dayFmt.format(new Date(iso));
  }
  function countdown(ms) {
    if (ms <= 0) return "now";
    const s = Math.floor(ms / 1000), d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    if (d) return `${d}d ${h}h`;
    if (h) return `${h}h ${m}m`;
    return `${m}:${String(sec).padStart(2, "0")}`;
  }
  const statusLabel = { live: "Live", locking: "Locking", locked: "Final", upcoming: "Soon" };

  // ---------- track tabs ----------
  function renderTabs() {
    const el = $("trackTabs");
    el.style.setProperty("--n", state.tracks.length);
    el.innerHTML = state.tracks
      .map((t) => {
        const off = t.status === "upcoming";
        return `<button class="track-tab" role="tab" type="button" data-id="${t.id}" data-status="${t.status}"
          aria-selected="${t.id === state.current}" ${off ? 'disabled aria-disabled="true" title="Opens later"' : ""}>
          <span>${esc(t.name)}</span><span class="state">${statusLabel[t.status] || ""}</span></button>`;
      })
      .join("");
  }
  $("trackTabs").addEventListener("click", (e) => {
    const b = e.target.closest(".track-tab");
    if (b && !b.disabled) selectTrack(+b.dataset.id);
  });
  $("trackTabs").addEventListener("keydown", (e) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const open = state.tracks.filter((t) => t.status !== "upcoming");
    const i = open.findIndex((t) => t.id === state.current);
    const next = open[(i + (e.key === "ArrowRight" ? 1 : -1) + open.length) % open.length];
    if (next) { selectTrack(next.id); document.querySelector(`.track-tab[data-id="${next.id}"]`)?.focus(); }
  });

  function selectTrack(id) {
    if (id === state.current && state.data) return;
    state.current = id;
    state.data = null;
    try { history.replaceState(null, "", "#track-" + id); } catch (e) {}
    renderTabs();
    renderHeader();
    load();
  }

  // ---------- header + status ----------
  function currentTrack() { return state.tracks.find((t) => t.id === state.current) || null; }

  function renderHeader() {
    const t = currentTrack();
    if (!t) return;
    $("title").textContent = `${t.name} Team Standings`;
    document.title = `Season 5 ${t.name} Standings`;
    const link = t.leaderboardUrl ? ` from the <a href="${esc(t.leaderboardUrl)}" target="_blank" rel="noopener">Velocidrone leaderboard</a>` : "";
    $("sub").innerHTML = `Combined lap times for each team's five pilots${link}. Lowest combined time leads. Pilots without a posted time count as 999.99.`;
  }

  function setStatus(kind, msg, meta = []) {
    $("status").dataset.state = kind;
    $("statusMsg").textContent = msg;
    $("statusMeta").innerHTML = meta.map((m) => `<span>${m}</span>`).join("");
  }

  function renderStatus() {
    const d = state.data, t = currentTrack();
    if (state.loading && !d) return setStatus("busy", "Loading standings…");
    if (state.error && !d) return setStatus("error", `Couldn't load standings (${state.error}). Trying again in a few minutes.`);
    if (!d || !t) return;
    const s = d.track;
    if (s.status === "locked") {
      return setStatus("final", "Final standings. This track is locked and won't change.", [
        `Locked <b>${dayFmt.format(new Date(s.lockedAt))}</b>`,
        `Times as of <b>${dayFmt.format(new Date(s.fetchedAt))}</b>`,
      ]);
    }
    if (s.status === "locking") return setStatus("busy", "The deadline has passed. Final standings are being saved.");
    if (!s.fetchedAt) return setStatus("busy", "Waiting for the first leaderboard update.");
    const meta = [`Updated <b>${timeFmt.format(new Date(s.fetchedAt))}</b> (${ago(s.fetchedAt)})`];
    if (d.nextUpdateAt) meta.push(`Next update in <b>${countdown(Date.parse(d.nextUpdateAt) - now())}</b>`);
    if (s.locksAt) meta.push(`Locks in <b>${countdown(Date.parse(s.locksAt) - now())}</b>`);
    const err = state.error ? ` Last check failed (${state.error}); showing saved times.` : "";
    setStatus(state.error ? "error" : "live", `Live · ${d.rowCount} times on the leaderboard.${err}`, meta);
  }

  // ---------- standings ----------
  function renderStandings() {
    const d = state.data;
    if (!d || !d.standings) {
      const t = currentTrack();
      const msg = t && t.status === "upcoming" ? "This track hasn't opened yet." : state.loading ? "" : "No times saved for this track yet.";
      $("viewTeams").innerHTML = msg ? `<div class="empty">${msg}</div>` : "";
      $("pilotRows").innerHTML = "";
      return;
    }
    const teams = d.standings.teams;
    $("viewTeams").innerHTML = teams
      .map((t) => `
      <article class="team">
        <div class="team-head">
          <div class="pos">${t.position}</div>
          <div class="tname">
            <h2>Team ${esc(t.sponsor)}</h2>
            <p>Captain ${esc(t.captain)}<span class="posted${t.posted === t.size ? " full" : ""}">${t.posted}/${t.size} posted</span></p>
          </div>
          <div class="total">
            <div class="t">${fmt(t.total)}</div>
            <div class="g">${t.position === 1 ? "leader" : "+" + fmt(t.gap)}</div>
          </div>
        </div>
        <table class="pilots"><tbody>
          ${t.pilots.map((p) => `<tr class="${p.posted ? "" : "notime"}">
            <td class="name">${esc(p.name)}${p.captain ? '<span class="cap">Capt</span>' : ""}</td>
            <td class="lb">${p.lb ? "LB #" + p.lb : ""}</td>
            <td class="time">${p.posted ? fmt(p.time) : NO_TIME.toFixed(2)}</td>
          </tr>`).join("")}
        </tbody></table>
      </article>`)
      .join("");

    const all = teams.flatMap((t) => t.pilots.map((p) => ({ ...p, team: t.sponsor }))).sort((a, b) => a.time - b.time || a.name.localeCompare(b.name));
    let n = 0;
    $("pilotRows").innerHTML = all
      .map((p) => `<tr class="${p.posted ? "" : "muted"}">
        <td class="num">${p.posted ? ++n : "–"}</td>
        <td>${esc(p.name)}${p.captain ? '<span class="cap">Capt</span>' : ""}</td>
        <td class="muted">${esc(p.team)}</td>
        <td class="num muted">${p.lb ? "#" + p.lb : ""}</td>
        <td class="num">${p.posted ? fmt(p.time) : NO_TIME.toFixed(2)}</td>
      </tr>`)
      .join("");
  }

  function showView(v) {
    state.view = v;
    $("viewTeamsBtn").setAttribute("aria-selected", v === "teams");
    $("viewPilotsBtn").setAttribute("aria-selected", v === "pilots");
    $("viewTeams").hidden = v !== "teams";
    $("viewPilots").hidden = v !== "pilots";
  }
  $("viewTeamsBtn").addEventListener("click", () => showView("teams"));
  $("viewPilotsBtn").addEventListener("click", () => showView("pilots"));

  // ---------- loading ----------
  async function load() {
    const id = state.current;
    clearTimeout(state.pollTimer);
    state.loading = true;
    renderStatus();
    renderStandings();
    try {
      const res = await api(`/tracks/${id}`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      if (state.stopped || id !== state.current) return; // switched tabs meanwhile
      state.data = body;
      state.error = null;
      const t = currentTrack();
      if (t && t.status !== body.track.status) { Object.assign(t, body.track); renderTabs(); }
    } catch (e) {
      if (id !== state.current) return;
      state.error = e.message;
    } finally {
      if (id === state.current) {
        state.loading = false;
        renderStatus();
        renderStandings();
        schedulePoll();
      }
    }
  }

  function schedulePoll() {
    clearTimeout(state.pollTimer);
    const d = state.data;
    let wait = null;
    if (state.error) wait = RETRY_MS;
    else if (d && (d.track.status === "live" || d.track.status === "locking")) {
      const target = d.nextUpdateAt ? Date.parse(d.nextUpdateAt) + POLL_AFTER_HOUR_MS : now() + RETRY_MS;
      wait = Math.max(30_000, target - now());
    }
    if (wait != null) state.pollTimer = setTimeout(load, wait);
  }

  document.addEventListener("visibilitychange", () => {
    if (state.stopped || document.visibilityState !== "visible" || state.loading || !state.data) return;
    const d = state.data;
    if (d.track.status !== "locked" && d.nextUpdateAt && now() > Date.parse(d.nextUpdateAt) + POLL_AFTER_HOUR_MS) load();
  });
  const tickTimer = setInterval(renderStatus, 1000);

  // ---------- start ----------
  async function start() {
    try {
      const res = await api("/tracks");
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      state.tracks = body.tracks;
    } catch (e) {
      state.error = e.message;
      renderStatus();
      setTimeout(start, RETRY_MS);
      return;
    }
    const fromHash = +((location.hash.match(/^#track-(\d+)$/) || [])[1] || 0);
    const pick =
      state.tracks.find((t) => t.id === fromHash && t.status !== "upcoming") ||
      state.tracks.find((t) => t.status === "live" || t.status === "locking") ||
      [...state.tracks].reverse().find((t) => t.status === "locked") ||
      state.tracks[0];
    state.error = null;
    selectTrack(pick.id);
  }
  window.addEventListener("hashchange", () => {
    if (state.stopped) return;
    const id = +((location.hash.match(/^#track-(\d+)$/) || [])[1] || 0);
    const t = state.tracks.find((x) => x.id === id);
    if (t && t.status !== "upcoming") selectTrack(id);
  });

  start();
})();

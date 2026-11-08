// Standings page. Reads only from /api; the backend does all fetching and locking.
(() => {
  const api = (path, init = {}) => (window.STANDINGS_FETCH || fetch)("/api" + path, { cache: "no-store", ...init });
  const now = () => (window.STANDINGS_NOW ? window.STANDINGS_NOW() : Date.now());
  const NO_TIME = 999.99;
  const POLL_AFTER_HOUR_MS = 60_000; // check for new data a minute after each scheduled refresh
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

  // ---------- tabs: Overall, then one per track ----------
  const OVERALL = "overall";
  const isOverall = () => state.current === OVERALL;

  function renderTabs() {
    const el = $("trackTabs");
    el.style.setProperty("--n", state.tracks.length + 1);
    el.innerHTML =
      `<button class="track-tab overall-tab" role="tab" type="button" data-id="${OVERALL}" data-status="overall"
        aria-selected="${isOverall()}"><span>Overall</span></button>` +
      state.tracks
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
    if (b && !b.disabled) selectTrack(b.dataset.id === OVERALL ? OVERALL : +b.dataset.id);
  });
  $("trackTabs").addEventListener("keydown", (e) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const open = [{ id: OVERALL }, ...state.tracks.filter((t) => t.status !== "upcoming")];
    const i = open.findIndex((t) => t.id === state.current);
    const next = open[(i + (e.key === "ArrowRight" ? 1 : -1) + open.length) % open.length];
    if (next) { selectTrack(next.id); document.querySelector(`.track-tab[data-id="${next.id}"]`)?.focus(); }
  });

  function selectTrack(id, force = false) {
    if (id === state.current && state.data && !force) return;
    state.current = id;
    state.data = null;
    state.races = null;
    state.stats = null;
    try { history.replaceState(null, "", id === OVERALL ? "#overall" : "#track-" + id); } catch (e) {}
    renderTabs();
    renderHeader();
    applyLayout();
    load();
  }

  // The Overall tab shows the season table instead of the Teams/Pilots views.
  function applyLayout() {
    const o = isOverall();
    document.querySelector(".views").hidden = o;
    $("viewOverall").hidden = !o;
    document.querySelector(".wrap").classList.toggle("wide", o);
    if (o) { $("viewTeams").hidden = true; $("viewPilots").hidden = true; $("viewRaces").hidden = true; $("viewStats").hidden = true; liveStop(); }
    else showView(state.view);
  }

  // ---------- header + status ----------
  function currentTrack() { return state.tracks.find((t) => t.id === state.current) || null; }

  function renderHeader() {
    if (isOverall()) {
      $("title").textContent = "Overall Standings";
      document.title = "Season 5 Overall Standings";
      $("sub").textContent = "Season points for each team: Smash points and Race points for every week. Points are added after each week's races.";
      return;
    }
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
    if (d && isOverall()) {
      const any = d.teams.some((x) => x.total != null);
      return any
        ? setStatus("live", "Season points so far.", d.updatedAt ? [`Updated <b>${dayFmt.format(new Date(d.updatedAt))}</b>`] : [])
        : setStatus("idle", "No points yet. Points are added after each week's races.");
    }
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

  // ---------- overall ----------
  const pts = (v) => (v == null ? '<span class="dash">–</span>' : esc(v));
  function renderOverall() {
    const d = state.data;
    if (!d) { $("overallTable").innerHTML = ""; return; }
    const head1 = d.weeks.map((w) => `<th class="wk" colspan="2" scope="colgroup">${esc(w.label)}</th>`).join("");
    const head2 = d.weeks.map(() => `<th class="sub wk-start" scope="col">Smash</th><th class="sub" scope="col">Race</th>`).join("");
    const body = d.teams
      .map((t) => `<tr>
        <th class="team-col" scope="row"><div class="ocell">${t.position != null ? `<span class="opos">${t.position}</span>` : ""}<span class="oname"><b>Team ${esc(t.sponsor)}</b><small>Capt ${esc(t.captain)}</small></span></div></th>
        ${d.weeks.map((w) => `<td class="num wk-start">${pts(t.weeks[w.id]?.smash)}</td><td class="num">${pts(t.weeks[w.id]?.race)}</td>`).join("")}
        <td class="num tot">${pts(t.total)}</td>
      </tr>`)
      .join("");
    $("overallTable").innerHTML = `<thead>
        <tr><th class="team-col" rowspan="2" scope="col">Team</th>${head1}<th class="tot" rowspan="2" scope="col">Total</th></tr>
        <tr>${head2}</tr>
      </thead><tbody>${body}</tbody>`;
  }

  // ---------- standings ----------
  function renderStandings() {
    if (isOverall()) return renderOverall();
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
    $("viewRacesBtn").setAttribute("aria-selected", v === "races");
    $("viewStatsBtn").setAttribute("aria-selected", v === "stats");
    $("viewStats").hidden = v !== "stats";
    if (v === "stats" && !isOverall()) loadStats();
    $("viewRaces").hidden = v !== "races";
    if (v === "races" && !isOverall()) { loadRaces(); liveStart(state.current, loadRaces); }
    else liveStop();
    $("viewTeams").hidden = v !== "teams";
    $("viewPilots").hidden = v !== "pilots";
  }
  $("viewTeamsBtn").addEventListener("click", () => showView("teams"));
  $("viewPilotsBtn").addEventListener("click", () => showView("pilots"));
  $("viewRacesBtn").addEventListener("click", () => showView("races"));
  $("viewStatsBtn").addEventListener("click", () => showView("stats"));

  // ---------- races ----------
  const ordinal = (n) => n + (n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] || "th");
  const raceDayFmt = new Intl.DateTimeFormat([], { weekday: "long", month: "short", day: "numeric" });

  async function loadRaces() {
    const id = state.current;
    if (id == null || isOverall()) return;
    if (!state.races || state.races.id !== id) { state.races = { id, data: null, error: null }; renderRaces(); }
    try {
      const res = await api(`/tracks/${id}/races`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      if (state.stopped || state.current !== id) return;
      state.races = { id, data: body, error: null };
    } catch (e) {
      if (state.current !== id) return;
      state.races = { id, data: state.races?.data || null, error: e.message };
    }
    renderRaces();
  }

  const fmtTime = (t) => (t === "dnf" ? "DNF" : typeof t === "number" ? t.toFixed(3) : "");
  const resultTitle = (time, pos) => (time == null ? "" : time === "dnf" ? "DNF" : `${fmtTime(time)} s · ${ordinal(pos)}`);
  const place = (p) => (p != null ? `<span class="opos">${p}</span>` : "");
  const pilotLabel = (p) => (p ? esc(p) : '<span class="tbd">Pilot TBD</span>');
  const raceDayText = (d) => (d.raceDay ? raceDayFmt.format(new Date(d.raceDay + "T12:00:00")) : "Sunday");
  const leaderOf = (list) => (list[0] && list[0].place === 1 ? `Leader: Team ${esc(list[0].sponsor)} (${list[0].total})` : "");
  const metaJoin = (...parts) => parts.filter(Boolean).join(" · ");
  const tierMeta = (t, d) => metaJoin(t.racesRun ? `${t.racesRun} of ${d.racesPerTier} races run` : `${d.racesPerTier} races`, leaderOf(t.entries));
  const fold = (key, title, meta, inner) => `
      <details class="fold" data-fold="${key}"${isOpen(key) ? " open" : ""}>
        <summary class="sec-head"><h2>${title}</h2><span data-meta="${key}">${meta}</span></summary>
        ${inner}
      </details>`;

  function raceSummaryTable(d) {
    const tiers = d.tierResults.map((t) => t.tier);
    return `
      <div class="table-wrap"><table class="overall grid">
        <thead><tr><th class="team-col" scope="col">Team</th>${tiers.map((t) => `<th class="num wk-start" scope="col">Tier ${t}</th>`).join("")}<th class="num tot" scope="col">Total</th><th class="wk-start sit" scope="col">Sitting out</th></tr></thead>
        <tbody>${d.teams.map((t) => `<tr>
          <th class="team-col" scope="row"><div class="ocell">${place(t.place)}<span class="oname"><b>Team ${esc(t.sponsor)}</b><small>Capt ${esc(t.captain)}</small></span></div></th>
          ${tiers.map((ti) => `<td class="num wk-start">${pts(t.byTier[ti])}</td>`).join("")}
          <td class="num tot">${pts(t.total)}</td>
          <td class="wk-start sit">${t.sitting ? esc(t.sitting) : '<span class="tbd">TBD</span>'}</td>
        </tr>`).join("")}</tbody>
      </table></div>`;
  }

  function renderRaces() {
    const el = $("viewRaces");
    const r = state.races;
    if (!r || (!r.data && !r.error)) { el.innerHTML = `<div class="empty">Loading race day…</div>`; return; }
    if (!r.data) { el.innerHTML = `<div class="empty">Couldn't load race results (${esc(r.error)}).</div>`; return; }
    const d = r.data;
    const anyResults = d.tierResults.some((t) => t.racesRun > 0);
    const pointsLine = d.points.map((p, i) => `${ordinal(i + 1)} ${p}`).join(" · ");
    const summary = raceSummaryTable(d);

    const tierTables = d.tierResults.map((t) => fold(`tier-${t.tier}`, `Tier ${t.tier}`, tierMeta(t, d), `
        <div class="table-wrap"><table class="overall grid">
          <thead><tr><th class="team-col" scope="col">Team · Pilot</th>${Array.from({ length: d.racesPerTier }, (_, i) => `<th class="num${i === 0 ? " wk-start" : ""}" scope="col">R${i + 1}</th>`).join("")}<th class="num tot" scope="col">Total</th></tr></thead>
          <tbody>${t.entries.map((e) => `<tr>
            <th class="team-col" scope="row"><div class="ocell">${place(e.place)}<span class="oname"><b>Team ${esc(e.sponsor)}</b><small>${pilotLabel(e.pilot)}</small></span></div></th>
            ${e.points.map((p, i) => `<td class="num${i === 0 ? " wk-start" : ""}"${e.times?.[i] != null ? ` title="${resultTitle(e.times[i], e.positions[i])}"` : ""}>${pts(p)}</td>`).join("")}
            <td class="num tot">${pts(e.total)}</td>
          </tr>`).join("")}</tbody>
        </table></div>`)).join("");

    el.innerHTML = `
      <p class="races-note"><b>Race day: ${esc(raceDayText(d))}.</b> Each team races four of its five pilots, one per tier, and sits one. Every tier runs ${d.racesPerTier} races. Points by finishing position: ${pointsLine}.${anyResults ? "" : " Lineups and results appear here on race day."}${d.live ? ' <span class="live-pill">Updates live</span>' : ""}</p>
      ${fold("summary", "Team race points", leaderOf(d.teams), summary)}
      ${tierTables}
      <div class="races-foot"><a class="btn" href="#admin-${d.track}">Race director: enter results</a></div>`;
  }

  // ---------- stats ----------
  const ET = "America/New_York";
  const etTime = new Intl.DateTimeFormat([], { timeZone: ET, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const etDay = new Intl.DateTimeFormat("en-US", { timeZone: ET, weekday: "short", month: "short", day: "numeric" });
  const etParts = (iso) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: ET, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
    return { day: `${p.year}-${p.month}-${p.day}`, hour: +p.hour };
  };
  const secs = (v, d = 3) => (v == null ? "–" : v.toFixed(d));
  const SERIES = ["var(--s1)", "var(--s2)", "var(--s3)", "var(--s4)", "var(--s5)", "var(--s6)", "var(--s7)", "var(--s8)"];

  async function loadStats(quiet = false) {
    const id = state.current;
    if (id == null || isOverall()) return;
    if (!quiet || !state.stats || state.stats.id !== id) { state.stats = { id, data: null, error: null }; renderStats(); }
    try {
      const res = await api(`/tracks/${id}/stats`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      if (state.stopped || state.current !== id) return;
      state.stats = { id, data: body, error: null };
    } catch (e) {
      if (state.current !== id) return;
      state.stats = { id, data: state.stats?.data || null, error: e.message };
    }
    renderStats();
  }

  function renderStats() {
    const el = $("viewStats");
    const st = state.stats;
    if (!st || (!st.data && !st.error)) { el.innerHTML = `<div class="empty">Loading stats…</div>`; return; }
    if (!st.data) { el.innerHTML = `<div class="empty">Couldn't load stats (${esc(st.error)}).</div>`; return; }
    const d = st.data;
    if (!d.teams.some((t) => t.series.length)) { el.innerHTML = `<div class="empty">Stats appear once this track has been running for an hour or two.</div>`; return; }

    // Each team keeps one look for the whole week (roster order, not rank): eight hues,
    // then the 9th and 10th teams reuse the first two hues as dashed lines.
    const looks = new Map(d.teams.map((t, i) => [t.sponsor, { color: SERIES[i % SERIES.length], dash: i >= SERIES.length }]));
    const swatch = (sp) => { const l = looks.get(sp); return `<i class="sw${l.dash ? " dash" : ""}" style="--c:${l.color}"></i>`; };
    const order = [...d.teams].sort((a, b) => (a.finalTotal ?? 1e9) - (b.finalTotal ?? 1e9));

    el.innerHTML = `
      <p class="races-note">From ${esc(etTime.format(new Date(d.from)))} to ${esc(etTime.format(new Date(d.to)))} Eastern. Team totals are saved every hour. New personal bests count for rostered pilots on the track's required quad.</p>
      <div class="stat-tiles">
        <div class="tile"><b>${d.summary.newBests}</b><span>new personal bests by rostered pilots</span></div>
      </div>

      <section class="chart-card" aria-label="Team totals over time">
        <div class="sec-head"><h2>Team totals over time</h2><span>lower is faster</span></div>
        <div class="legend">${order.map((t) => `<button type="button" data-team="${esc(t.sponsor)}">${swatch(t.sponsor)}${esc(t.sponsor)}</button>`).join("")}</div>
        <div class="chart-box" id="teamChart"></div>
        <p class="sub">Each team's line starts once all five of its pilots have a time. Hover or tap the chart to see every team's total for that hour; hover a team name to pick out its line.</p>
      </section>

      <section class="chart-card" aria-label="When pilots improved">
        <div class="sec-head"><h2>When pilots improved</h2><span>new bests and first times, Eastern time</span></div>
        <div id="heat"></div>
      </section>

      <section class="chart-card" aria-label="Biggest grinders">
        <div class="sec-head"><h2>Biggest grinders</h2><span>most new personal bests</span></div>
        <table class="stbl"><thead><tr><th class="num">#</th><th>Pilot</th><th class="num">New bests</th><th class="num">First → best</th></tr></thead><tbody>
          ${d.grinders.map((p, i) => `<tr><td class="num">${i + 1}</td><td>${esc(p.pilot)}<small>Team ${esc(p.team)}</small></td><td class="num">${p.pbs}</td><td class="num">${secs(p.first)} → ${secs(p.best)}</td></tr>`).join("")}
        </tbody></table>
      </section>`;

    drawTeamChart(d, looks, swatch);
    drawHeat(d.activity);
  }

  function drawTeamChart(d, looks, swatch) {
    const box = $("teamChart");
    if (!box) return;
    const W = Math.max(320, box.clientWidth || 800), H = W < 520 ? 260 : 340;
    const m = { l: 44, r: W < 520 ? 12 : 132, t: 10, b: 26 };
    const teams = d.teams.map((t) => ({ ...t, pts: t.series.filter((p) => p[2] >= t.size).map(([at, total]) => [Date.parse(at), total]) }));
    const all = teams.flatMap((t) => t.pts);
    if (!all.length) { box.innerHTML = `<p class="sub">No team has all five pilots posted yet.</p>`; return; }
    const times = [...new Set(d.teams.flatMap((t) => t.series.map((p) => Date.parse(p[0]))))].sort((a, b) => a - b);
    const x0 = times[0], x1 = times[times.length - 1];
    let y0 = Math.min(...all.map((p) => p[1])), y1 = Math.max(...all.map((p) => p[1]));
    const step = [5, 10, 20, 25, 50, 100].find((k) => (y1 - y0) / k <= 6) || 200;
    y0 = Math.floor(y0 / step) * step; y1 = Math.ceil(y1 / step) * step;
    const X = (t) => m.l + ((t - x0) / Math.max(1, x1 - x0)) * (W - m.l - m.r);
    const Y = (v) => m.t + ((v - y0) / Math.max(1, y1 - y0)) * (H - m.t - m.b); // lower total = higher on the chart
    const yTicks = []; for (let v = y0; v <= y1 + 1e-9; v += step) yTicks.push(v);
    const days = []; for (const t of times) { const k = etParts(new Date(t).toISOString()).day; if (!days.length || days[days.length - 1].k !== k) days.push({ k, t }); }
    const path = (pts) => pts.map((p, i) => `${i ? "L" : "M"}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join("");
    // End labels for every team, nudged apart so none overlap.
    const ends = teams.filter((t) => t.pts.length).map((t) => ({ t, y: Y(t.pts[t.pts.length - 1][1]) })).sort((a, b) => a.y - b.y);
    for (let i = 1; i < ends.length; i++) ends[i].y = Math.max(ends[i].y, ends[i - 1].y + 13);
    box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Team combined times over the week">
      ${yTicks.map((v) => `<line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${Y(v)}" y2="${Y(v)}"/><text x="${m.l - 6}" y="${Y(v) + 4}" text-anchor="end">${v}</text>`).join("")}
      ${days.filter((dd, i) => !(i === 0 && days[1] && X(days[1].t) - X(dd.t) < 48)).map((dd) => `<line class="grid" x1="${X(dd.t)}" x2="${X(dd.t)}" y1="${m.t}" y2="${H - m.b}" opacity=".5"/><text x="${X(dd.t) + 3}" y="${H - 8}">${esc(etDay.format(new Date(dd.t)).replace(/,.*$/, ""))} ${new Date(dd.t).toLocaleDateString("en-US", { timeZone: ET, day: "numeric" })}</text>`).join("")}
      ${teams.map((t) => { const l = looks.get(t.sponsor); return `<path class="tline" data-team="${esc(t.sponsor)}" d="${path(t.pts)}" stroke="${l.color}"${l.dash ? ` stroke-dasharray="6 4"` : ""}/>`; }).join("")}
      ${W >= 520 ? ends.map((e) => `<text class="lbl" data-team="${esc(e.t.sponsor)}" x="${W - m.r + 8}" y="${e.y + 4}">${esc(e.t.sponsor)}</text>`).join("") : ""}
      <line class="xhair" id="xhair" x1="0" x2="0" y1="${m.t}" y2="${H - m.b}" visibility="hidden"/>
      <rect id="hit" x="${m.l}" y="${m.t}" width="${W - m.l - m.r}" height="${H - m.t - m.b}" fill="transparent"/>
    </svg><div class="tip" id="tip" hidden></div>`;

    const svg = box.querySelector("svg"), hit = box.querySelector("#hit"), xh = box.querySelector("#xhair"), tip = box.querySelector("#tip");
    const lines = [...box.querySelectorAll(".tline"), ...box.querySelectorAll(".lbl")];
    const keys = [...$("viewStats").querySelectorAll(".legend button")];
    const highlight = (team) => {
      lines.forEach((l) => { l.classList.toggle("hot", l.dataset.team === team); l.classList.toggle("dim", !!team && l.dataset.team !== team); });
      keys.forEach((k) => k.classList.toggle("dim", !!team && k.dataset.team !== team));
    };
    let pinned = null;
    keys.forEach((k) => {
      k.addEventListener("mouseenter", () => highlight(k.dataset.team));
      k.addEventListener("mouseleave", () => highlight(pinned));
      k.addEventListener("click", () => { pinned = pinned === k.dataset.team ? null : k.dataset.team; highlight(pinned); });
    });
    const move = (clientX, clientY) => {
      const r = svg.getBoundingClientRect();
      const px = ((clientX - r.left) / r.width) * W;
      const t = x0 + ((px - m.l) / (W - m.l - m.r)) * (x1 - x0);
      const at = times.reduce((best, v) => (Math.abs(v - t) < Math.abs(best - t) ? v : best), times[0]);
      xh.setAttribute("x1", X(at)); xh.setAttribute("x2", X(at)); xh.setAttribute("visibility", "visible");
      const rows = d.teams.map((tm) => { const p = tm.series.find((q) => Date.parse(q[0]) === at); return p && { s: tm.sponsor, total: p[1], posted: p[2], size: tm.size }; }).filter(Boolean).sort((a, b) => a.total - b.total);
      const py = ((clientY - r.top) / r.height) * H;
      const near = pinned ? rows.find((r2) => r2.s === pinned) : rows.filter((r2) => r2.posted >= r2.size).reduce((b, r2) => (!b || Math.abs(Y(r2.total) - py) < Math.abs(Y(b.total) - py) ? r2 : b), null);
      highlight(near?.s ?? pinned);
      tip.innerHTML = `<b>${esc(etTime.format(new Date(at)))}</b>` + rows.map((r2) => `<div class="${r2.s === near?.s ? "hot" : ""}"><span>${swatch(r2.s)}${esc(r2.s)}</span><span>${r2.posted < r2.size ? `${r2.posted}/${r2.size} posted` : secs(r2.total)}</span></div>`).join("");
      tip.hidden = false;
      // Sit beside the crosshair on whichever side has room, always inside the chart.
      const bx = box.getBoundingClientRect();
      const px2 = clientX - bx.left, wide = tip.offsetWidth;
      const left = px2 + 14 + wide <= bx.width ? px2 + 14 : px2 - wide - 14;
      tip.style.left = `${Math.max(0, Math.min(left, bx.width - wide))}px`;
      tip.style.top = `${Math.max(0, Math.min(clientY - bx.top - 20, bx.height - tip.offsetHeight))}px`;
    };
    hit.addEventListener("mousemove", (e) => move(e.clientX, e.clientY));
    hit.addEventListener("touchstart", (e) => { const tt = e.touches[0]; move(tt.clientX, tt.clientY); }, { passive: true });
    hit.addEventListener("mouseleave", () => { tip.hidden = true; xh.setAttribute("visibility", "hidden"); highlight(pinned); });
  }

  function drawHeat(activity) {
    const el = $("heat");
    if (!el) return;
    const counts = new Map();
    const days = [];
    for (const [at] of activity) {
      const { day, hour } = etParts(at);
      if (!days.includes(day)) days.push(day);
      counts.set(`${day}|${hour}`, (counts.get(`${day}|${hour}`) || 0) + 1);
    }
    days.sort();
    if (!days.length) { el.innerHTML = `<p class="sub">No new bests yet.</p>`; return; }
    const max = Math.max(...counts.values());
    const steps = ["var(--h1)", "var(--h2)", "var(--h3)", "var(--h4)", "var(--h5)", "var(--h6)"];
    const color = (n) => (n ? steps[Math.min(steps.length - 1, Math.ceil((n / max) * steps.length) - 1)] : "");
    const hourLbl = (h) => (h === 0 ? "12a" : h < 12 ? `${h}a` : h === 12 ? "12p" : `${h - 12}p`);
    const dayLbl = (k) => etDay.format(new Date(k + "T12:00:00Z")).replace(/,.*$/, "") + " " + +k.slice(8);
    el.innerHTML = `<div class="heat" role="table" aria-label="New bests by day and hour">
        <span></span>${Array.from({ length: 24 }, (_, h) => `<span class="hd">${h % 3 === 0 ? hourLbl(h) : ""}</span>`).join("")}
        ${days.map((k) => `<span class="rd">${esc(dayLbl(k))}</span>${Array.from({ length: 24 }, (_, h) => { const n = counts.get(`${k}|${h}`) || 0; return `<span class="c" data-n="${n}" style="${n ? `background:${color(n)}` : ""}" title="${esc(dayLbl(k))}, ${hourLbl(h)}: ${n} new best${n === 1 ? "" : "s"}"></span>`; }).join("")}`).join("")}
      </div>
      <div class="heat-key">Fewer ${steps.map((c2) => `<i style="background:${c2}"></i>`).join("")} More · busiest hour: ${max} new bests</div>`;
  }
  let resizeTimer;
  window.addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (state.view === "stats" && state.stats?.data && !$("viewStats").hidden) renderStats(); }, 200); });

  // ---------- live updates (WebSocket to the track's RaceRoom) ----------
  const live = { id: null, ws: null, onUpdate: null, retry: 1000, timer: null, ping: null, poll: null };
  function liveStart(id, onUpdate) {
    if (live.id === id && live.onUpdate === onUpdate && (live.ws || live.poll)) return;
    liveStop();
    live.id = id;
    live.onUpdate = onUpdate;
    // No live link in the test preview or very old browsers: check every 30 s instead.
    if (window.STANDINGS_FETCH || !("WebSocket" in window)) { live.poll = setInterval(() => live.onUpdate(), 30_000); return; }
    connect();
    function connect() {
      if (live.id !== id) return;
      let ws;
      try { ws = new WebSocket(location.origin.replace(/^http/, "ws") + `/api/tracks/${id}/races/live`); } catch (e) { return retryLater(); }
      live.ws = ws;
      ws.onopen = () => { live.retry = 1000; clearInterval(live.poll); live.poll = null; live.ping = setInterval(() => { try { ws.send("ping"); } catch (e) {} }, 30_000); };
      ws.onmessage = (ev) => { try { if (JSON.parse(ev.data).type === "update") live.onUpdate(); } catch (e) {} };
      ws.onclose = () => { clearInterval(live.ping); if (live.ws === ws) { live.ws = null; retryLater(); } };
      ws.onerror = () => {};
    }
    function retryLater() {
      if (live.id !== id) return;
      if (!live.poll) live.poll = setInterval(() => live.onUpdate(), 30_000); // keep data fresh while reconnecting
      live.timer = setTimeout(connect, live.retry);
      live.retry = Math.min(live.retry * 2, 30_000);
    }
  }
  function liveStop() {
    live.id = null;
    clearTimeout(live.timer); clearInterval(live.ping); clearInterval(live.poll);
    live.poll = null;
    if (live.ws) { const ws = live.ws; live.ws = null; try { ws.close(); } catch (e) {} }
  }

  // ---------- race director page (#admin-<track>) ----------
  // Sign-in pass from the Worker (not the password), kept in localStorage so every tab on
  // this browser is signed in until it expires (24 hours) or someone signs out.
  const PASS_KEY = "webleedRaceDirector";
  const adm = { id: null, pass: null, passMem: null, data: null, satBefore: {}, saving: 0, error: null, savedAt: null };
  function getPass() {
    let p;
    // Memory copy only when the browser blocks storage; otherwise storage is the truth,
    // so signing out in another tab takes effect here too.
    try { p = JSON.parse(localStorage.getItem(PASS_KEY) || "null"); } catch (e) { p = adm.passMem; }
    if (!p || !p.session || Date.parse(p.expiresAt) <= Date.now()) { if (p) setPass(null); return null; }
    return p;
  }
  function setPass(p) {
    adm.passMem = p;
    try { p ? localStorage.setItem(PASS_KEY, JSON.stringify(p)) : localStorage.removeItem(PASS_KEY); } catch (e) {}
  }
  const adminApi = (path, init = {}) =>
    api("/admin" + path, { ...init, headers: { "content-type": "application/json", "x-admin-session": adm.pass?.session || "", ...(init.headers || {}) } });
  const signedOut = (message) => { setPass(null); adm.pass = null; liveStop(); renderGate(message); };
  const adminIdFromHash = () => +((location.hash.match(/^#admin-(\d+)$/) || [])[1] || 0);
  const isAdmin = () => state.mode === "admin";
  const timeFmt2 = new Intl.DateTimeFormat([], { hour: "numeric", minute: "2-digit", second: "2-digit" });

  // Same rules as the server: seconds (45.123 or 1:05.432), DNF, or blank to clear.
  function parseTime(v) {
    const s2 = String(v ?? "").trim().toLowerCase();
    if (!s2) return null;
    if (s2 === "dnf") return "dnf";
    const m = s2.match(/^(?:(\d{1,2}):)?(\d{1,4}(?:\.\d{1,3})?)$/);
    if (!m) return undefined;
    const secs = (m[1] ? +m[1] * 60 : 0) + parseFloat(m[2]);
    return secs > 0 && secs < 3600 ? Math.round(secs * 1000) / 1000 : undefined;
  }

  function enterAdmin(id) {
    state.mode = "admin";
    adm.id = id; adm.data = null; adm.error = null;
    liveStop();
    clearTimeout(state.pollTimer);
    document.body.classList.add("admin-mode");
    document.querySelector(".wrap").classList.add("wide");
    $("viewAdmin").hidden = false;
    const t = state.tracks.find((x) => x.id === id);
    $("title").textContent = `Race Director · ${t ? t.name : "Track " + id}`;
    document.title = `Race Director · ${t ? t.name : "Track " + id}`;
    $("sub").textContent = "Pick who sits out for each team, then type each pilot's race time. Every change saves when you leave the box and shows on the Races tab right away.";
    adm.pass = getPass();
    if (adm.pass) loadAdmin(); else renderGate();
  }

  function exitAdmin() {
    state.mode = null;
    liveStop();
    document.body.classList.remove("admin-mode");
    $("viewAdmin").hidden = true;
    $("viewAdmin").innerHTML = "";
  }

  function renderGate(message) {
    $("viewAdmin").innerHTML = `
      <form class="gate" id="gateForm">
        <label for="adminPw">Race director password</label>
        <div class="gate-row"><input id="adminPw" type="password" autocomplete="current-password" required><button type="submit">Open</button></div>
        ${message ? `<p class="gate-msg" role="alert">${esc(message)}</p>` : ""}
        <a href="#track-${adm.id}">Back to the standings</a>
      </form>`;
    setTimeout(() => $("adminPw")?.focus(), 0);
  }

  async function loadAdmin() {
    const id = adm.id;
    if (!adm.data) $("viewAdmin").innerHTML = `<div class="empty">Opening race day…</div>`;
    try {
      const res = await adminApi(`/tracks/${id}/races`);
      if (res.status === 403) return signedOut("Your sign-in has expired. Please enter the password again.");
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      if (!isAdmin() || adm.id !== id) return;
      const first = !adm.data;
      adm.data = body;
      adm.satBefore = body.satBefore || {};
      if (first) { renderAdmin(); liveStart(id, loadAdmin); } else syncAdmin();
    } catch (e) {
      if (!adm.data) $("viewAdmin").innerHTML = `<div class="empty">Couldn't open race day (${esc(e.message)}). <a href="#admin-${id}" onclick="location.reload()">Try again</a></div>`;
    }
  }

  const draftSorted = (list) => [...list].sort((a, b) => a.draft - b.draft);
  const lineupText = (t) => (t.lineup ? Object.entries(t.lineup).map(([tier, p]) => `<span>T${tier} ${esc(p)}</span>`).join("") : '<span class="tbd">Pick who sits to fill the tiers</span>');

  function renderAdmin() {
    const d = adm.data;
    const teams = draftSorted(d.teams);
    const sat = adm.satBefore;
    const sitCards = teams.map((t, i) => {
      const options = t.smashOrder.map((p, n) => {
        const weeks = sat[t.sponsor]?.[p];
        return `<option value="${esc(p)}"${t.sitting === p ? " selected" : ""}>${n + 1}. ${esc(p)}${weeks ? ` (sat Wk ${weeks.join(", ")})` : ""}</option>`;
      }).join("");
      return `<div class="sit-card">
        <label for="sit-${i}"><b>Team ${esc(t.sponsor)}</b></label>
        <select id="sit-${i}" data-kind="sit" data-sponsor="${esc(t.sponsor)}"><option value="">Pick who sits…</option>${options}</select>
        <div class="lineup" data-lineup="${esc(t.sponsor)}">${lineupText(t)}</div>
      </div>`;
    }).join("");
    const picked = d.teams.filter((t) => t.sitting).length;

    const tierTables = d.tierResults.map((t) => {
      const rows = draftSorted(t.entries).map((e) => `<tr>
        <th class="team-col" scope="row"><div class="ocell"><span class="oname"><b>Team ${esc(e.sponsor)}</b><small data-pilot="${t.tier}|${esc(e.sponsor)}">${pilotLabel(e.pilot)}</small></span></div></th>
        ${e.times.map((tm, ri) => `<td class="tcell${ri === 0 ? " wk-start" : ""}">
          <input class="tin" data-kind="time" data-tier="${t.tier}" data-race="${ri + 1}" data-sponsor="${esc(e.sponsor)}" value="${fmtTime(tm)}" inputmode="decimal" autocomplete="off" spellcheck="false" placeholder="–" aria-label="Team ${esc(e.sponsor)}, tier ${t.tier}, race ${ri + 1} time">
          <small class="tres" data-res="${t.tier}|${ri + 1}|${esc(e.sponsor)}">${resLabel(e, ri)}</small>
        </td>`).join("")}
        <td class="num tot" data-tot="${t.tier}|${esc(e.sponsor)}">${pts(e.total)}</td>
      </tr>`).join("");
      return fold(`adm-tier-${t.tier}`, `Tier ${t.tier}`, tierMeta(t, d), `
        <div class="table-wrap"><table class="overall grid admin-grid">
          <thead><tr><th class="team-col" scope="col">Team · Pilot</th>${Array.from({ length: d.racesPerTier }, (_, i) => `<th class="num${i === 0 ? " wk-start" : ""}" scope="col">R${i + 1}</th>`).join("")}<th class="num tot" scope="col">Points</th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div>`);
    }).join("");

    $("viewAdmin").innerHTML = `
      <div class="admin-bar">
        <span class="save-state" id="saveState" data-state="ok">All changes saved</span>
        <span class="admin-actions"><span class="signed-in">Signed in until ${esc(dayFmt.format(new Date(adm.pass.expiresAt)))}</span><a href="#track-${adm.id}">Back to Races</a><button type="button" id="signOut">Sign out</button></span>
      </div>
      <p class="races-note">Times are in seconds (45.123 or 1:05.432). Type <b>DNF</b> for a pilot who didn't finish, or clear the box to remove a time. The fastest time in each race finishes 1st.</p>
      ${fold("adm-sit", "Who sits out", `${picked} of ${d.teams.length} picked`, `<p class="sit-hint">Pilots are listed in their team's Smash order for this track. The four who race fill Tiers 1–4 in that order.</p><div class="sit-grid">${sitCards}</div>`)}
      ${fold("adm-summary", "Team race points", leaderOf(d.teams), `<div id="admSummary">${raceSummaryTable(d)}</div>`)}
      ${tierTables}`;
    renderSaveState();
  }

  function resLabel(e, ri) {
    const tm = e.times[ri];
    if (tm == null) return "";
    if (tm === "dnf") return "DNF · 0";
    return `${ordinal(e.positions[ri])} · ${e.points[ri]}`;
  }

  // Refresh everything derived from saved data, without touching a box someone is typing in.
  function syncAdmin() {
    const d = adm.data;
    const root = $("viewAdmin");
    if (!root.querySelector(".admin-bar")) return renderAdmin();
    const focused = document.activeElement;
    for (const t of d.teams) {
      const sel = root.querySelector(`select[data-kind="sit"][data-sponsor="${CSS.escape(t.sponsor)}"]`);
      if (sel && sel !== focused && !sel.dataset.dirty) sel.value = t.sitting || "";
      const ln = root.querySelector(`[data-lineup="${CSS.escape(t.sponsor)}"]`);
      if (ln) ln.innerHTML = lineupText(t);
    }
    for (const t of d.tierResults) {
      for (const e of t.entries) {
        const key = `${t.tier}|${e.sponsor}`;
        const pl = root.querySelector(`[data-pilot="${CSS.escape(key)}"]`);
        if (pl) pl.innerHTML = pilotLabel(e.pilot);
        const tot = root.querySelector(`[data-tot="${CSS.escape(key)}"]`);
        if (tot) tot.innerHTML = pts(e.total);
        e.times.forEach((tm, ri) => {
          const inp = root.querySelector(`input[data-tier="${t.tier}"][data-race="${ri + 1}"][data-sponsor="${CSS.escape(e.sponsor)}"]`);
          if (inp && inp !== focused && !inp.dataset.dirty) { inp.value = fmtTime(tm); inp.classList.remove("bad"); }
          const res = root.querySelector(`[data-res="${CSS.escape(`${t.tier}|${ri + 1}|${e.sponsor}`)}"]`);
          if (res) res.textContent = resLabel(e, ri);
        });
      }
      const meta = root.querySelector(`[data-meta="adm-tier-${t.tier}"]`);
      if (meta) meta.innerHTML = tierMeta(t, d);
    }
    const sm = $("admSummary");
    if (sm) sm.innerHTML = raceSummaryTable(d);
    const m1 = root.querySelector('[data-meta="adm-summary"]');
    if (m1) m1.innerHTML = leaderOf(d.teams);
    const m2 = root.querySelector('[data-meta="adm-sit"]');
    if (m2) m2.textContent = `${d.teams.filter((t) => t.sitting).length} of ${d.teams.length} picked`;
  }

  function renderSaveState() {
    const el = $("saveState");
    if (!el) return;
    if (adm.saving) { el.dataset.state = "busy"; el.textContent = "Saving…"; }
    else if (adm.error) { el.dataset.state = "error"; el.textContent = adm.error; }
    else { el.dataset.state = "ok"; el.textContent = adm.savedAt ? `All changes saved · ${timeFmt2.format(adm.savedAt)}` : "All changes saved"; }
  }

  async function saveEdit(path, body, el) {
    adm.saving++;
    adm.error = null;
    renderSaveState();
    el.dataset.dirty = "1";
    try {
      const res = await adminApi(path, { method: "PATCH", body: JSON.stringify(body) });
      const out = await res.json().catch(() => ({}));
      if (res.status === 403) { adm.saving--; return signedOut("Your sign-in has expired, so your last change wasn't saved. Please enter the password again."); }
      if (!res.ok) throw new Error(out.error || `HTTP ${res.status}`);
      delete el.dataset.dirty;
      el.classList.remove("bad");
      el.removeAttribute("title");
      if (isAdmin()) { adm.data = { ...out, satBefore: adm.satBefore }; adm.savedAt = new Date(); syncAdmin(); }
    } catch (e) {
      el.classList.add("bad");
      el.title = e.message;
      adm.error = `Couldn't save: ${e.message}. Change the box again to retry.`;
    } finally {
      adm.saving = Math.max(0, adm.saving - 1);
      renderSaveState();
    }
  }

  $("viewAdmin").addEventListener("change", (e) => {
    const el = e.target;
    if (!isAdmin() || !el.dataset) return;
    if (el.dataset.kind === "sit") {
      saveEdit(`/tracks/${adm.id}/races/lineup`, { sitting: { [el.dataset.sponsor]: el.value || null } }, el);
    } else if (el.dataset.kind === "time") {
      const t = parseTime(el.value);
      if (t === undefined) {
        el.classList.add("bad");
        el.dataset.dirty = "1";
        el.title = "Use seconds like 45.123 or 1:05.432, or DNF";
        adm.error = `"${el.value}" isn't a race time. Use seconds like 45.123, or DNF.`;
        return renderSaveState();
      }
      el.value = fmtTime(t);
      saveEdit(`/tracks/${adm.id}/races/tiers/${el.dataset.tier}`, { results: { [el.dataset.race]: { [el.dataset.sponsor]: t === null ? null : t === "dnf" ? "DNF" : String(t) } } }, el);
    }
  });
  $("viewAdmin").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.dataset?.kind === "time") e.target.blur();
  });
  $("viewAdmin").addEventListener("submit", async (e) => {
    if (e.target.id !== "gateForm") return;
    e.preventDefault();
    const pw = $("adminPw").value;
    try {
      const res = await api("/admin/login", { method: "POST", headers: { "x-admin-password": pw } });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.session) return renderGate(res.status === 403 ? "That password didn't work." : `Couldn't check the password (HTTP ${res.status}).`);
      adm.pass = { session: body.session, expiresAt: body.expiresAt };
      setPass(adm.pass);
      loadAdmin();
    } catch (err) {
      renderGate(`Couldn't check the password (${err.message}).`);
    }
  });
  $("viewAdmin").addEventListener("click", (e) => {
    if (e.target.id !== "signOut") return;
    signedOut("Signed out.");
  });
  // Signing in or out in one tab does the same in this browser's other tabs.
  window.addEventListener("storage", (e) => {
    if (e.key !== PASS_KEY || !isAdmin()) return;
    const p = getPass();
    if (!p && adm.pass) { adm.pass = null; liveStop(); renderGate("Signed out in another tab."); }
    else if (p && !adm.pass) { adm.pass = p; adm.data = null; loadAdmin(); }
  });
  window.addEventListener("beforeunload", (e) => { if (isAdmin() && adm.saving) { e.preventDefault(); e.returnValue = ""; } });

  // Which race sections are open. Team race points starts open, tiers closed;
  // a viewer's choice is kept when the data refreshes.
  const foldState = { summary: true, "adm-sit": true, "adm-summary": true };
  const isOpen = (key) => foldState[key] ?? false;
  for (const id of ["viewRaces", "viewAdmin"]) $(id).addEventListener("toggle", (e) => {
    const k = e.target?.dataset?.fold;
    if (k) foldState[k] = e.target.open;
  }, true);

  // ---------- loading ----------
  async function load() {
    const id = state.current;
    clearTimeout(state.pollTimer);
    state.loading = true;
    renderStatus();
    renderStandings();
    try {
      const res = await api(id === OVERALL ? "/overall" : `/tracks/${id}`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      if (state.stopped || id !== state.current) return; // switched tabs meanwhile
      state.data = body;
      state.error = null;
      const t = currentTrack();
      if (t && body.track && t.status !== body.track.status) { Object.assign(t, body.track); renderTabs(); }
    } catch (e) {
      if (id !== state.current) return;
      state.error = e.message;
    } finally {
      if (id === state.current) {
        state.loading = false;
        renderStatus();
        renderStandings();
        schedulePoll();
        if (state.view === "races" && !isOverall()) loadRaces();
        if (state.view === "stats" && !isOverall() && state.data?.track?.status !== "locked") loadStats(true);
      }
    }
  }

  function schedulePoll() {
    clearTimeout(state.pollTimer);
    const d = state.data;
    let wait = null;
    if (state.error) wait = RETRY_MS;
    else if (isOverall()) wait = 10 * 60_000;
    else if (d && (d.track.status === "live" || d.track.status === "locking")) {
      const target = d.nextUpdateAt ? Date.parse(d.nextUpdateAt) + POLL_AFTER_HOUR_MS : now() + RETRY_MS;
      wait = Math.max(30_000, target - now());
    }
    if (wait != null) state.pollTimer = setTimeout(load, wait);
  }

  document.addEventListener("visibilitychange", () => {
    if (state.stopped || document.visibilityState !== "visible" || state.loading || !state.data) return;
    const d = state.data;
    if (d.track && d.track.status !== "locked" && d.nextUpdateAt && now() > Date.parse(d.nextUpdateAt) + POLL_AFTER_HOUR_MS) load();
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
    if (adminIdFromHash()) { state.error = null; state.current = adminIdFromHash(); return enterAdmin(adminIdFromHash()); }
    if (location.hash === "#overall") { state.error = null; return selectTrack(OVERALL); }
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
    if (adminIdFromHash()) return enterAdmin(adminIdFromHash());
    if (isAdmin()) {
      exitAdmin();
      state.view = "races";
      const back = +((location.hash.match(/^#track-(\d+)$/) || [])[1] || adm.id);
      return selectTrack(back, true);
    }
    if (location.hash === "#overall") return selectTrack(OVERALL);
    const id = +((location.hash.match(/^#track-(\d+)$/) || [])[1] || 0);
    const t = state.tracks.find((x) => x.id === id);
    if (t && t.status !== "upcoming") selectTrack(id);
  });

  start();
})();

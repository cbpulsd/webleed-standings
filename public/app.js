// Standings page. Reads only from /api; the backend does all fetching and locking.
(() => {
  const api = (path, init = {}) => (window.STANDINGS_FETCH || fetch)("/api" + path, { cache: "no-store", ...init });
  const now = () => (window.STANDINGS_NOW ? window.STANDINGS_NOW() : Date.now());
  const NO_TIME = 999.99;
  const POLL_AFTER_HOUR_MS = 60_000; // check for new data a minute after each scheduled refresh
  const RETRY_MS = 5 * 60_000;

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  // Team names and colors the league uses (keyed by sponsor; the data keeps sponsor names).
  // Each color is a --tm-* token so lines stay readable in light and dark mode.
  const TEAM_LOOK = {
    "EMAX USA": { name: "BaguetteMax", key: "emax" },
    MEPSKING: { name: "Five Crowns", key: "meps" },
    Happymodel: { name: "Loch & Load", key: "happy" },
    "Fractal Engineering": { name: "What the Frac-tal?", key: "fractal" },
    BETAFPV: { name: "SuperD Troopers", key: "beta" },
    DamagD: { name: "Emotional DamageD", key: "damagd" },
    NewBeeDrone: { name: "Wasted Ram", key: "newbee" },
    WREKD: { name: "ÉWREKD", key: "wrekd" },
    Velocidrone: { name: "Two Weeks", key: "velo" },
    RadioMaster: { name: "Zeeb team 5", key: "radio" },
  };
  const tname = (sp) => TEAM_LOOK[sp]?.name || sp;
  const tcolor = (sp) => (TEAM_LOOK[sp] ? `var(--tm-${TEAM_LOOK[sp].key})` : "var(--muted)");
  const tdot = (sp) => `<i class="tdot" style="background:${tcolor(sp)}" aria-hidden="true"></i>`;
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
  const PILOTS = "pilots";
  const isOverall = () => state.current === OVERALL;
  const isPilots = () => state.current === PILOTS;
  const isSeasonTab = () => isOverall() || isPilots();

  function renderTabs() {
    const el = $("trackTabs");
    el.style.setProperty("--n", state.tracks.length + 2);
    el.innerHTML =
      `<button class="track-tab overall-tab" role="tab" type="button" data-id="${OVERALL}" data-status="overall"
        aria-selected="${isOverall()}"><span>Overall</span></button>` +
      `<button class="track-tab overall-tab" role="tab" type="button" data-id="${PILOTS}" data-status="overall"
        aria-selected="${isPilots()}"><span>Pilots</span></button>` +
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
    if (b && !b.disabled) { if (b.dataset.id === PILOTS) pv.page = null; selectTrack(b.dataset.id === OVERALL || b.dataset.id === PILOTS ? b.dataset.id : +b.dataset.id, b.dataset.id === PILOTS); }
  });
  $("trackTabs").addEventListener("keydown", (e) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const open = [{ id: OVERALL }, { id: PILOTS }, ...state.tracks.filter((t) => t.status !== "upcoming")];
    const i = open.findIndex((t) => t.id === state.current);
    const next = open[(i + (e.key === "ArrowRight" ? 1 : -1) + open.length) % open.length];
    if (next) { selectTrack(next.id); document.querySelector(`.track-tab[data-id="${next.id}"]`)?.focus(); }
  });

  function selectTrack(id, force = false) {
    if (id === state.current && state.data && !force) return;
    if (id === PILOTS && state.current === PILOTS && state.data) { setPilotsHash(); renderTabs(); renderHeader(); return renderPilotStats(); }
    state.current = id;
    state.data = null;
    state.races = null;
    state.stats = null;
    try { if (id === PILOTS) setPilotsHash(); else history.replaceState(null, "", id === OVERALL ? "#overall" : "#track-" + id); } catch (e) {}
    renderTabs();
    renderHeader();
    applyLayout();
    load();
  }

  // The Overall tab shows the season table instead of the Teams/Pilots views.
  function applyLayout() {
    const o = isSeasonTab();
    document.querySelector(".views").hidden = o;
    $("viewOverall").hidden = !isOverall();
    $("viewPilotStats").hidden = !isPilots();
    document.querySelector(".wrap").classList.toggle("wide", o);
    if (o) { $("viewTeams").hidden = true; $("viewPilots").hidden = true; $("viewRaces").hidden = true; $("viewStats").hidden = true; $("viewRaceStats").hidden = true; liveStop(); }
    else showView(state.view);
  }

  // ---------- header + status ----------
  function currentTrack() { return state.tracks.find((t) => t.id === state.current) || null; }

  function renderHeader() {
    if (isPilots()) {
      const p = pv.page && state.data?.pilots?.find((x) => x.name === pv.page);
      $("title").textContent = p ? p.name : "Pilot Stats";
      document.title = p ? `${p.name} · Season 5 Pilot Stats` : "Season 5 Pilot Stats";
      $("sub").textContent = p
        ? `${tname(p.team)}${p.captain ? " captain" : ""}. Every week's leaderboard time, race heats and bonus round, plus the season so far.`
        : "Every league pilot's stats from the locked weeks: race heats, the bonus round, and each week's leaderboard. Pick a pilot for their own page.";
      return;
    }
    if (isOverall()) {
      $("title").textContent = "Overall Standings";
      document.title = "Season 5 Overall Standings";
      $("sub").textContent = "Season points for each team. Each week, Smash gives 10 points for 1st down to 1 for 10th, Races give 20 for 1st down to 2 for 10th, and the bonus round adds 3, 2, 1 or 0 to the top four's Race points. A week's Smash points come in when its track locks, and its Race points once every race is in.";
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
    if (d && isPilots()) {
      const raced = d.weeks.filter((w) => w.races);
      return raced.length || d.weeks.length
        ? setStatus("final", `Season so far: ${d.weeks.length} locked week${d.weeks.length === 1 ? "" : "s"}, ${raced.length} race day${raced.length === 1 ? "" : "s"}.`, [`Races through <b>${esc(raced.at(-1)?.name || "–")}</b>`])
        : setStatus("idle", "No locked weeks yet. Pilot stats start once the first track locks.");
    }
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
        <th class="team-col" scope="row"><div class="ocell">${t.position != null ? `<span class="opos">${t.position}</span>` : ""}<span class="oname"><b>${tdot(t.sponsor)}${esc(tname(t.sponsor))}</b><small>${esc(t.sponsor)} · Capt ${esc(t.captain)}</small></span></div></th>
        ${d.weeks.map((w) => { const c = t.weeks[w.id] || {}; return `<td class="num wk-start">${pts(c.smash)}</td><td class="num"${c.raceBonus ? ` title="${c.race - c.raceBonus} for race place + ${c.raceBonus} bonus round"` : ""}>${pts(c.race)}${c.raceBonus ? `<small class="bonus-note">+${c.raceBonus}</small>` : ""}</td>`; }).join("")}
        <td class="num tot">${pts(t.total)}</td>
      </tr>`)
      .join("");
    $("overallTable").innerHTML = `<thead>
        <tr><th class="team-col" rowspan="2" scope="col">Team</th>${head1}<th class="tot" rowspan="2" scope="col">Total</th></tr>
        <tr>${head2}</tr>
      </thead><tbody>${body}</tbody>`;
  }

  // ---------- pilots tab ----------
  // One stats page for the season (Spotlight, Race, Smash; season or one week; pilots or teams)
  // and one page per pilot. Links look like #pilots, #pilots/race/2, #pilot/<name>.
  const pv = { page: null, tab: "spotlight", scope: "season", mode: "pilots", q: "", sort: {}, stat: null, statAll: false, bat: null, batAll: false };
  const SHOW_MANY = 10; // Spotlight lists show the top 10, opening to everyone (stats) or BAT_MAX (battles)
  const BAT_MAX = 50; // Battles & Records lists open to at most 50 rows
  const PV_TABS = { spotlight: "Spotlight", race: "Race stats", smash: "Smash stats" };
  const MIN_WEEKS = 1; // raced weeks a pilot needs to be ranked on season rates and averages

  function readPilotsHash() {
    const h = location.hash;
    let m = h.match(/^#pilot\/(.+)$/);
    if (m) { pv.page = decodeURIComponent(m[1]); return true; }
    m = h.match(/^#pilots(?:\/(spotlight|race|smash))?(?:\/(\d+))?$/);
    if (!m) return false;
    pv.page = null;
    if (m[1]) pv.tab = m[1];
    pv.scope = m[2] ? +m[2] : "season";
    return true;
  }
  function setPilotsHash() {
    const h = pv.page ? `#pilot/${encodeURIComponent(pv.page)}` : `#pilots${pv.tab !== "spotlight" || pv.scope !== "season" ? "/" + pv.tab : ""}${pv.scope !== "season" ? "/" + pv.scope : ""}`;
    if (location.hash !== h) { try { history.replaceState(null, "", h); } catch (e) {} }
  }
  const pilotLink = (name, team, extra = "") => `<a class="plink" href="#pilot/${encodeURIComponent(name)}">${tdot(team)}<span>${esc(name)}</span></a>${extra}`;
  const n2 = (v, d = 2) => (v == null ? "–" : (+v).toFixed(d));
  const num = (v, d = 0) => (v == null ? "–" : (+v).toFixed(d));
  const signed = (v, d = 1) => (v == null ? "–" : v > 0 ? `<span class="up">▲${(+v).toFixed(d)}</span>` : v < 0 ? `<span class="down">▼${(-v).toFixed(d)}</span>` : "0");
  const pct = (v) => (v == null ? "–" : `${(+v).toFixed(1)}%`);
  const scopeName = (d) => (pv.scope === "season" ? "Season so far" : d.weeks.find((w) => w.id === pv.scope)?.name || "");

  // A pilot's numbers for the chosen scope, with the same keys for the season and a single week.
  function raceRow(p, d) {
    if (pv.scope === "season") {
      const s = p.season;
      if (!s.weeksRaced) return null;
      return { p, weeks: s.weeksRaced, pts: s.points, ppw: s.ptsPerWeek, wins: s.wins, winPct: s.winPct, podPct: s.podiumPct, fin: s.avgFinish, bhr: s.avgBestHeatRank, spread: s.spreadPct, bonus: s.bonusPoints, streak: s.streak, ok: s.weeksRaced >= MIN_WEEKS };
    }
    const w = p.weeks[pv.scope], r = w?.race;
    if (!r || r.sat) return null;
    const ran = r.heats.filter((h) => h.pos).length;
    return { p, tier: r.tier, pts: r.points, place: r.place, wins: r.wins, winPct: ran ? (r.wins / ran) * 100 : null, podPct: ran ? (r.podiums / ran) * 100 : null, fin: r.avgFinish, bhr: r.bestHeatRank, spread: r.spreadPct, bonus: w.bonus?.points ?? null, ok: true };
  }
  function smashRow(p, d) {
    if (pv.scope === "season") {
      const s = p.season;
      if (!s.smashWeeks) return null;
      return { p, avg: s.avgRank, best: s.bestRank, off: s.avgPctOff, total: s.smashTotal, pbs: s.pbs, top10: s.top10, vsDraft: s.vsDraft, vsTryout: s.vsTryout, ok: true };
    }
    const sm = p.weeks[pv.scope]?.smash;
    if (!sm || sm.rank == null) return null;
    return { p, time: sm.time, rank: sm.rank, off: sm.pctOff, pbs: sm.pbs, teamTier: sm.teamTier, vsDraft: p.draftPos != null ? p.draftPos - sm.rank : null, vsTryout: p.tryoutPlace != null ? p.tryoutPlace - sm.rank : null, ok: true };
  }

  // Team rows: the team's pilots added up (points, wins, new bests) or averaged (places, spread).
  function teamRows(rows, kind) {
    const by = new Map();
    for (const r of rows) { if (!by.has(r.p.team)) by.set(r.p.team, []); by.get(r.p.team).push(r); }
    const avg = (list, k) => { const v = list.map((r) => r[k]).filter((x) => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
    const sum = (list, k) => list.reduce((a, r) => a + (r[k] || 0), 0);
    return [...by].map(([team, list]) => kind === "race"
      ? { team, pilots: list.length, pts: sum(list, "pts"), wins: sum(list, "wins"), fin: avg(list, "fin"), bhr: avg(list, "bhr"), spread: avg(list, "spread"), bonus: sum(list, "bonus"), ok: true }
      : { team, pilots: list.length, avg: avg(list, pv.scope === "season" ? "avg" : "rank"), best: (() => { const v = list.map((r) => (pv.scope === "season" ? r.best : r.rank)).filter((x) => x != null); return v.length ? Math.min(...v) : null; })(), pbs: sum(list, "pbs"), total: list.every((r) => (pv.scope === "season" ? r.total : r.time) != null) ? sum(list, pv.scope === "season" ? "total" : "time") : null, vsDraft: avg(list, "vsDraft"), ok: true });
  }

  // Columns: [key, label, format, lower-is-better, title]
  // Columns: [key, label, format, lower-is-better, tooltip]
  function columns(kind) {
    const wk = pv.scope !== "season";
    const dec = (d) => (v) => n2(v, d);
    const time = (v) => (v == null ? "–" : fmt(v));
    const off = (v) => (v == null ? "–" : `+${(+v).toFixed(2)}%`);
    if (pv.mode === "teams") return kind === "race"
      ? [["pts", "Pts", num, false, "Tier points from all the team's racers"], ["wins", "Heat wins", num, false, "Tier heats won by the team's racers"], ["fin", "Avg finish", dec(2), true, "Average heat finishing place of the team's racers"], ["bhr", "Best heat #", dec(1), true, "Average rank of each racer's fastest heat vs all 40 racers"], ["spread", "Spread %", dec(2), true, "Average spread of heat times, % of average (lower = steadier)"], ["bonus", "Bonus pts", num, false, "Bonus-round heat points"]]
      : [["avg", "Avg LB #", dec(1), true, "Average league leaderboard place of the team's pilots"], ["best", "Best LB #", num, true, "Best league leaderboard place by any of the team's pilots"], ["total", wk ? "Team total" : "Season total", time, true, wk ? "All five locked times added up" : "All the team's locked times added up"], ["pbs", "New PBs", num, false, "New personal bests before the lock"], ["vsDraft", "vs draft", (v) => signed(v), false, "Average places above (▲) or below (▼) draft spot"]];
    if (kind === "race") return wk
      ? [["tier", "Tier", num, true, "Tier raced this week"], ["pts", "Pts", num, false, "Tier points (10 for a heat win down to 1)"], ["place", "Tier place", (v) => (v ? ordinal(v) : "–"), true, "Finish in their tier for the day"], ["wins", "Wins", num, false, "Tier heats won"], ["podPct", "Top 3", pct, false, "Share of heats finished in the top 3"], ["fin", "Avg finish", dec(2), true, "Average heat finishing place"], ["bhr", "Best heat #", num, true, "Fastest heat, ranked vs all 40 racers"], ["spread", "Spread %", dec(2), true, "Spread of heat times, % of average (lower = steadier)"], ["bonus", "Bonus pts", num, false, "Bonus-round heat points"]]
      : [["weeks", "Wks", num, false, "Weeks raced"], ["pts", "Pts", num, false, "Tier points, all weeks"], ["ppw", "Pts/wk", dec(1), false, "Tier points per raced week"], ["wins", "Wins", num, false, "Tier heats won"], ["winPct", "Win %", pct, false, "Share of heats won"], ["podPct", "Top 3", pct, false, "Share of heats finished in the top 3"], ["fin", "Avg finish", dec(2), true, "Average heat finishing place"], ["bhr", "Best heat #", dec(1), true, "Average weekly rank of their fastest heat vs all 40 racers"], ["spread", "Spread %", dec(2), true, "Average spread of heat times, % of average (lower = steadier)"], ["bonus", "Bonus pts", num, false, "Bonus-round heat points"]];
    return wk
      ? [["time", "Time", time, true, "Locked leaderboard time"], ["rank", "LB #", num, true, "Place among the league's 50 pilots"], ["off", "% off", off, true, "Gap to the week's fastest league time"], ["pbs", "New PBs", num, false, "New personal bests before the lock"], ["vsDraft", "vs draft", (v) => signed(v, 0), false, "Places above (▲) or below (▼) draft spot"], ["vsTryout", "vs tryout", (v) => signed(v, 0), false, "Places above (▲) or below (▼) tryout spot"]]
      : [["avg", "Avg LB #", dec(1), true, "Average place among the league's 50 pilots"], ["best", "Best LB #", num, true, "Best weekly league place"], ["off", "Avg % off", off, true, "Average gap to each week's fastest league time"], ["total", "Season total", time, true, "All locked leaderboard times added up"], ["pbs", "New PBs", num, false, "New personal bests before each lock"], ["top10", "Top 10s", num, false, "Weeks in the league's top 10"], ["vsDraft", "vs draft", (v) => signed(v), false, "Average places above (▲) or below (▼) draft spot"], ["vsTryout", "vs tryout", (v) => signed(v), false, "Average places above (▲) or below (▼) tryout spot"]];
  }

  function sortRows(rows, cols, kind) {
    const key = `${kind}|${pv.mode}|${pv.scope === "season" ? "s" : "w"}`;
    const def = kind === "race" ? (pv.mode === "teams" ? "pts" : pv.scope === "season" ? "ppw" : "pts") : pv.mode === "teams" ? "avg" : pv.scope === "season" ? "avg" : "rank";
    let s = pv.sort[key];
    if (!s || !cols.some((c) => c[0] === s.key)) s = pv.sort[key] = { key: def, dir: cols.find((c) => c[0] === def)?.[3] ? 1 : -1 };
    const name = (r) => (r.p ? r.p.name : tname(r.team));
    rows.sort((a, b) => {
      if (a.ok !== b.ok) return a.ok ? -1 : 1;
      const x = a[s.key], y = b[s.key];
      if (x == null || y == null) return x == null && y == null ? name(a).localeCompare(name(b)) : x == null ? 1 : -1;
      return (x - y) * s.dir || name(a).localeCompare(name(b));
    });
    return s;
  }

  function renderPilotStats() {
    const el = $("viewPilotStats");
    const d = state.data;
    if (!d) { el.innerHTML = state.error ? `<div class="empty">Couldn't load pilot stats (${esc(state.error)}).</div>` : `<div class="empty">Loading pilot stats…</div>`; return; }
    if (!d.weeks.length) { el.innerHTML = `<div class="empty">Pilot stats start once the first track locks.</div>`; return; }
    if (pv.scope !== "season" && !d.weeks.some((w) => w.id === pv.scope)) pv.scope = "season";
    setPilotsHash();
    if (pv.page) return renderPilotPage(el, d);

    const raceWeeks = d.weeks.filter((w) => w.races);
    const scopes = [["season", "Season so far"], ...d.weeks.map((w) => [w.id, w.name + (w.races ? "" : " (Smash only)")])];
    el.innerHTML = `
      <div class="pv-bar">
        <div class="pseg" role="tablist" aria-label="Stats">${Object.entries(PV_TABS).map(([k, l]) => `<button type="button" role="tab" data-tab="${k}" aria-selected="${pv.tab === k}">${l}</button>`).join("")}</div>
        <label class="pv-scope"><span>Show</span><select id="pvScope">${scopes.map(([v, l]) => `<option value="${v}"${String(pv.scope) === String(v) ? " selected" : ""}>${esc(l)}</option>`).join("")}</select></label>
      </div>
      ${pv.tab !== "spotlight" ? `<div class="pv-bar pv-sub">
        <div class="pseg small" role="group" aria-label="Rows">${["pilots", "teams"].map((m) => `<button type="button" data-mode="${m}" aria-pressed="${pv.mode === m}">${m === "pilots" ? "Pilots" : "Teams"}</button>`).join("")}</div>
        ${pv.mode === "pilots" ? `<input id="pvSearch" type="search" placeholder="Find a pilot" aria-label="Find a pilot" value="${esc(pv.q)}">` : ""}
      </div>` : ""}
      <div id="pvBody"></div>`;
    el.querySelector(".pseg[role=tablist]").addEventListener("click", (e) => { const b = e.target.closest("[data-tab]"); if (b) { pv.tab = b.dataset.tab; renderPilotStats(); } });
    el.querySelector("#pvScope").addEventListener("change", (e) => { pv.scope = e.target.value === "season" ? "season" : +e.target.value; renderPilotStats(); });
    el.querySelector("[data-mode]")?.parentElement.addEventListener("click", (e) => { const b = e.target.closest("[data-mode]"); if (b) { pv.mode = b.dataset.mode; renderPilotStats(); } });
    const search = el.querySelector("#pvSearch");
    if (search) search.addEventListener("input", () => { pv.q = search.value; renderPvBody(d); });
    renderPvBody(d, raceWeeks);
  }

  function renderPvBody(d) {
    const body = $("pvBody");
    if (pv.tab === "spotlight") {
      body.innerHTML = spotlight(d);
      wireDepthTips(body);
      body.onclick = (e) => {
        const b = e.target.closest("[data-stat],[data-bat],[data-all]");
        if (!b) return;
        let sel;
        if (b.dataset.stat) { pv.stat = b.dataset.stat; pv.statAll = false; sel = `[data-stat="${pv.stat}"]`; }
        else if (b.dataset.bat) { pv.bat = b.dataset.bat; pv.batAll = false; sel = `[data-bat="${pv.bat}"]`; }
        else { const k = b.dataset.all === "stat" ? "statAll" : "batAll"; pv[k] = !pv[k]; sel = `[data-all="${b.dataset.all}"]`; }
        renderPvBody(d);
        body.querySelector(sel)?.focus({ preventScroll: true });
      };
      return;
    }
    body.onclick = null;
    const kind = pv.tab;
    if (kind === "race" && pv.scope !== "season" && !d.weeks.find((w) => w.id === pv.scope)?.races) { body.innerHTML = `<div class="empty">${esc(scopeName(d))}'s races aren't in yet.</div>`; return; }
    const cols = columns(kind);
    let rows = d.pilots.map((p) => (kind === "race" ? raceRow(p, d) : smashRow(p, d))).filter(Boolean);
    if (pv.mode === "teams") rows = teamRows(rows, kind);
    const s = sortRows(rows, cols, kind);
    const q = pv.q.trim().toLowerCase();
    const shown = pv.mode === "pilots" && q ? rows.filter((r) => r.p.name.toLowerCase().includes(q) || tname(r.p.team).toLowerCase().includes(q)) : rows;
    const firstOut = shown.findIndex((r) => !r.ok);
    body.innerHTML = `
      <div class="table-wrap pv-wrap"><table class="pv-table">
        <caption class="sr">${esc(PV_TABS[kind])}, ${esc(scopeName(d))}, sortable</caption>
        <thead><tr><th class="num rk" scope="col" title="Place in the current sort">#</th><th class="who" scope="col" title="${pv.mode === "teams" ? "Team, with how many of its pilots are counted" : "Pilot and team; click a name for their page"}">${pv.mode === "teams" ? "Team" : "Pilot"}</th>
          ${cols.map(([k, l, , low, title]) => `<th class="num" scope="col" aria-sort="${s.key === k ? (s.dir === 1 ? "ascending" : "descending") : "none"}"><button type="button" data-sort="${k}" data-low="${low ? 1 : 0}"${title ? ` title="${esc(title)}"` : ""}>${l}${s.key === k ? `<i aria-hidden="true">${s.dir === 1 ? "↑" : "↓"}</i>` : ""}</button></th>`).join("")}</tr></thead>
        <tbody>${shown.map((r, i) => `<tr class="${r.ok ? "" : "unq"}${i === firstOut ? " unq-first" : ""}">
          <td class="num rk">${r.ok ? rows.indexOf(r) + 1 : "–"}</td>
          <th class="who" scope="row">${r.p ? pilotLink(r.p.name, r.p.team, `<small>${esc(tname(r.p.team))}${r.p.captain ? " · Capt" : ""}</small>`) : `<span class="tw">${tdot(r.team)}<span>${esc(tname(r.team))}</span></span><small>${r.pilots} pilot${r.pilots === 1 ? "" : "s"}</small>`}</th>
          ${cols.map(([k, , f]) => `<td class="num${s.key === k ? " on" : ""}">${f(r[k])}</td>`).join("")}
        </tr>`).join("") || `<tr><td colspan="${cols.length + 2}" class="none">No pilots match.</td></tr>`}</tbody>
      </table></div>
      <p class="sub pv-note">${pvNote(kind, d)}</p>`;
    body.querySelector("thead").addEventListener("click", (e) => {
      const b = e.target.closest("[data-sort]");
      if (!b) return;
      const key = `${kind}|${pv.mode}|${pv.scope === "season" ? "s" : "w"}`;
      const cur = pv.sort[key];
      pv.sort[key] = cur?.key === b.dataset.sort ? { key: cur.key, dir: -cur.dir } : { key: b.dataset.sort, dir: b.dataset.low === "1" ? 1 : -1 };
      renderPvBody(d);
    });
  }

  function pvNote(kind, d) {
    const raced = d.weeks.filter((w) => w.races).length;
    if (kind === "race") return pv.scope === "season"
      ? `Race heats from ${raced} race day${raced === 1 ? "" : "s"}; sit-out weeks don't count. Points are tier points (10 for 1st down to 1). Wks shows how many weeks each pilot has raced. Bonus points are bonus-round heat points (8 down to 1). Click a column to sort.`
      : `Tier heats from ${esc(scopeName(d))}. Pilots who sat out aren't listed. Click a column to sort.`;
    return pv.scope === "season"
      ? `LB # is a pilot's place among the league's 50 pilots on each week's locked leaderboard. Draft and tryout spots are among the same 50 pilots. New PBs count each new personal best the site saw before the lock.`
      : `${esc(scopeName(d))}'s locked leaderboard. LB # is the place among the league's 50 pilots.`;
  }

  // ---- Spotlight: top three for the headline stats, then the closest battles and records ----
  // Closest full heats: one strip per heat, each pilot a dot placed by seconds behind the
  // winner, on a scale shared by every heat in the list (so tighter heats look tighter).
  function depthRows(list, wname) {
    if (!list.length) return "";
    const max = Math.max(...list.map((h) => h.gap));
    const step = [0.5, 1, 2, 3, 4, 5, 10].find((k) => max / k <= 5) || 20;
    const top = Math.ceil(max / step) * step || 1;
    const X = (g) => `${((g / top) * 100).toFixed(2)}%`;
    const ticks = []; for (let v = 0; v <= top + 1e-9; v += step) ticks.push(v);
    const axis = `<li class="dh-axis" aria-hidden="true"><span></span><div class="dh-main"><span class="dh-ax-l">behind the winner</span><div class="dh-track">${ticks.map((v) => `<i style="left:${X(v)}">${v ? "+" + (+v.toFixed(1)) : "0"}s</i>`).join("")}</div></div><span></span></li>`;
    return axis + list.map((h) => {
      const t0 = h.field[0][2];
      const dots = h.field.map((x, i) => [...x, i]).reverse().map(([pilot, team, time, i]) => `<button type="button" class="dh-dot${i === 0 ? " w" : ""}" style="left:${X(time - t0)}" data-tip="${esc(pilot)}|${esc(tname(team))}|${i + 1}|${i ? "+" + (time - t0).toFixed(3) + "s" : fmt(time)}" aria-label="${ordinal(i + 1)}: ${esc(pilot)}, ${i ? "+" + (time - t0).toFixed(3) + " seconds" : fmt(time)}"></button>`).join("");
      return `<li class="dh"><span class="medal">${h.n}</span>
        <div class="dh-main"><div class="bl"><span class="dh-l">${esc(h.label)}</span><small>${esc(wname(h.week))} · ${esc(h.a.pilot)} won, ${esc(h.b.pilot)} 10th</small></div>
          <div class="dh-track" role="group" aria-label="${esc(h.label)}, ${esc(wname(h.week))}: finishers by gap to the winner"><span class="dh-rng" style="width:${X(h.gap)}"></span>${dots}</div></div>
        ${`<b class="gap">${h.gap.toFixed(3)}<small>s</small></b>`}</li>`;
    }).join("");
  }
  function wireDepthTips(root) {
    const tip = root.querySelector("#dhTip");
    if (!tip) return;
    const box = tip.parentElement;
    const show = (c) => {
      const [pilot, team, place, val] = c.dataset.tip.split("|");
      tip.innerHTML = `<b>${pilot}</b><div><span>Team</span><span>${team}</span></div><div><span>Place</span><span>${ordinal(+place)}</span></div><div><span>${place === "1" ? "Time" : "Behind"}</span><span>${val}</span></div>`;
      tip.hidden = false;
      const bx = box.getBoundingClientRect(), r = c.getBoundingClientRect();
      const cx = r.left + r.width / 2 - bx.left, wide = tip.offsetWidth;
      tip.style.left = `${Math.max(0, Math.min(cx + 12 + wide <= bx.width ? cx + 12 : cx - wide - 12, bx.width - wide))}px`;
      tip.style.top = `${Math.max(0, r.bottom - bx.top + 6)}px`;
    };
    root.querySelectorAll(".dh-dot").forEach((c) => {
      c.addEventListener("mouseenter", () => show(c));
      c.addEventListener("focus", () => show(c));
      c.addEventListener("click", () => show(c));
      c.addEventListener("mouseleave", () => { if (document.activeElement !== c) tip.hidden = true; });
      c.addEventListener("blur", () => { tip.hidden = true; });
    });
  }

  function spotlight(d) {
    const season = pv.scope === "season";
    const wk = season ? null : d.weeks.find((w) => w.id === pv.scope);
    if (!season && !wk) return "";
    const race = d.pilots.map((p) => raceRow(p, d)).filter((r) => r && r.ok);
    const smash = d.pilots.map((p) => smashRow(p, d)).filter(Boolean);
    const hasRace = season ? race.length > 0 : !!wk.races;
    const wname = (id) => d.weeks.find((w) => w.id === id)?.name || "";

    // ---- Stat leaderboards: one chip per stat, the chosen one shown as a full leaderboard ----
    const stats = [
      hasRace && { id: "ppw", label: season ? "Points per week" : "Race points", rows: race, key: season ? "ppw" : "pts", f: (v) => n2(v, 1), detail: (r) => (season ? `${r.pts} pts in ${r.weeks} wk${r.weeks === 1 ? "" : "s"}` : `Tier ${r.tier} · ${ordinal(r.place)} in tier`), about: season ? "Tier points per raced week (10 for a heat win down to 1)." : "Tier heat points for the day (10 for a heat win down to 1)." },
      hasRace && { id: "wins", label: "Heat wins", rows: race, key: "wins", f: (v) => v, detail: (r) => `${pct(r.winPct)} of heats`, about: "Tier heats won." },
      hasRace && { id: "fin", label: "Avg finish", rows: race, key: "fin", low: true, f: (v) => n2(v), detail: (r) => `top 3 in ${pct(r.podPct)}`, about: "Average finishing place in their tier's heats." },
      hasRace && { id: "bhr", label: "Fastest on the day", rows: race, key: "bhr", low: true, f: (v) => (season ? "#" + n2(v, 1) : "#" + v), detail: (r) => (season ? "average rank" : `Tier ${r.tier}`), about: season ? "Each week their fastest heat is ranked against all 40 racers; this is the average rank. All tiers fly the same track, so this compares pilots across tiers." : "Their fastest heat ranked against all 40 racers. All tiers fly the same track, so this compares pilots across tiers." },
      hasRace && { id: "spread", label: "Most consistent", rows: race, key: "spread", low: true, f: (v) => `${n2(v)}%`, detail: (r) => (r.fin != null ? `avg finish ${n2(r.fin)}` : ""), about: "Spread of their heat times as a % of their average heat time. Lower is more consistent." },
      season && hasRace && { id: "streak", label: "Win streak", rows: race, key: "streak", f: (v) => `${v}`, detail: (r) => `${r.wins} wins in all`, about: "Most tier heats won in a row this season." },
      hasRace && { id: "bonus", label: "Bonus round", rows: race, key: "bonus", f: (v) => `${v}`, detail: () => "bonus heat pts", about: "Points from bonus-round heats (8 for 1st down to 1). Only the top four teams race the bonus round." },
      { id: "lb", label: season ? "Avg LB #" : "Leaderboard", rows: smash, key: season ? "avg" : "rank", low: true, f: (v) => "#" + (season ? n2(v, 1) : v), detail: (r) => (season ? `best #${r.best}` : r.time != null ? fmt(r.time) : ""), about: season ? "Average place among the league's 50 pilots on each week's locked leaderboard." : "Place among the league's 50 pilots on the locked leaderboard." },
      season && { id: "total", label: "Season Smash total", rows: smash, key: "total", low: true, f: (v) => fmt(v), detail: (r) => `avg LB #${n2(r.avg, 1)}`, about: "All their locked leaderboard times added up. Every pilot posts every week, sit-outs included." },
      { id: "pbs", label: "New PBs", rows: smash, key: "pbs", f: (v) => v, detail: (r) => (season ? `avg LB #${n2(r.avg, 1)}` : `LB #${r.rank}`), about: "New personal bests the site saw before the lock." },
      { id: "draft", label: "Most improved", rows: smash, key: "vsDraft", f: (v) => signed(v, season ? 1 : 0), detail: (r) => `drafted #${r.p.draftPos ?? "–"}`, about: "Places above (▲) or below (▼) where they were drafted, by league leaderboard place." },
    ].filter(Boolean);
    const stat = stats.find((x) => x.id === pv.stat) || stats[0];
    const STAT_TIPS = {
      ppw: season ? "Tier points per raced week" : "Tier points for the day", wins: "Tier heats won", fin: "Average heat finishing place",
      bhr: season ? "Average rank of their fastest heat vs all 40 racers" : "Fastest heat, ranked vs all 40 racers", spread: "Spread of heat times, % of average (lower = steadier)",
      streak: "Most heats won in a row", bonus: "Bonus-round heat points", lb: season ? "Average place among the league's 50 pilots" : "Place among the league's 50 pilots",
      total: "All locked leaderboard times added up", pbs: "New personal bests before the lock", draft: "Places above (▲) or below (▼) draft spot",
    };
    if (stat) stat.tip = STAT_TIPS[stat.id];

    let statHtml = "";
    if (stat) {
      const all = stat.rows.filter((r) => r[stat.key] != null).sort((a, b) => (a[stat.key] - b[stat.key]) * (stat.low ? 1 : -1) || a.p.name.localeCompare(b.p.name));
      const place = (r) => 1 + all.filter((x) => (x[stat.key] - r[stat.key]) * (stat.low ? 1 : -1) < 0).length;
      const shown = pv.statAll ? all : all.slice(0, SHOW_MANY);
      statHtml = `
        <div class="lbx-head"><h3>${esc(stat.label)}</h3><p>${esc(stat.about)} Level pilots share a place.</p></div>
        <div class="table-wrap pv-wrap flat"><table class="pv-table lbt">
          <caption class="sr">${esc(stat.label)} leaderboard, ${esc(scopeName(d))}</caption>
          <thead><tr><th class="num rk" scope="col" title="Place; level pilots share a place">#</th><th scope="col" title="Click a name for their page">Pilot</th><th scope="col" class="tm" title="Team name">Team</th><th class="num" scope="col" title="${esc(stat.tip || stat.about)}">${esc(stat.label)}</th><th scope="col" class="dt" title="More about this pilot's number">Detail</th></tr></thead>
          <tbody>${shown.map((r) => { const n = place(r); return `<tr class="${n <= 3 ? "top" : ""}"><td class="num rk"><span class="medal${n === 1 ? " m1" : ""}">${n}</span></td><th scope="row" class="who">${pilotLink(r.p.name, r.p.team, `<small class="tm-sm">${esc(tname(r.p.team))}</small>`)}</th><td class="tm">${esc(tname(r.p.team))}${r.p.captain ? ' <span class="muted">· Capt</span>' : ""}</td><td class="num val">${stat.f(r[stat.key], r)}<small class="dt-sm">${esc(stat.detail(r))}</small></td><td class="dt">${esc(stat.detail(r))}</td></tr>`; }).join("") || `<tr><td colspan="5" class="none">Nothing to show yet.</td></tr>`}</tbody>
        </table></div>
        ${all.length > SHOW_MANY ? `<button type="button" class="more" data-all="stat" aria-expanded="${pv.statAll}">${pv.statAll ? `Show top ${SHOW_MANY}` : `Show all ${all.length}`}</button>` : ""}`;
    }

    // ---- Battles and records: same chips, one list at a time ----
    const inScope = (x) => season || x.week === pv.scope;
    const ranked = (list, by, desc = false) => list.filter(inScope).sort((a, b) => (desc ? by(b) - by(a) : by(a) - by(b)));
    const gap = (g) => `<b class="gap">${g.toFixed(3)}<small>s</small></b>`;
    const pair = (b, what, word = "over") => `<li><span class="medal">${b.n}</span><div class="bl">${pilotLink(b.a.pilot, b.a.team)} <span class="over">${word}</span> ${pilotLink(b.b.pilot, b.b.team)}<small>${esc(wname(b.week))} · ${esc(b.label || "Leaderboard")}${what ? " · " + what(b) : ""}</small></div>${gap(b.gap)}</li>`;
    // Each week is a different track: the season's fastest heats are listed week by week.
    // Fastest heats: each week, each tier's quickest runs (numbered within the tier).
    const fastest = d.weeks.filter((w) => w.races && inScope({ week: w.id })).flatMap((w) =>
      [...new Set(d.records.fastest.filter((x) => x.week === w.id).map((x) => x.tier))].sort((a, b) => a - b).flatMap((t) =>
        d.records.fastest.filter((x) => x.week === w.id && x.tier === t).sort((a, b) => a.time - b.time).map((x, i) => ({ ...x, n: i + 1 }))));
    const num = (list) => list.map((x, i) => ({ ...x, n: i + 1 }));
    const bats = [
      { id: "close", label: "Closest battles", about: "Smallest gaps between two pilots finishing next to each other, for any position, in tier heats and the bonus round.", items: num(ranked(d.battles.close, (x) => x.gap)), row: (b) => pair(b, (x) => `for ${ordinal(x.pos)}`) },
      { id: "cwins", label: "Closest heat wins", about: "Smallest gaps between 1st and 2nd.", items: num(ranked(d.battles.wins, (x) => x.gap)), row: (b) => pair(b, () => "for the win") },
      { id: "cheats", label: "Closest full heats", about: "Tier heats with the smallest gap from 1st to 10th. Each dot is a pilot, placed by how far behind the winner they finished; all heats share one scale. Hover or tap a dot for the pilot.", items: num(ranked(d.battles.heats, (x) => x.gap)), depth: true },
      { id: "csmash", label: "Closest leaderboard gaps", about: "Smallest gaps between neighbouring league places on the locked leaderboard.", items: num(ranked(d.battles.smash, (x) => x.gap)), row: (b) => pair(b, (x) => `for LB #${x.pos}`) },
      hasRace && { id: "margins", label: "Biggest win margins", about: "Biggest gaps between the heat winner and 2nd.", items: num(ranked(d.records.margins, (x) => x.gap, true)), row: (b) => pair(b, null, "ahead of") },
      hasRace && { id: "fast", label: "Fastest heats", about: "Fastest single heat runs in each tier, week by week (each week is a different track).", items: fastest, row: (x) => `<li><span class="medal">${x.n}</span><div class="bl">${pilotLink(x.pilot, x.team)}<small>${esc(wname(x.week))} · ${esc(x.label)}</small></div><b class="gap">${fmt(x.time)}</b></li>` },
    ].filter(Boolean);
    const bat = bats.find((x) => x.id === pv.bat) || bats[0];
    // Fastest heats show 1 run per tier per week, opening to as many per tier as fit in BAT_MAX.
    const byTier = bat.id === "fast";
    const groups = byTier ? new Set(bat.items.map((x) => `${x.week}|${x.tier}`)).size : 1;
    const perGroup = Math.max(1, Math.floor(BAT_MAX / groups));
    const fullBat = byTier ? bat.items.filter((x) => x.n <= perGroup) : bat.items.slice(0, BAT_MAX);
    const fewBat = byTier ? bat.items.filter((x) => x.n === 1) : bat.items.slice(0, SHOW_MANY);
    const shownBat = pv.batAll ? fullBat : fewBat;
    let lastWeek = null, lastTier = null;
    const batRows = bat.depth ? depthRows(shownBat, wname) : shownBat.map((x) => {
      let head = "";
      if (byTier && x.week !== lastWeek) { head += `<li class="wk">${esc(wname(x.week))}</li>`; lastTier = null; }
      if (byTier && pv.batAll && x.tier !== lastTier) head += `<li class="tk">Tier ${x.tier}</li>`;
      lastWeek = x.week; lastTier = x.tier;
      return head + (byTier && !pv.batAll ? `<li><span class="tchip">Tier ${x.tier}</span><div class="bl">${pilotLink(x.pilot, x.team)}<small>Heat ${x.heat}</small></div><b class="gap">${fmt(x.time)}</b></li>` : bat.row(x));
    }).join("");

    const chips = (list, cur, attr, label) => `<div class="chips" role="group" aria-label="${label}">${list.map((x) => `<button type="button" class="chip" data-${attr}="${x.id}" aria-pressed="${x.id === cur.id}">${esc(x.label)}</button>`).join("")}</div>`;
    return `
      <section class="lbx" aria-labelledby="lbxTitle">
        <div class="sec-head"><h2 id="lbxTitle">Stat Leaderboards</h2><span>${esc(scopeName(d))}</span></div>
        <p class="hint">Pick a stat to see its leaderboard.</p>
        ${stats.length ? chips(stats, stat, "stat", "Stat") : ""}
        <div class="chart-card lbx-card">${statHtml || `<div class="empty">Nothing to show for ${esc(scopeName(d))} yet.</div>`}</div>
      </section>
      ${season ? `<p class="sub pv-note">Each week is a different track and quad, so season stats use places and percentages rather than raw times.</p>` : ""}
      <section class="lbx" aria-labelledby="batTitle">
        <div class="sec-head"><h2 id="batTitle">Battles &amp; Records</h2><span>${esc(scopeName(d))}</span></div>
        <p class="hint">Pick a list to see the closest finishes and biggest results.</p>
        ${chips(bats, bat, "bat", "Battles and records")}
        <div class="chart-card lbx-card bat">
          <div class="lbx-head"><h3>${esc(bat.label)}</h3><p>${esc(bat.about)}</p></div>
          <ol${bat.depth ? ' class="dh-list"' : ""}>${batRows || `<li class="none">Nothing yet</li>`}</ol>
          ${fullBat.length > fewBat.length ? `<button type="button" class="more" data-all="bat" aria-expanded="${pv.batAll}">${pv.batAll ? (byTier ? "Show the fastest in each tier" : `Show top ${SHOW_MANY}`) : byTier ? `Show top ${perGroup} in each tier` : `Show top ${fullBat.length}`}</button>` : ""}
          ${bat.depth ? `<div class="tip" id="dhTip" hidden></div>` : ""}
        </div>
      </section>`;
  }

  // ---- One pilot's page ----
  function renderPilotPage(el, d) {
    const p = d.pilots.find((x) => x.name === pv.page);
    if (!p) { el.innerHTML = `<p><a class="back" href="#pilots">← All pilots</a></p><div class="empty">No pilot called ${esc(pv.page)}.</div>`; return; }
    const s = p.season;
    const raced = d.weeks.filter((w) => w.races);
    const tile = (v, label, sub) => `<div class="tile"><b>${v}</b><span>${label}${sub ? `<small>${sub}</small>` : ""}</span></div>`;
    const teamMates = d.pilots.filter((x) => x.team === p.team && x.name !== p.name);
    const rows = d.weeks.map((w) => {
      const wk = p.weeks[w.id], sm = wk.smash, r = wk.race;
      const raceCells = !w.races ? `<td colspan="6" class="muted">Races not in yet</td>`
        : r?.sat ? `<td colspan="6" class="muted">Sat out</td>`
        : r ? `<td class="num">${r.tier}</td><td class="num">${r.points}</td><td class="num">${ordinal(r.place)}</td><td class="num">${r.wins}</td><td class="num">${r.bestHeatRank ? "#" + r.bestHeatRank : "–"}</td><td class="num">${r.spreadPct != null ? n2(r.spreadPct) + "%" : "–"}</td>`
        : `<td colspan="6" class="muted">–</td>`;
      return `<tr><th scope="row">${esc(w.name)}<small>${esc(w.quad || "")}</small></th>
        <td class="num">${sm?.time != null ? fmt(sm.time) : "–"}</td><td class="num">${sm?.rank ? "#" + sm.rank : "–"}</td><td class="num">${sm?.pctOff != null ? "+" + sm.pctOff.toFixed(2) + "%" : "–"}</td><td class="num">${sm ? sm.pbs : "–"}</td>
        ${raceCells}<td class="num">${wk.bonus ? wk.bonus.points : "–"}</td></tr>`;
    }).join("");

    const heatCell = (h, max) => `<div class="hc${h.pos === 1 ? " win" : h.pos && h.pos <= 3 ? " top3" : ""}${h.time == null ? " nt" : ""}" title="${h.time == null ? (h.dnf ? "DNF" : "No time") : fmt(h.time) + "s"}, ${h.pos ? ordinal(h.pos) + " of " + max : "no place"}, ${h.pts} pts"><b>${h.pos ? ordinal(h.pos) : "–"}</b><span>${h.time == null ? (h.dnf ? "DNF" : "no time") : fmt(h.time)}</span></div>`;
    const heatsHtml = raced.map((w) => {
      const wk = p.weeks[w.id], r = wk.race;
      if (!r) return "";
      if (r.sat) return `<div class="hw"><h3>${esc(w.name)}</h3><p class="muted">Sat out this week.</p></div>`;
      const bonusRows = wk.bonus ? `<div class="hrow"><span class="hl">Bonus</span><div class="hcells">${wk.bonus.heats.map((h) => `<div class="hb"><small>${esc(h.label.replace("Semifinal", "Semi"))} H${h.heat}</small>${heatCell(h, 8)}</div>`).join("")}</div></div>` : "";
      return `<div class="hw"><h3>${esc(w.name)} <span>Tier ${r.tier} · ${r.points} pts · ${ordinal(r.place)} in tier${r.avgTime != null ? ` · avg ${fmt(r.avgTime)} ± ${r.range.toFixed(3)}` : ""}</span></h3>
        <div class="hrow"><span class="hl">Heats</span><div class="hcells">${r.heats.map((h) => heatCell(h, 10)).join("")}</div></div>${bonusRows}</div>`;
    }).join("");

    const logs = d.weeks.map((w) => {
      const sm = p.weeks[w.id].smash;
      if (!sm?.log?.length) return "";
      const rows = [...sm.log].reverse().map((e) => `<tr><td>${esc(dayShort.format(new Date(e.at)))}</td><td class="num">${fmt(e.time)}</td><td class="num">${e.prev != null ? `<span class="up">−${(e.prev - e.time).toFixed(3)}</span>` : `<span class="muted">first time</span>`}</td></tr>`).join("");
      return `<details class="fold pblog"><summary><h3>${esc(w.name)} <span>${sm.pbs} new PB${sm.pbs === 1 ? "" : "s"} · final ${sm.time != null ? fmt(sm.time) : "–"}${sm.rank ? ` · LB #${sm.rank}` : ""}</span></h3></summary>
        <div class="table-wrap"><table class="stbl"><thead><tr><th title="When the site saw it, in your time zone">When (your time)</th><th class="num" title="New personal best time">Time</th><th class="num" title="How much faster than their previous best">Gain</th></tr></thead><tbody>${rows}</tbody></table></div></details>`;
    }).join("");

    el.innerHTML = `
      <p class="pv-back"><a class="back" href="#pilots${pv.tab !== "spotlight" || pv.scope !== "season" ? "/" + pv.tab + (pv.scope !== "season" ? "/" + pv.scope : "") : ""}">← All pilots</a></p>
      <section class="pcard">
        <div class="pteam">${tdot(p.team)}<b>${esc(tname(p.team))}</b><span>${esc(p.team)}</span>${p.captain ? '<span class="cap">Capt</span>' : ""}</div>
        <dl class="pmeta">
          <div><dt>Draft</dt><dd>${p.draftPos != null ? "#" + p.draftPos : "–"}</dd></div>
          <div><dt>Tryout spot</dt><dd>${p.tryoutPlace != null ? "#" + p.tryoutPlace : "–"}<small>${p.tryoutRank != null ? `rank ${p.tryoutRank} overall` : ""}</small></dd></div>
          <div><dt>Weeks raced</dt><dd>${s.weeksRaced}<small>sat out ${s.weeksSat}</small></dd></div>
          <div><dt>Teammates</dt><dd class="mates">${teamMates.map((m) => `<a href="#pilot/${encodeURIComponent(m.name)}">${esc(m.name)}</a>`).join(", ")}</dd></div>
        </dl>
      </section>
      <div class="stat-tiles">
        ${tile(s.ptsPerWeek != null ? n2(s.ptsPerWeek, 1) : "–", "points per raced week", `${s.points} tier pts`)}
        ${tile(s.wins, "heat wins", s.heats ? `${pct(s.winPct)} of ${s.heats} heats` : "")}
        ${tile(n2(s.avgFinish), "average finish", s.podiumPct != null ? `top 3 in ${pct(s.podiumPct)}` : "")}
        ${tile(s.avgBestHeatRank != null ? "#" + n2(s.avgBestHeatRank, 1) : "–", "best heat rank", "vs all 40 racers")}
        ${tile(s.spreadPct != null ? n2(s.spreadPct) + "%" : "–", "spread", "lower is more consistent")}
        ${tile(s.bonusPoints, "bonus-round points", s.bonusHeats ? `${s.bonusHeats} heats, ${s.bonusWins} won` : "")}
        ${tile(s.avgRank != null ? "#" + n2(s.avgRank, 1) : "–", "average LB #", s.bestRank ? `best #${s.bestRank}` : "")}
        ${tile(s.pbs, "new personal bests", s.vsDraft != null ? `${s.vsDraft >= 0 ? "▲" : "▼"} ${Math.abs(s.vsDraft).toFixed(1)} vs draft` : "")}
      </div>
      <section class="chart-card"><div class="sec-head"><h2>Week by week</h2><span>leaderboard · races</span></div>
        <div class="table-wrap pv-wrap flat"><table class="pv-table wbw">
          <thead><tr><th scope="col" title="Week and quad">Week</th><th class="num" scope="col" title="Locked leaderboard time">Time</th><th class="num" scope="col" title="Place among the league's 50 pilots">LB #</th><th class="num" scope="col" title="Gap to the week's fastest league time">% off</th><th class="num" scope="col" title="New personal bests before the lock">PBs</th><th class="num" scope="col" title="Tier raced">Tier</th><th class="num" scope="col" title="Tier points (10 for a heat win down to 1)">Pts</th><th class="num" scope="col" title="Finish in their tier for the day">Place</th><th class="num" scope="col" title="Tier heats won">Wins</th><th class="num" scope="col" title="Fastest heat, ranked vs all 40 racers">Best heat #</th><th class="num" scope="col" title="Spread of heat times, % of average (lower = steadier)">Spread</th><th class="num" scope="col" title="Bonus-round heat points">Bonus</th></tr></thead>
          <tbody>${rows}</tbody></table></div>
        <p class="sub">LB # is their place among the league's 50 pilots; % off is the gap to that week's fastest league time. Place is their finish in their tier for the day.</p>
      </section>
      ${heatsHtml ? `<section class="chart-card"><div class="sec-head"><h2>Heat results</h2><span>place and time, tier heats then bonus round</span></div><div class="hweeks">${heatsHtml}</div>
        <div class="hkey"><span><i class="win"></i>Win</span><span><i class="top3"></i>2nd–3rd</span><span><i></i>4th or lower</span></div></section>` : ""}
      ${logs ? `<section class="chart-card"><div class="sec-head"><h2>Leaderboard grind</h2><span>new personal bests before each lock</span></div>${logs}</section>` : ""}`;
  }
  const dayShort = new Intl.DateTimeFormat([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

  // Links inside the Pilots tab change the page without a reload.
  $("viewPilotStats").addEventListener("click", (e) => {
    const a = e.target.closest("a[href^='#pilot']");
    if (!a || e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    location.hash !== a.getAttribute("href") && history.pushState(null, "", a.getAttribute("href"));
    readPilotsHash();
    renderHeader();
    renderPilotStats();
    window.scrollTo({ top: 0 });
  });
  window.addEventListener("popstate", () => { if (isPilots() && readPilotsHash()) { renderHeader(); renderPilotStats(); } });

  // ---------- standings ----------
  function renderStandings() {
    if (isOverall()) return renderOverall();
    if (isPilots()) return renderPilotStats();
    const d = state.data;
    if (!d || !d.standings) {
      const t = currentTrack();
      const msg = t && t.status === "upcoming" ? "This track hasn't opened yet." : state.loading ? "" : "No times saved for this track yet.";
      $("viewTeams").innerHTML = msg ? `<div class="empty">${msg}</div>` : "";
      $("pilotRows").innerHTML = "";
      return;
    }
    const teams = d.standings.teams;
    // LB # on the Smash tab is a pilot's place among the league's rostered pilots with a time
    // (ties share a place). The Leaderboard tab keeps Velocidrone's own position.
    const timed = teams.flatMap((t) => t.pilots).filter((p) => p.posted && p.time != null).map((p) => p.time);
    const leagueLb = (p) => (p.posted && p.time != null ? 1 + timed.filter((v) => v < p.time).length : null);
    $("viewTeams").innerHTML = teams
      .map((t) => `
      <article class="team">
        <div class="team-head">
          <div class="pos">${t.position}</div>
          <div class="tname">
            <h2>${tdot(t.sponsor)}${esc(tname(t.sponsor))}</h2>
            <p>${esc(t.sponsor)} · Captain ${esc(t.captain)}<span class="posted${t.posted === t.size ? " full" : ""}">${t.posted}/${t.size} posted</span></p>
          </div>
          <div class="total">
            <div class="t">${fmt(t.total)}</div>
            <div class="g">${t.position === 1 ? "leader" : "+" + fmt(t.gap)}</div>
          </div>
        </div>
        <table class="pilots"><tbody>
          ${t.pilots.map((p) => `<tr class="${p.posted ? "" : "notime"}">
            <td class="name">${esc(p.name)}${p.captain ? '<span class="cap">Capt</span>' : ""}</td>
            <td class="lb"${leagueLb(p) ? ` title="${ordinal(leagueLb(p))} of the ${timed.length} league pilots with a time"` : ""}>${p.override ? "set by league" : leagueLb(p) ? "LB #" + leagueLb(p) : ""}</td>
            <td class="time">${p.posted ? fmt(p.time) + ovr(p) : NO_TIME.toFixed(2)}</td>
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
        <td class="muted">${esc(tname(p.team))}</td>
        <td class="num muted">${p.lb ? "#" + p.lb : ""}</td>
        <td class="num">${p.posted ? fmt(p.time) + ovr(p) : NO_TIME.toFixed(2)}</td>
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
    if (v === "stats" && !isSeasonTab()) loadStats();
    $("viewRaceStatsBtn").setAttribute("aria-selected", v === "racestats");
    $("viewRaceStats").hidden = v !== "racestats";
    $("viewRaces").hidden = v !== "races";
    if ((v === "races" || v === "racestats") && !isSeasonTab()) { loadRaces(); liveStart(state.current, loadRaces); }
    else liveStop();
    $("viewTeams").hidden = v !== "teams";
    $("viewPilots").hidden = v !== "pilots";
  }
  $("viewTeamsBtn").addEventListener("click", () => showView("teams"));
  $("viewPilotsBtn").addEventListener("click", () => showView("pilots"));
  $("viewRacesBtn").addEventListener("click", () => showView("races"));
  $("viewStatsBtn").addEventListener("click", () => showView("stats"));
  $("viewRaceStatsBtn").addEventListener("click", () => showView("racestats"));

  // ---------- races ----------
  // League-set time: a marker whose tooltip says what Velocidrone lists and why.
  const ovr = (p) => (p.override ? `<sup class="ovr" tabindex="0" title="${esc(p.override.note)}${p.override.listed != null ? ` Velocidrone lists ${fmt(p.override.listed)}.` : ""}">*</sup>` : "");
  const ordinal = (n) => n + (n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] || "th");
  const raceDayFmt = new Intl.DateTimeFormat([], { weekday: "long", month: "short", day: "numeric" });

  async function loadRaces() {
    const id = state.current;
    if (id == null || isSeasonTab()) return;
    if (!state.races || state.races.id !== id) { state.races = { id, data: null, error: null }; renderRaces(); renderRaceStats(); }
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
    renderRaceStats();
  }

  const fmtTime = (t) => (t === "dnf" ? "DNF" : typeof t === "number" ? t.toFixed(3) : "");
  const resultTitle = (time, pos) => (time == null ? "" : time === "dnf" ? "DNF" : `${fmtTime(time)} s · ${ordinal(pos)}`);
  const place = (p) => (p != null ? `<span class="opos">${p}</span>` : "");
  const pilotLabel = (p) => (p ? esc(p) : '<span class="tbd">Pilot TBD</span>');
  const raceDayText = (d) => (d.raceDay ? raceDayFmt.format(new Date(d.raceDay + "T12:00:00")) : "Sunday");
  const leaderOf = (list) => (list[0] && list[0].place === 1 ? `Leader: ${esc(tname(list[0].sponsor))} (${list[0].total})` : "");
  const metaJoin = (...parts) => parts.filter(Boolean).join(" · ");
  const tierMeta = (t, d) => metaJoin(t.racesRun ? `${t.racesRun} of ${d.racesPerTier} races run` : `${d.racesPerTier} races`, leaderOf(t.entries));
  const fold = (key, title, meta, inner) => `
      <details class="fold" data-fold="${key}"${isOpen(key) ? " open" : ""}>
        <summary class="sec-head"><h2>${title}</h2><span data-meta="${key}">${meta}</span></summary>
        ${inner}
      </details>`;

  function raceSummaryTable(d) {
    const tiers = d.tierResults.map((t) => t.tier);
    const hasBonus = !!d.bonus?.seeds?.length;
    return `
      <div class="table-wrap"><table class="overall grid">
        <thead><tr><th class="team-col" scope="col">Team</th>${tiers.map((t) => `<th class="num wk-start" scope="col">Tier ${t}</th>`).join("")}${hasBonus ? `<th class="num wk-start" scope="col">Bonus</th>` : ""}<th class="num tot" scope="col">Total</th><th class="wk-start sit" scope="col">Sitting out</th></tr></thead>
        <tbody>${d.teams.map((t) => `<tr>
          <th class="team-col" scope="row"><div class="ocell">${place(t.place)}<span class="oname"><b>${esc(tname(t.sponsor))}</b><small>Capt ${esc(t.captain)}</small></span></div></th>
          ${tiers.map((ti) => `<td class="num wk-start">${pts(t.byTier[ti])}</td>`).join("")}
          ${hasBonus ? `<td class="num wk-start" title="${t.bonusPlace ? `${ordinal(t.bonusPlace)} in the bonus round: +${t.bonus} to this week's Race points on the Overall table` : t.seed ? `Seed #${t.seed} in the bonus round` : "Not in the bonus round"}">${t.bonus != null ? "+" + t.bonus : t.seed ? `<span class="tbd">#${t.seed}</span>` : ""}</td>` : ""}
          <td class="num tot">${pts(t.total)}</td>
          <td class="wk-start sit">${t.sitting ? esc(t.sitting) : '<span class="tbd">TBD</span>'}</td>
        </tr>`).join("")}</tbody>
      </table></div>${hasBonus ? `<p class="sub">Total is the tier races only. Bonus round points aren't added here; they go on top of the team's Race points for the week on the Overall table.</p>` : ""}`;
  }

  // ---------- bonus round ----------
  const bonusIntro = (b) => `Top ${b.seeds.length || 4} teams by race points. #1 v #4 and #2 v #3 fly ${b.heats} heats with all four racers (eight pilots a heat, ${b.heatPoints[0]} points for 1st down to ${b.heatPoints[b.heatPoints.length - 1]} for ${ordinal(b.heatPoints.length)}); the winners then fly ${b.heats} heats for 1st and 2nd, the losers for 3rd and 4th. Bonus points, added to the team's Race points for the week on the Overall table: ${b.placePoints.map((p, i) => `${ordinal(i + 1)} +${p}`).join(" · ")}.`;
  const bonusMeta = (b) => (!b?.seeds?.length ? "after the tiers" : b.places.length === 4 ? `Won by ${esc(tname(b.places[0].sponsor))}` : b.matches.some((m) => m.heats.some((h) => h.run)) ? "in progress" : "seeds set");
  function bonusPlaces(b) {
    if (!b.places.length) return "";
    return `<div class="bonus-places">${b.places.map((p) => `<span><b>${ordinal(p.place)}</b> ${esc(tname(p.sponsor))} <em>+${p.points}</em></span>`).join("")}</div>`;
  }
  function bonusMatch(m, b, edit) {
    const [a, c] = m.teams;
    if (!a || !c) return `<div class="bonus-match"><h3>${esc(m.label)}</h3><p class="sub">${m.id === "final" ? "Semifinal winners" : "Semifinal losers"} fly here once both semifinals are done.</p></div>`;
    const seedOf = (sp) => b.seeds.indexOf(sp) + 1;
    const score = m.totals ? `${m.totals[a]}–${m.totals[c]}` : "";
    const head = `<h3>${esc(m.label)} <span class="vs">#${seedOf(a)} ${esc(tname(a))} v #${seedOf(c)} ${esc(tname(c))}</span>${m.heats.some((h) => h.run) ? `<span class="score" data-bscore="${m.id}">${score}${m.winner ? ` · ${esc(tname(m.winner))} wins${m.decision ? ` (${esc(m.decision)})` : ""}` : m.tied ? " · tied" : ""}</span>` : ""}</h3>`;
    const rows = [a, c].map((sp) => {
      const pilots = [1, 2, 3, 4].map((tier) => {
        const cells = m.heats.map((h) => h.entries.find((e) => e.sponsor === sp && e.tier === tier));
        const pilot = cells[0]?.pilot;
        const sum = cells.reduce((s2, e) => s2 + (e?.points || 0), 0);
        return `<tr>
          <th class="team-col" scope="row"><div class="ocell"><span class="oname"><b>${pilotLabel(pilot)}</b><small>Tier ${tier}</small></span></div></th>
          ${cells.map((e, hi) => edit
            ? `<td class="tcell${hi === 0 ? " wk-start" : ""}"><input class="tin" data-kind="btime" data-match="${m.id}" data-heat="${hi + 1}" data-sponsor="${esc(sp)}" data-tier="${tier}" value="${fmtTime(e?.time)}" inputmode="decimal" autocomplete="off" spellcheck="false" placeholder="–" aria-label="${esc(m.label)}, heat ${hi + 1}, ${esc(tname(sp))} tier ${tier} time"><small class="tres" data-bres="${m.id}|${hi + 1}|${esc(sp)}|${tier}">${e?.time == null ? "" : e.time === "dnf" ? "DNF · 0" : `${ordinal(e.position)} · ${e.points}`}</small></td>`
            : `<td class="num rc${hi === 0 ? " wk-start" : ""}">${e?.time == null ? "–" : `<b>${pts(e.points)}</b><small${e.time === "dnf" ? ' class="dnf"' : ""}>${fmtTime(e.time)}</small>`}</td>`).join("")}
          <td class="num tot">${m.heats.some((h) => h.run) ? sum : "–"}</td>
        </tr>`;
      }).join("");
      return `${pilots}<tr class="bonus-team${m.winner === sp ? " won" : ""}">
          <th class="team-col" scope="row">${esc(tname(sp))}</th>
          ${m.heats.map((h, hi) => `<td class="num${hi === 0 ? " wk-start" : ""}" data-bheat="${m.id}|${hi + 1}|${esc(sp)}">${h.run ? h.score[sp] : "–"}</td>`).join("")}
          <td class="num tot" data-btot="${m.id}|${esc(sp)}">${m.heats.some((h) => h.run) ? m.totals[sp] : "–"}</td>
        </tr>`;
    }).join("");
    return `<div class="bonus-match">${head}
      <div class="table-wrap"><table class="overall grid${edit ? " admin-grid" : ""}">
        <thead><tr><th class="team-col" scope="col">Pilot</th>${m.heats.map((h, hi) => `<th class="num${hi === 0 ? " wk-start" : ""}" scope="col">Heat ${h.heat}</th>`).join("")}<th class="num tot" scope="col">Points</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div></div>`;
  }
  function bonusSection(d, edit = false) {
    const b = d.bonus;
    if (!b) return "";
    if (!b.seeds.length) return `<p class="races-note">${esc(bonusIntro(b))} The top four are seeded once race points are in.</p>`;
    return `<p class="races-note">${esc(bonusIntro(b))}${b.provisional ? " Seeds can still change until every tier has finished its races." : ""}</p>
      ${bonusPlaces(b)}
      ${b.matches.map((m) => bonusMatch(m, b, edit)).join("")}`;
  }

  // ---------- race-day import from Copilot ----------
  const IMPORT_PHASE = {
    scheduled: "Starts at 4:30 PM ET on race day", idle: "Not started yet", waiting: "Waiting for the first heat",
    racing: "Importing heats as they're flown", checking: "Every heat is in; checking against Copilot",
    verified: "Done: every time matches Copilot", blocked: "Blocked (see below)", expired: "Stopped", off: "Off", none: "No race day",
  };
  const clockOf = (iso) => (iso ? timeFmt.format(new Date(iso)) : "–");
  const importIssues = (im) => (im?.flags || []).filter((f) => f.level === "warn" || f.level === "error");

  // Any problem the import found shows at the top of the Races tab.
  function importNotice(im) {
    const issues = importIssues(im);
    if (!issues.length) return "";
    const err = issues.some((f) => f.level === "error");
    return `<div class="notice" data-level="${err ? "error" : "warn"}" role="status"><b>${err ? "Race day issue" : "Race day notice"}</b><ul>${issues.map((f) => `<li>${esc(f.message)}</li>`).join("")}</ul></div>`;
  }
  function importLine(im) {
    if (!im || im.enabled === false || ["none", "off", "scheduled", "idle"].includes(im.phase)) return "";
    if (im.phase === "verified") return ` Times came in from Copilot and were checked against its results${im.check ? ` (all ${im.check.checked})` : ""}.`;
    return ` Times come in from Copilot automatically (last checked ${clockOf(im.lastPollAt)}).`;
  }
  const copilotMeta = (im) => {
    const n = importIssues(im).length;
    return `${esc(im.enabled === false ? "Off" : IMPORT_PHASE[im.phase] || "Not started yet")}${n ? ` · ${n} issue${n === 1 ? "" : "s"}` : ""}`;
  };
  function copilotPanel(im) {
    const flags = im.flags || [];
    const rows = [
      ["Status", im.enabled === false ? "Off" : IMPORT_PHASE[im.phase] || "Not started yet"],
      ["Copilot event", im.event ? `${im.event}${im.selected && im.selected !== im.event ? ` (Copilot has ${im.selected} selected)` : ""}` : "–"],
      ["Last checked", clockOf(im.lastPollAt)],
      ["Last new time", clockOf(im.lastChangeAt)],
      ["Imported", `${im.imported || 0} entries`],
      ["Final check", im.check ? `${im.check.checked} times, ${im.check.differences} different (${clockOf(im.check.at)})` : "After the last heat"],
    ];
    return `<div class="copilot" id="admCopilot">
      <div class="copilot-controls">
        <label class="switch"><input type="checkbox" data-kind="copilot-on"${im.enabled === false ? "" : " checked"}> Auto-import from Copilot</label>
        <button type="button" data-kind="copilot-run">Check now</button>
      </div>
      <dl class="copilot-status">${rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl>
      ${flags.length ? `<ul class="copilot-flags">${flags.map((f) => `<li data-level="${f.level}">${esc(f.message)}</li>`).join("")}</ul>` : `<p class="sit-hint">No issues so far.</p>`}
      <p class="sit-hint">On race day the site checks Copilot once a minute from 4:30 PM ET (races start at 5) and fills in sit-outs and every heat. Anything typed in by hand on this page is kept, even if Copilot differs. It stops once every heat and bonus match is in and matches Copilot's own results.</p>
    </div>`;
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

    // Tiers in race-day order: Tier 4 flies first, Tier 1 last, then the bonus round.
    const tierTables = [...d.tierResults].reverse().map((t) => fold(`tier-${t.tier}`, `Tier ${t.tier}`, tierMeta(t, d), `
        <div class="table-wrap"><table class="overall grid">
          <thead><tr><th class="team-col" scope="col">Team · Pilot</th>${Array.from({ length: d.racesPerTier }, (_, i) => `<th class="num${i === 0 ? " wk-start" : ""}" scope="col">R${i + 1}</th>`).join("")}<th class="num tot" scope="col">Total</th></tr></thead>
          <tbody>${t.entries.map((e) => `<tr>
            <th class="team-col" scope="row"><div class="ocell">${place(e.place)}<span class="oname"><b>${esc(tname(e.sponsor))}</b><small>${pilotLabel(e.pilot)}</small></span></div></th>
            ${e.points.map((p, i) => { const tm = e.times?.[i]; return `<td class="num rc${i === 0 ? " wk-start" : ""}"${tm != null ? ` title="${resultTitle(tm, e.positions[i])}"` : ""}>${tm == null ? pts(p) : `<b>${pts(p)}</b><small${tm === "dnf" ? ' class="dnf"' : ""}>${fmtTime(tm)}</small>`}</td>`; }).join("")}
            <td class="num tot">${pts(e.total)}</td>
          </tr>`).join("")}</tbody>
        </table></div>`)).join("");

    el.innerHTML = `
      <p class="races-note"><b>Race day: ${esc(raceDayText(d))}.</b> Each team races four of its five pilots, one per tier, and sits one. Every tier runs ${d.racesPerTier} races. Points by finishing position: ${pointsLine}. In each tier, a race shows the points earned and the pilot's 3-lap time underneath.${anyResults ? "" : " Lineups and results appear here on race day."}${importLine(d.import)}${d.live ? ' <span class="live-pill">Updates live</span>' : ""}</p>
      ${importNotice(d.import)}
      ${fold("summary", "Team race points", leaderOf(d.teams), summary)}
      ${tierTables}
      ${d.bonus ? fold("bonus", "Bonus round", bonusMeta(d.bonus), bonusSection(d)) : ""}
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

  async function loadStats(quiet = false) {
    const id = state.current;
    if (id == null || isSeasonTab()) return;
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

    // Each team keeps its own league color every week (see TEAM_LOOK).
    const looks = new Map(d.teams.map((t) => [t.sponsor, { color: tcolor(t.sponsor), dash: false }]));
    const swatch = (sp) => { const l = looks.get(sp); return `<i class="sw${l.dash ? " dash" : ""}" style="--c:${l.color}"></i>`; };
    const order = [...d.teams].sort((a, b) => (a.finalTotal ?? 1e9) - (b.finalTotal ?? 1e9));

    el.innerHTML = `
      <p class="races-note">From ${esc(etTime.format(new Date(d.from)))} to ${esc(etTime.format(new Date(d.to)))} Eastern. Team totals are saved every hour. New personal bests count for rostered pilots on the track's required quad.</p>
      <div class="stat-tiles">
        <div class="tile"><b>${d.summary.newBests}</b><span>new personal bests by rostered pilots</span></div>
      </div>

      <section class="chart-card" aria-label="Team totals over time">
        <div class="sec-head"><h2>Team totals over time</h2><span>lower is faster</span></div>
        <div class="legend">${order.map((t) => `<button type="button" data-team="${esc(t.sponsor)}">${swatch(t.sponsor)}${esc(tname(t.sponsor))}</button>`).join("")}</div>
        <div class="chart-box" id="teamChart"></div>
        <p class="sub">Each team's line starts once all five of its pilots have a time. Hover or tap the chart to see every team's total for that hour; hover a team name to pick out its line.</p>
      </section>

      <section class="chart-card" aria-label="When pilots improved">
        <div class="sec-head"><h2>When pilots improved</h2><span>new bests and first times, Eastern time</span></div>
        <div id="heat"></div>
      </section>

      ${d.depth?.length ? `<section class="chart-card depth" aria-label="Team depth">
        <div class="sec-head"><h2>Team depth</h2><span>each pilot's time, by tier</span></div>
        <div class="tier-key">${d.depth[0].pilots.map((_, i) => `<span><i style="background:var(--t${i + 1})"></i>Tier ${i + 1}</span>`).join("")}<span>Spread = slowest − fastest, in seconds</span></div>
        <div class="chart-box" id="depthChart"></div>
        <p class="sub">A pilot's tier is their place on their own team by time${d.tiersAt ? ` at ${esc(etTime.format(new Date(d.tiersAt)))}` : ""}: the team's fastest is Tier 1. A tight spread means a deep team; a wide one means the team leans on its top pilots.</p>
      </section>

      <section class="chart-card" aria-label="By tier">
        <div class="sec-head"><h2>Top of each tier</h2><span>fastest three</span></div>
        <div class="tier-grid">${d.tiers.map((t) => `<div class="tier-card">
          <h3><i style="background:var(--t${t.tier})"></i>Tier ${t.tier}</h3>
          <ol>${t.fastest.map((p, i) => `<li><span>${i + 1}. ${esc(p.pilot)}<small>${esc(tname(p.team))}</small></span><b>${secs(p.time)}</b></li>`).join("") || "<li>No times yet</li>"}</ol>
        </div>`).join("")}</div>
      </section>

      <div class="two-col">
        ${moveList("Most improved: current vs tryout", "faster than their tryout spot", d.sandbaggers, d.leaguePilots, "up")}
        ${moveList("Biggest drops: current vs tryout", "slower than their tryout spot", d.dropoffs, d.leaguePilots, "down")}
      </div>
      <p class="sub">Tryout spot is a pilot's place among the ${d.leaguePilots} league pilots by tryout rank going into the draft; this week is their place among the same pilots by time on this track. Pilots without a time aren't placed.</p>` : ""}

      ${d.pickSandbaggers ? `<div class="two-col">
        ${pickList("Most improved: current vs draft pick", "faster than where they were picked", d.pickSandbaggers, "up")}
        ${pickList("Biggest drops: current vs draft pick", "slower than where they were picked", d.pickDropoffs, "down")}
      </div>
      <p class="sub">Draft # puts the captains first (#1 Raimon Shaigne to #10 BenDaOctopus), then the snake draft's 40 picks as #11–50, so pick 1 is #11. LB # is the pilot's place among the league's pilots by time on this track, the same number the Smash tab shows.</p>` : ""}

      <div class="two-col">
      <section class="chart-card" aria-label="Biggest grinders">
        <div class="sec-head"><h2>Biggest grinders</h2><span>most new personal bests</span></div>
        <table class="stbl"><thead><tr><th class="num">#</th><th>Pilot</th><th class="num">PBs</th><th class="num">Best</th></tr></thead><tbody>
          ${d.grinders.map((p, i) => `<tr><td class="num">${i + 1}</td><td>${esc(p.pilot)}<small>${esc(tname(p.team))}</small></td><td class="num">${p.pbs}</td><td class="num">${secs(p.best)}<small>from ${secs(p.first)}</small></td></tr>`).join("")}
        </tbody></table>
      </section>

      ${d.smallestGrinders?.length ? `<section class="chart-card" aria-label="Smallest grinders">
        <div class="sec-head"><h2>Smallest grinders</h2><span>fewest new personal bests</span></div>
        <table class="stbl"><thead><tr><th class="num">#</th><th>Pilot</th><th class="num">PBs</th><th class="num">Best</th></tr></thead><tbody>
          ${d.smallestGrinders.map((p, i) => `<tr><td class="num">${i + 1}</td><td>${esc(p.pilot)}<small>${esc(tname(p.team))}</small></td><td class="num">${p.pbs}</td><td class="num">${secs(p.best)}<small>${p.pbs ? `from ${secs(p.first)}` : "first time"}</small></td></tr>`).join("")}
        </tbody></table>
        <p class="sub">Rostered pilots with a time on this track, fewest new personal bests first. Level on new bests, the pilot who cut the least time from their first time ranks first.</p>
      </section>` : ""}
      </div>`;

    drawTeamChart(d, looks, swatch);
    drawDepth(d);
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
      ${W >= 520 ? ends.map((e) => `<text class="lbl" data-team="${esc(e.t.sponsor)}" x="${W - m.r + 8}" y="${e.y + 4}">${esc(tname(e.t.sponsor))}</text>`).join("") : ""}
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
      tip.innerHTML = `<b>${esc(etTime.format(new Date(at)))}</b>` + rows.map((r2) => `<div class="${r2.s === near?.s ? "hot" : ""}"><span>${swatch(r2.s)}${esc(tname(r2.s))}</span><span>${r2.posted < r2.size ? `${r2.posted}/${r2.size} posted` : secs(r2.total)}</span></div>`).join("");
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

  // Current LB # vs draft position (captains #1-10, then picks #11-50).
  function pickList(title, sub, list, dir) {
    return `<section class="chart-card" aria-label="${esc(title)}">
      <div class="sec-head"><h2>${esc(title)}</h2><span>${esc(sub)}</span></div>
      <table class="stbl"><thead><tr><th>Pilot</th><th class="num">Draft → LB</th><th class="num">Moved</th></tr></thead><tbody>
        ${list.map((m) => `<tr><td>${esc(m.pilot)}<small>${esc(tname(m.team))} · ${m.captain ? "captain" : `round ${m.round}, pick ${m.pick}`}</small></td><td class="num">#${m.pos} → #${m.lb}<small>${secs(m.time)}</small></td><td class="num mv ${dir}">${dir === "up" ? "▲" : "▼"} ${Math.abs(m.moved)}</td></tr>`).join("") || `<tr><td colspan="3">Nobody yet</td></tr>`}
      </tbody></table>
    </section>`;
  }

  function moveList(title, sub, list, of, dir) {
    return `<section class="chart-card" aria-label="${esc(title)}">
      <div class="sec-head"><h2>${esc(title)}</h2><span>${esc(sub)}</span></div>
      <table class="stbl"><thead><tr><th>Pilot</th><th class="num">Tryout → now</th><th class="num">Moved</th></tr></thead><tbody>
        ${list.map((m) => `<tr><td>${esc(m.pilot)}<small>${esc(tname(m.team))} · tryout #${m.draftRank}</small></td><td class="num">${ordinal(m.draftPlace)} → ${ordinal(m.weekPlace)}<small>${secs(m.time)}</small></td><td class="num mv ${dir}">${dir === "up" ? "▲" : "▼"} ${Math.abs(m.moved)}</td></tr>`).join("") || `<tr><td colspan="3">Nobody yet</td></tr>`}
      </tbody></table>
    </section>`;
  }

  function drawDepth(d) {
    const box = $("depthChart");
    if (!box) return;
    const W = Math.max(300, box.clientWidth || 800), narrow = W < 520;
    const m = { l: narrow ? 92 : 150, r: narrow ? 44 : 64, t: 18, b: 24 }, rowH = 30;
    const H = m.t + m.b + d.depth.length * rowH;
    const all = d.depth.flatMap((t) => t.pilots.map((p) => p.time)).filter((v) => v != null);
    const step = [2, 5, 10, 20].find((k) => (Math.max(...all) - Math.min(...all)) / k <= (narrow ? 4 : 7)) || 50;
    const x0 = Math.floor(Math.min(...all) / step) * step, x1 = Math.ceil(Math.max(...all) / step) * step;
    const X = (v) => m.l + ((v - x0) / Math.max(1, x1 - x0)) * (W - m.l - m.r);
    const ticks = []; for (let v = x0; v <= x1 + 1e-9; v += step) ticks.push(v);
    const short = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
    box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Each team's pilot times by tier">
      <text x="${W - m.r + 8}" y="11">Spread</text>
      ${ticks.map((v) => `<line class="grid" x1="${X(v)}" x2="${X(v)}" y1="${m.t}" y2="${H - m.b}"/><text x="${X(v)}" y="${H - 6}" text-anchor="middle">${v}s</text>`).join("")}
      ${d.depth.map((t, i) => {
        const y = m.t + i * rowH + rowH / 2;
        const ts = t.pilots.map((p) => p.time).filter((v) => v != null);
        return `<text class="tn" x="${m.l - 10}" y="${y + 4}" text-anchor="end">${esc(short(tname(t.sponsor), narrow ? 11 : 20))}</text>
          ${ts.length > 1 ? `<line class="rng" x1="${X(Math.min(...ts))}" x2="${X(Math.max(...ts))}" y1="${y}" y2="${y}"/>` : ""}
          ${[...t.pilots].reverse().map((p) => (p.time == null ? "" : `<circle class="dot" cx="${X(p.time)}" cy="${y}" r="6" fill="var(--t${p.tier})" data-tip="${esc(p.pilot)}|${esc(tname(t.sponsor))}|${p.tier}|${secs(p.time)}"/>`)).join("")}
          <text class="sp" x="${W - m.r + 8}" y="${y + 4}">${t.spread != null ? secs(t.spread, 1) : `${t.posted}/${t.size}`}</text>`;
      }).join("")}
    </svg><div class="tip" id="dtip" hidden></div>`;
    const tip = box.querySelector("#dtip");
    const show = (c) => {
      const [pilot, team, tier, time] = c.dataset.tip.split("|");
      tip.innerHTML = `<b>${pilot}</b><div><span>Team</span><span>${team}</span></div><div><span>Tier</span><span>${tier}</span></div><div><span>Time</span><span>${time}</span></div>`;
      tip.hidden = false;
      const bx = box.getBoundingClientRect(), r = c.getBoundingClientRect();
      const cx = r.left + r.width / 2 - bx.left, wide = tip.offsetWidth;
      tip.style.left = `${Math.max(0, Math.min(cx + 12 + wide <= bx.width ? cx + 12 : cx - wide - 12, bx.width - wide))}px`;
      tip.style.top = `${Math.max(0, Math.min(r.top - bx.top - 8, bx.height - tip.offsetHeight))}px`;
    };
    box.querySelectorAll(".dot").forEach((c) => {
      c.addEventListener("mouseenter", () => show(c));
      c.addEventListener("click", () => show(c));
      c.addEventListener("mouseleave", () => { tip.hidden = true; });
    });
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
  window.addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (state.view === "stats" && state.stats?.data && !$("viewStats").hidden) renderStats(); if (state.view === "racestats" && state.races?.data) renderRaceStats(); }, 200); });

  // ---------- race stats ----------
  // Times at or above this are placeholders (e.g. 999 for a pilot who didn't fly a heat):
  // they still finish last for points but don't count as real heat times.
  const PLACEHOLDER_TIME = 900;
  const realTime = (t) => typeof t === "number" && t < PLACEHOLDER_TIME;

  function raceStatsData(d) {
    const smash = new Map((state.data?.standings?.teams || []).flatMap((t) => t.pilots.filter((p) => p.posted).map((p) => [p.name, p.time])));
    const pilots = d.tierResults.flatMap((tr) => tr.entries.filter((e) => e.pilot).map((e) => {
      const heats = e.times.map((t, i) => ({ race: i + 1, time: t, pos: e.positions[i] })).filter((h) => h.time != null);
      const real = heats.filter((h) => realTime(h.time)).map((h) => h.time);
      const mean = real.length ? real.reduce((a, b) => a + b, 0) / real.length : null;
      const finishes = heats.map((h) => h.pos).filter((p) => p > 0);
      return {
        tier: tr.tier, pilot: e.pilot, team: e.sponsor, points: e.total, heats, real, mean,
        sd: real.length >= 4 ? Math.sqrt(real.reduce((a, b) => a + (b - mean) ** 2, 0) / real.length) : null,
        best: real.length ? Math.min(...real) : null,
        worst: real.length ? Math.max(...real) : null,
        wins: heats.filter((h) => h.pos === 1).length,
        avgFinish: finishes.length ? finishes.reduce((a, b) => a + b, 0) / finishes.length : null,
        smash: smash.get(e.pilot) ?? null,
      };
    }));
    return {
      pilots,
      wins: pilots.filter((p) => p.wins >= 2).sort((a, b) => b.wins - a.wins || a.tier - b.tier),
      // Each pilot's single best heat, so one pilot can't fill the list.
      fastest: pilots.filter((p) => p.best != null).map((p) => ({ ...p, race: p.heats.find((h) => h.time === p.best).race, time: p.best })).sort((a, b) => a.time - b.time).slice(0, 10),
      consistent: pilots.filter((p) => p.sd != null).sort((a, b) => a.sd - b.sd).slice(0, 10),
      over: pilots.filter((p) => p.best != null && p.smash != null && p.best < p.smash).map((p) => ({ ...p, beat: p.smash - p.best })).sort((a, b) => b.beat - a.beat).slice(0, 10),
      mvps: d.tierResults.map((tr) => ({ tier: tr.tier, top: tr.entries.filter((e) => e.total != null && e.pilot).slice(0, 3).map((e) => pilots.find((p) => p.tier === tr.tier && p.team === e.sponsor)) })),
    };
  }

  function renderRaceStats() {
    const el = $("viewRaceStats");
    if (el.hidden && state.view !== "racestats") return;
    const r = state.races;
    if (!r || (!r.data && !r.error)) { el.innerHTML = `<div class="empty">Loading race stats…</div>`; return; }
    if (!r.data) { el.innerHTML = `<div class="empty">Couldn't load race results (${esc(r.error)}).</div>`; return; }
    const d = r.data;
    if (!d.tierResults.some((t) => t.racesRun)) { el.innerHTML = `<div class="empty">Race stats appear once race day results are entered.</div>`; return; }
    const s = raceStatsData(d);
    const who = (p, extra = "") => `${esc(p.pilot)}<small>${esc(tname(p.team))} · Tier ${p.tier}${extra}</small>`;
    const list = (title, sub, head, rows, empty) => `<section class="chart-card" aria-label="${esc(title)}">
        <div class="sec-head"><h2>${esc(title)}</h2><span>${esc(sub)}</span></div>
        <table class="stbl"><thead><tr><th>Pilot</th>${head.map((h) => `<th class="num">${h}</th>`).join("")}</tr></thead><tbody>
          ${rows || `<tr><td colspan="${head.length + 1}">${empty}</td></tr>`}
        </tbody></table></section>`;

    el.innerHTML = `
      <p class="races-note">${esc(raceDayText(d))} · ${d.tiers} tiers, ${d.racesPerTier} races each. Points per race go ${d.points[0]} down to ${d.points[d.points.length - 1]} by finishing place in the tier. Times of ${PLACEHOLDER_TIME}s or more (like a 999 for a heat not flown) still finish last but aren't counted as heat times below. Only the tier races count here: bonus round heats and bonus points are left out.</p>

      <section class="chart-card" aria-label="Points by tier">
        <div class="sec-head"><h2>Points by tier</h2><span>where each team's race points came from</span></div>
        <div class="tier-key">${d.tierResults.map((t) => `<span><i style="background:var(--t${t.tier})"></i>Tier ${t.tier}</span>`).join("")}</div>
        <div class="chart-box" id="tierPointsChart"></div>
      </section>

      <section class="chart-card" aria-label="Tier MVPs">
        <div class="sec-head"><h2>Tier MVPs</h2><span>most points in each tier</span></div>
        <div class="tier-grid">${s.mvps.map((m) => `<div class="tier-card">
          <h3><i style="background:var(--t${m.tier})"></i>Tier ${m.tier}</h3>
          <ol>${m.top.map((p, i) => `<li><span>${i + 1}. ${esc(p.pilot)}<small>${esc(tname(p.team))}</small></span><b>${p.points} pts</b></li>`).join("") || "<li>No results yet</li>"}</ol>
          ${m.top[0] ? `<p class="sub">${m.top[0].wins} win${m.top[0].wins === 1 ? "" : "s"} · average finish ${m.top[0].avgFinish.toFixed(1)}</p>` : ""}
        </div>`).join("")}</div>
      </section>

      <div class="two-col">
        ${list("Race wins", "pilots with 2 or more", ["Wins"], s.wins.map((p) => `<tr><td>${who(p)}</td><td class="num">${p.wins}</td></tr>`).join(""), "Nobody has won more than one heat")}
        ${list("Fastest heats", "each pilot's best 3-lap heat", ["Race", "Time"], s.fastest.map((p) => `<tr><td>${who(p)}</td><td class="num">${p.race}</td><td class="num">${secs(p.time)}</td></tr>`).join(""), "No heats yet")}
      </div>
      <div class="two-col">
        ${list("Most consistent", "smallest spread across heats", ["Average", "Spread", "Range"], s.consistent.map((p) => `<tr><td>${who(p)}</td><td class="num">${secs(p.mean)}</td><td class="num">±${p.sd.toFixed(2)}</td><td class="num" title="Best ${secs(p.best)} · worst ${secs(p.worst)}">±${((p.worst - p.best) / 2).toFixed(2)}</td></tr>`).join(""), "Needs four heats per pilot")}
        ${list("Race-day overperformers", "best heat faster than their Smash time", ["Best heat", "Beat by"], s.over.map((p) => `<tr><td>${who(p)}</td><td class="num">${secs(p.best)}<small>Smash ${secs(p.smash)}</small></td><td class="num">−${secs(p.beat, 2)}s</td></tr>`).join(""), "Nobody beat their Smash time")}
      </div>
      <p class="sub">Race wins only lists pilots who won 2 or more heats. In Most consistent, Spread is the standard deviation of a pilot's heat times (how far a typical heat lands from their average) and sets the order; Range is half the gap between their best and worst heat. Both need at least four heats.</p>`;
    drawTierPoints(d);
  }

  function drawTierPoints(d) {
    const box = $("tierPointsChart");
    if (!box) return;
    const W = Math.max(300, box.clientWidth || 800), narrow = W < 520;
    const m = { l: narrow ? 96 : 150, r: 44, t: 4, b: 22 }, rowH = 28, barH = 18;
    // Tier races only: bonus round points are left out of Race Stats.
    const teams = d.teams.filter((t) => t.raceTotal != null).sort((a, b) => b.raceTotal - a.raceTotal || a.draft - b.draft);
    const H = m.t + m.b + teams.length * rowH;
    const max = Math.max(1, ...teams.map((t) => t.raceTotal));
    const step = [10, 20, 25, 50, 100].find((k) => max / k <= (narrow ? 4 : 8)) || 200;
    const x1 = Math.ceil(max / step) * step;
    const X = (v) => (v / x1) * (W - m.l - m.r);
    const ticks = []; for (let v = 0; v <= x1; v += step) ticks.push(v);
    const short = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
    const tiers = d.tierResults.map((t) => t.tier);
    box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Each team's race points split by tier">
      ${ticks.map((v) => `<line class="grid" x1="${m.l + X(v)}" x2="${m.l + X(v)}" y1="${m.t}" y2="${H - m.b}"/><text x="${m.l + X(v)}" y="${H - 6}" text-anchor="middle">${v}</text>`).join("")}
      ${teams.map((t, i) => {
        const y = m.t + i * rowH + (rowH - barH) / 2;
        let x = m.l;
        const segs = tiers.map((ti) => {
          const v = t.byTier[ti] || 0, w = X(v);
          const pilot = t.lineup?.[ti] || "";
          const out = v ? `<rect class="seg" x="${x.toFixed(1)}" y="${y}" width="${Math.max(0, w - 2).toFixed(1)}" height="${barH}" rx="2" fill="var(--t${ti})" data-tip="${esc(tname(t.sponsor))}|Tier ${ti}|${esc(pilot)}|${v}"/>` : "";
          x += w;
          return out;
        }).join("");
        return `<text class="tn" x="${m.l - 10}" y="${y + barH / 2 + 4}" text-anchor="end">${esc(short(tname(t.sponsor), narrow ? 11 : 20))}</text>${segs}<text class="sp" x="${x + 4}" y="${y + barH / 2 + 4}">${t.raceTotal}</text>`;
      }).join("")}
    </svg><div class="tip" id="tptip" hidden></div>`;
    const tip = box.querySelector("#tptip");
    const show = (r) => {
      const [team, tier, pilot, v] = r.dataset.tip.split("|");
      tip.innerHTML = `<b>${team}</b><div><span>${tier}</span><span>${v} pts</span></div>${pilot ? `<div><span>Pilot</span><span>${pilot}</span></div>` : ""}`;
      tip.hidden = false;
      const bx = box.getBoundingClientRect(), rr = r.getBoundingClientRect(), wide = tip.offsetWidth;
      const cx = rr.left + rr.width / 2 - bx.left;
      tip.style.left = `${Math.max(0, Math.min(cx - wide / 2, bx.width - wide))}px`;
      tip.style.top = `${Math.max(0, rr.top - bx.top - tip.offsetHeight - 6)}px`;
    };
    box.querySelectorAll(".seg").forEach((r) => {
      r.addEventListener("mouseenter", () => show(r));
      r.addEventListener("click", () => show(r));
      r.addEventListener("mouseleave", () => { tip.hidden = true; });
    });
  }

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
        <label for="sit-${i}"><b>${esc(tname(t.sponsor))}</b></label>
        <select id="sit-${i}" data-kind="sit" data-sponsor="${esc(t.sponsor)}"><option value="">Pick who sits…</option>${options}</select>
        <div class="lineup" data-lineup="${esc(t.sponsor)}">${lineupText(t)}</div>
      </div>`;
    }).join("");
    const picked = d.teams.filter((t) => t.sitting).length;

    const tierTables = [...d.tierResults].reverse().map((t) => {
      const rows = draftSorted(t.entries).map((e) => `<tr>
        <th class="team-col" scope="row"><div class="ocell"><span class="oname"><b>${esc(tname(e.sponsor))}</b><small data-pilot="${t.tier}|${esc(e.sponsor)}">${pilotLabel(e.pilot)}</small></span></div></th>
        ${e.times.map((tm, ri) => `<td class="tcell${ri === 0 ? " wk-start" : ""}">
          <input class="tin" data-kind="time" data-tier="${t.tier}" data-race="${ri + 1}" data-sponsor="${esc(e.sponsor)}" value="${fmtTime(tm)}" inputmode="decimal" autocomplete="off" spellcheck="false" placeholder="–" aria-label="${esc(tname(e.sponsor))}, tier ${t.tier}, race ${ri + 1} time">
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
      ${d.import ? fold("adm-copilot", "Copilot auto-import", copilotMeta(d.import), copilotPanel(d.import)) : ""}
      ${fold("adm-sit", "Who sits out", `${picked} of ${d.teams.length} picked`, `<p class="sit-hint">Pilots are listed in their team's Smash order for this track. The four who race fill Tiers 1–4 in that order.</p><div class="sit-grid">${sitCards}</div>`)}
      ${fold("adm-summary", "Team race points", leaderOf(d.teams), `<div id="admSummary">${raceSummaryTable(d)}</div>`)}
      ${tierTables}
      ${d.bonus ? fold("adm-bonus", "Bonus round", bonusMeta(d.bonus), `<div id="admBonus" data-shape="${bonusShape(d)}">${bonusSection(d, true)}</div>`) : ""}`;
    renderSaveState();
  }

  const bonusShape = (d) => (d.bonus ? d.bonus.matches.map((m) => m.teams.join("+")).join("|") + "|" + d.bonus.seeds.join("+") : "");

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
    const bx = $("admBonus");
    if (bx && d.bonus) {
      if (bx.dataset.shape !== bonusShape(d) && !bx.contains(focused) && !bx.querySelector("[data-dirty]")) {
        bx.dataset.shape = bonusShape(d);
        bx.innerHTML = bonusSection(d, true);
      } else {
        for (const m of d.bonus.matches) {
          for (const h of m.heats) {
            for (const e of h.entries) {
              const k = `${m.id}|${h.heat}|${e.sponsor}|${e.tier}`;
              const inp = bx.querySelector(`input[data-match="${m.id}"][data-heat="${h.heat}"][data-sponsor="${CSS.escape(e.sponsor)}"][data-tier="${e.tier}"]`);
              if (inp && inp !== focused && !inp.dataset.dirty) { inp.value = fmtTime(e.time); inp.classList.remove("bad"); }
              const res = bx.querySelector(`[data-bres="${CSS.escape(k)}"]`);
              if (res) res.textContent = e.time == null ? "" : e.time === "dnf" ? "DNF · 0" : `${ordinal(e.position)} · ${e.points}`;
            }
            for (const sp of m.teams) { const c = bx.querySelector(`[data-bheat="${CSS.escape(`${m.id}|${h.heat}|${sp}`)}"]`); if (c) c.textContent = h.run ? h.score[sp] : "–"; }
          }
          for (const sp of m.teams) { const c = bx.querySelector(`[data-btot="${CSS.escape(`${m.id}|${sp}`)}"]`); if (c && m.totals) c.textContent = m.heats.some((h) => h.run) ? m.totals[sp] : "–"; }
          const sc = bx.querySelector(`[data-bscore="${m.id}"]`);
          if (sc && m.totals) sc.textContent = `${m.totals[m.teams[0]]}–${m.totals[m.teams[1]]}${m.winner ? ` · ${tname(m.winner)} wins${m.decision ? ` (${m.decision})` : ""}` : m.tied ? " · tied" : ""}`;
        }
        const pl = bx.querySelector(".bonus-places");
        const fresh = bonusPlaces(d.bonus);
        if (pl) pl.outerHTML = fresh || "<span></span>";
        else if (fresh) bx.querySelector(".races-note")?.insertAdjacentHTML("afterend", fresh);
      }
      const mb = root.querySelector('[data-meta="adm-bonus"]');
      if (mb) mb.innerHTML = bonusMeta(d.bonus);
    }
    const m1 = root.querySelector('[data-meta="adm-summary"]');
    if (m1) m1.innerHTML = leaderOf(d.teams);
    const cp = root.querySelector("#admCopilot");
    if (cp && d.import && !cp.contains(document.activeElement)) cp.outerHTML = copilotPanel(d.import);
    const mc = root.querySelector('[data-meta="adm-copilot"]');
    if (mc && d.import) mc.innerHTML = copilotMeta(d.import);
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
    } else if (el.dataset.kind === "btime") {
      const t = parseTime(el.value);
      if (t === undefined) {
        el.classList.add("bad");
        el.dataset.dirty = "1";
        el.title = "Use seconds like 45.123 or 1:05.432, or DNF";
        adm.error = `"${el.value}" isn't a race time. Use seconds like 45.123, or DNF.`;
        return renderSaveState();
      }
      el.value = fmtTime(t);
      const v = t === null ? null : t === "dnf" ? "DNF" : String(t);
      saveEdit(`/tracks/${adm.id}/races/bonus`, { results: { [el.dataset.match]: { [el.dataset.heat]: { [el.dataset.sponsor]: { [el.dataset.tier]: v } } } } }, el);
    }
  });
  $("viewAdmin").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.target.dataset?.kind === "time" || e.target.dataset?.kind === "btime")) e.target.blur();
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
  // Copilot auto-import: on/off and "Check now".
  async function copilotAction(body, button) {
    if (button) { button.disabled = true; button.textContent = "Checking…"; }
    try {
      const res = await adminApi(`/tracks/${adm.id}/races/copilot`, { method: "POST", body: JSON.stringify(body) });
      if (res.status === 403) return signedOut("Your sign-in has expired. Please enter the password again.");
      const out = await res.json();
      if (!res.ok) throw new Error(out.error || `HTTP ${res.status}`);
      if (isAdmin()) { adm.error = null; adm.data = { ...out, satBefore: adm.satBefore }; syncAdmin(); renderSaveState(); }
    } catch (err) {
      adm.error = `Couldn't reach the Copilot import (${err.message}).`;
      renderSaveState();
    } finally {
      const b = $("viewAdmin").querySelector('[data-kind="copilot-run"]');
      if (b) { b.disabled = false; b.textContent = "Check now"; }
    }
  }
  $("viewAdmin").addEventListener("click", (e) => {
    const b = e.target.closest?.('[data-kind="copilot-run"]');
    if (b) copilotAction({ run: true }, b);
  });
  $("viewAdmin").addEventListener("change", (e) => {
    if (e.target.dataset?.kind !== "copilot-on") return;
    copilotAction({ enabled: e.target.checked, ...(e.target.checked ? { run: true } : {}) });
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
  const foldState = { summary: true, bonus: true, "adm-copilot": true, "adm-sit": true, "adm-summary": true, "adm-bonus": true };
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
      const res = await api(id === OVERALL ? "/overall" : id === PILOTS ? "/pilots" : `/tracks/${id}`);
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
        if (state.view === "races" && !isSeasonTab()) loadRaces();
        if (state.view === "stats" && !isSeasonTab() && state.data?.track?.status !== "locked") loadStats(true);
      }
    }
  }

  function schedulePoll() {
    clearTimeout(state.pollTimer);
    const d = state.data;
    let wait = null;
    if (state.error) wait = RETRY_MS;
    else if (isSeasonTab()) wait = 10 * 60_000;
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
    if (readPilotsHash()) { state.error = null; return selectTrack(PILOTS); }
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
    if (readPilotsHash()) return selectTrack(PILOTS, true);
    const id = +((location.hash.match(/^#track-(\d+)$/) || [])[1] || 0);
    const t = state.tracks.find((x) => x.id === id);
    if (t && t.status !== "upcoming") selectTrack(id);
  });

  start();
})();

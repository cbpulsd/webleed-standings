// Pilot stats for the Pilots tab: every league pilot's numbers week by week and for the
// season so far, plus the closest battles and records.
//
// Built from what the site already keeps for each locked week:
//   smash   the locked standings ({ teams: [{ sponsor, pilots: [{ name, time, posted }] }] })
//   races   computeRaces() output (tier heats, bonus heats); only once every tier heat is in
//   bests   new personal bests ([{ pilot, at, time }], first time first), up to the lock
//
// Times at or over NO_TIME are placeholders for a heat with no time (999 is typed in for a
// pilot who didn't get one). They still count as a last-place finish, as on the Races tab,
// but are left out of anything worked out from times (averages, spread, best heat, battles).

export const NO_TIME = 900;
const KEEP = 50; // battles and records kept per week and list
const FAST_KEEP = 12; // fastest single heat runs kept per week and tier

const r3 = (n) => Math.round(n * 1000) / 1000;
const r2 = (n) => Math.round(n * 100) / 100;
const timed = (t) => typeof t === "number" && Number.isFinite(t) && t > 0 && t < NO_TIME;
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
// Places with ties sharing the better place: 1 + how many are strictly better.
const places = (list, val) => {
  const vals = list.map(val);
  return list.map((_, i) => 1 + vals.filter((v) => v < vals[i]).length);
};

export function computePilotStats({ weeks, teams, draft }) {
  const roster = [];
  for (const t of teams) for (const name of [t.captain, ...t.pilots]) roster.push({ name, team: t.sponsor, captain: name === t.captain });
  const teamOf = new Map(roster.map((p) => [p.name, p.team]));

  // Tryout place: a pilot's place among the league's own pilots by tryout rank (1 = best).
  const tryoutPlace = new Map();
  const byTryout = roster.filter((p) => draft.ranks[p.name] != null).sort((a, b) => draft.ranks[a.name] - draft.ranks[b.name]);
  byTryout.forEach((p, i) => tryoutPlace.set(p.name, i + 1));
  const draftPos = new Map(draft.order.map((d) => [d.pilot, d.pos]));

  const pilots = new Map(roster.map((p) => [p.name, {
    name: p.name, team: p.team, captain: p.captain,
    tryoutRank: draft.ranks[p.name] ?? null, tryoutPlace: tryoutPlace.get(p.name) ?? null, draftPos: draftPos.get(p.name) ?? null,
    weeks: {},
  }]));

  const battles = { close: [], wins: [], heats: [], smash: [] };
  const records = { fastest: [], margins: [] };
  const weekInfo = [];

  for (const w of weeks) {
    const info = { id: w.id, name: w.name, quad: w.quad || null, lockedAt: w.lockedAt || null, races: false, bonus: false };
    weekInfo.push(info);
    for (const p of pilots.values()) p.weeks[w.id] = { smash: null, race: null, bonus: null };

    // ---- Smash: locked times, league places, new bests ----
    const posted = [];
    for (const t of w.smash?.teams || []) {
      const sorted = [...t.pilots].filter((x) => x.posted && timed(x.time)).sort((a, b) => a.time - b.time);
      for (const x of t.pilots) {
        const p = pilots.get(x.name);
        if (!p) continue;
        const ok = x.posted && timed(x.time);
        p.weeks[w.id].smash = { time: ok ? x.time : null, rank: null, pctOff: null, teamTier: ok ? sorted.indexOf(x) + 1 : null, pbs: 0, log: [] };
        if (ok) posted.push({ name: x.name, team: t.sponsor, time: x.time });
      }
    }
    posted.sort((a, b) => a.time - b.time);
    const fastest = posted[0]?.time;
    places(posted, (x) => x.time).forEach((rank, i) => {
      const s = pilots.get(posted[i].name).weeks[w.id].smash;
      s.rank = rank;
      s.pctOff = r2((posted[i].time / fastest - 1) * 100);
    });
    for (let i = 0; i + 1 < posted.length; i++) {
      battles.smash.push({ week: w.id, pos: i + 1, a: who(posted[i]), b: who(posted[i + 1]), gap: r3(posted[i + 1].time - posted[i].time) });
    }

    const byPilot = new Map();
    for (const e of [...(w.bests || [])].sort((a, b) => a.at - b.at)) {
      if (!pilots.has(e.pilot) || !timed(e.time)) continue;
      if (!byPilot.has(e.pilot)) byPilot.set(e.pilot, []);
      byPilot.get(e.pilot).push(e);
    }
    for (const [name, list] of byPilot) {
      const s = pilots.get(name).weeks[w.id].smash;
      if (!s) continue;
      s.log = list.map((e, i) => ({ at: e.at, time: e.time, prev: i ? list[i - 1].time : null }));
      s.pbs = Math.max(0, list.length - 1); // the first entry is their first time, not a new best
    }

    // ---- Races: only once every tier heat is in ----
    const r = w.races;
    const done = r && r.tierResults?.length && r.tierResults.every((t) => t.racesRun >= (r.racesPerTier || 8));
    if (!done) continue;
    info.races = true;

    const raceTeams = new Map(r.teams.map((t) => [t.sponsor, t]));
    for (const t of r.teams) {
      if (!t.sitting) continue;
      const p = pilots.get(t.sitting);
      if (p) p.weeks[w.id].race = { sat: true };
    }

    const bests = [];
    for (const tier of r.tierResults) {
      for (const e of tier.entries) {
        const p = pilots.get(e.pilot);
        if (!p) continue;
        const heats = e.times.map((t, i) => ({ n: i + 1, time: timed(t) ? t : null, dnf: t === "dnf", pos: e.positions[i] ?? null, pts: e.points[i] ?? 0 }));
        const ts = heats.filter((h) => h.time != null).map((h) => h.time);
        const avg = ts.length ? mean(ts) : null;
        const sd = ts.length > 1 ? Math.sqrt(mean(ts.map((x) => (x - avg) ** 2))) : null;
        const ran = heats.filter((h) => h.pos);
        const team = raceTeams.get(e.sponsor);
        const race = {
          tier: tier.tier, points: e.total, place: e.place, heats,
          wins: heats.filter((h) => h.pos === 1).length,
          podiums: heats.filter((h) => h.pos >= 1 && h.pos <= 3).length,
          avgFinish: ran.length ? r2(mean(ran.map((h) => h.pos))) : null,
          timedHeats: ts.length,
          avgTime: avg != null ? r3(avg) : null,
          best: ts.length ? Math.min(...ts) : null,
          bestHeatRank: null,
          spread: sd != null ? r3(sd) : null,
          spreadPct: sd != null ? r2((sd / avg) * 100) : null,
          range: ts.length > 1 ? r3((Math.max(...ts) - Math.min(...ts)) / 2) : null,
          teamPoints: team?.raceTotal ?? null,
        };
        p.weeks[w.id].race = race;
        if (race.best != null) bests.push({ name: p.name, time: race.best });
      }

      // Battles in this tier's heats: neighbours by finishing time.
      for (let i = 0; i < (r.racesPerTier || 8); i++) {
        const field = tier.entries.filter((e) => timed(e.times[i])).map((e) => ({ name: e.pilot, team: e.sponsor, time: e.times[i] })).sort((a, b) => a.time - b.time);
        const label = `Tier ${tier.tier} · Heat ${i + 1}`;
        pairs(field, { week: w.id, tier: tier.tier, heat: i + 1, label });
        if (field.length === tier.entries.length && field.length > 1) battles.heats.push({ week: w.id, tier: tier.tier, heat: i + 1, label, gap: r3(field[field.length - 1].time - field[0].time), a: who(field[0]), b: who(field[field.length - 1]), field: field.map((x) => [x.name, x.team, x.time]) });
        for (const x of field) records.fastest.push({ week: w.id, tier: tier.tier, heat: i + 1, label, ...who(x), time: x.time });
        if (field.length > 1) records.margins.push({ week: w.id, tier: tier.tier, heat: i + 1, label, a: who(field[0]), b: who(field[1]), gap: r3(field[1].time - field[0].time) });
      }
    }
    bests.sort((a, b) => a.time - b.time);
    places(bests, (x) => x.time).forEach((rank, i) => { pilots.get(bests[i].name).weeks[w.id].race.bestHeatRank = rank; });

    // ---- Bonus round ----
    for (const m of r.bonus?.matches || []) {
      for (const h of m.heats || []) {
        if (!h.run) continue;
        info.bonus = true;
        for (const e of h.entries) {
          const p = pilots.get(e.pilot);
          if (!p) continue;
          const wk = p.weeks[w.id];
          wk.bonus ||= { heats: [], points: 0, wins: 0 };
          wk.bonus.heats.push({ match: m.id, label: m.label, heat: h.heat, time: timed(e.time) ? e.time : null, pos: e.position ?? null, pts: e.points ?? 0 });
          wk.bonus.points += e.points ?? 0;
          if (e.position === 1) wk.bonus.wins++;
        }
        const field = h.entries.filter((e) => timed(e.time)).map((e) => ({ name: e.pilot, team: e.sponsor, time: e.time })).sort((a, b) => a.time - b.time);
        pairs(field, { week: w.id, heat: h.heat, label: `${m.label} · Heat ${h.heat}`, bonus: true });
      }
    }
  }

  function who(x) { return { pilot: x.name, team: x.team ?? teamOf.get(x.name), time: x.time }; }
  function pairs(field, at) {
    for (let i = 0; i + 1 < field.length; i++) {
      const b = { ...at, pos: i + 1, a: who(field[i]), b: who(field[i + 1]), gap: r3(field[i + 1].time - field[i].time) };
      battles.close.push(b);
      if (i === 0) battles.wins.push(b);
    }
  }

  // ---- Season so far ----
  const raceWeeks = weekInfo.filter((w) => w.races).map((w) => w.id);
  for (const p of pilots.values()) p.season = season(p, weekInfo, raceWeeks);

  // Keep the closest few per week (and the biggest margins / fastest heats).
  const trim = (list, by, desc = false) => weekInfo.flatMap((w) => list.filter((x) => x.week === w.id).sort((a, b) => (desc ? by(b) - by(a) : by(a) - by(b))).slice(0, KEEP));
  return {
    weeks: weekInfo,
    pilots: [...pilots.values()],
    battles: { close: trim(battles.close, (x) => x.gap), wins: trim(battles.wins, (x) => x.gap), heats: trim(battles.heats, (x) => x.gap), smash: trim(battles.smash, (x) => x.gap) },
    // Fastest heats: each tier's quickest single runs, kept per week and tier.
    records: { fastest: weekInfo.flatMap((w) => [...new Set(records.fastest.map((x) => x.tier))].sort((a, b) => a - b).flatMap((t) => records.fastest.filter((x) => x.week === w.id && x.tier === t).sort((a, b) => a.time - b.time).slice(0, FAST_KEEP))), margins: trim(records.margins, (x) => x.gap, true) },
  };
}

function season(p, weekInfo, raceWeeks) {
  const wk = weekInfo.map((w) => p.weeks[w.id]);
  const races = raceWeeks.map((id) => p.weeks[id].race).filter((r) => r && !r.sat);
  const sat = raceWeeks.filter((id) => p.weeks[id].race?.sat).length;
  const heats = races.flatMap((r) => r.heats);
  const ran = heats.filter((h) => h.pos);
  const sum = (f) => races.reduce((s, r) => s + (f(r) ?? 0), 0);
  const avgOf = (vals) => (vals.length ? r2(mean(vals)) : null);
  let streak = 0, run = 0;
  for (const h of heats) { run = h.pos === 1 ? run + 1 : 0; streak = Math.max(streak, run); }
  const bonus = wk.map((w) => w.bonus).filter(Boolean);
  const smash = wk.map((w) => w.smash).filter((s) => s && s.rank != null);
  const avgRank = smash.length ? r2(mean(smash.map((s) => s.rank))) : null;
  const allPosted = smash.length === weekInfo.length && weekInfo.length > 0;
  const teamPts = sum((r) => r.teamPoints);
  return {
    weeksRaced: races.length,
    weeksSat: sat,
    points: sum((r) => r.points),
    ptsPerWeek: races.length ? r2(sum((r) => r.points) / races.length) : null,
    heats: ran.length,
    wins: ran.filter((h) => h.pos === 1).length,
    winPct: ran.length ? r2((ran.filter((h) => h.pos === 1).length / ran.length) * 100) : null,
    podiums: ran.filter((h) => h.pos >= 1 && h.pos <= 3).length,
    podiumPct: ran.length ? r2((ran.filter((h) => h.pos >= 1 && h.pos <= 3).length / ran.length) * 100) : null,
    avgFinish: avgOf(ran.map((h) => h.pos)),
    perfectWeeks: races.filter((r) => r.wins === r.heats.length).length,
    streak,
    avgBestHeatRank: avgOf(races.map((r) => r.bestHeatRank).filter((x) => x != null)),
    bestHeatRank: races.some((r) => r.bestHeatRank != null) ? Math.min(...races.map((r) => r.bestHeatRank).filter((x) => x != null)) : null,
    spreadPct: avgOf(races.map((r) => r.spreadPct).filter((x) => x != null)),
    teamShare: teamPts ? r2((sum((r) => r.points) / teamPts) * 100) : null,
    bonusHeats: bonus.reduce((s, b) => s + b.heats.length, 0),
    bonusPoints: bonus.reduce((s, b) => s + b.points, 0),
    bonusWins: bonus.reduce((s, b) => s + b.wins, 0),
    smashWeeks: smash.length,
    avgRank,
    bestRank: smash.length ? Math.min(...smash.map((s) => s.rank)) : null,
    avgPctOff: smash.length ? r2(mean(smash.map((s) => s.pctOff))) : null,
    top10: smash.filter((s) => s.rank <= 10).length,
    smashTotal: allPosted ? r3(smash.reduce((s, x) => s + x.time, 0)) : null,
    pbs: wk.reduce((s, w) => s + (w.smash?.pbs || 0), 0),
    vsDraft: avgRank != null && p.draftPos != null ? r2(p.draftPos - avgRank) : null,
    vsTryout: avgRank != null && p.tryoutPlace != null ? r2(p.tryoutPlace - avgRank) : null,
  };
}

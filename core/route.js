// Route & mode planner for a Seaglider passenger route, scored on real NOAA buoy data.
//
// A Seaglider can float (hull), foil, or fly in ground effect (wing), each with its own speed, energy use
// and sea-state limit. For a departure, the planner picks the route and a mode for every leg to minimise
// door-to-door time subject to battery energy (with reserve) and the sea-state limit of each mode.
// The calibrated planner does not use the wave height observed at departure: it uses an upper quantile of
// the wave height expected when the craft actually reaches each leg, learned from how Hs evolves over
// 0-3 hours at each buoy (empirical ratio quantiles conditioned on the current sea state). The leg-level
// risk is split from a trip-level target (Bonferroni), so P(in-flight downmode) stays near the target.

// Envelope defaults follow REGENT's public figures where they exist: hull to ~3 ft and foil to ~5 ft waves
// (2021 Hawaii briefing), take-off in "sea state 3+" and landing up to sea state 5 (as reported in 2025).
// The wing-borne cruise limit is not public ("always 5-30 ft above wave peak"); 3.0 m Hs is an assumption.
export const DEFAULT_CRAFT = {
  rangeNm: 156, // all-wing range (published Viceroy figure: 180 statute miles)
  reservePct: 0.2,
  harborNm: 2, // foil out of / into each (sheltered) harbor
  takeoffMax: 1.25, // sea state 3 upper bound
  landingMax: 4.0, // sea state 5 upper bound
  modes: {
    wing: { label: 'Wing', speed: 156, hsMax: 3.0, energyPerNm: 1.0 },
    foil: { label: 'Foil', speed: 35, hsMax: 1.5, energyPerNm: 1.6 },
    hull: { label: 'Hull', speed: 12, hsMax: 0.9, energyPerNm: 1.2 },
  },
};
export const MODE_ORDER = ['wing', 'foil', 'hull'];

export const ROUTES = [
  {
    id: 'north', name: 'Honolulu → Kahului (north)', transferH: 0,
    legs: [
      { name: 'Mamala Bay', st: '51211', nm: 12 },
      { name: 'Kaiwi Channel & Molokai north', st: '51202', nm: 48 },
      { name: 'Pailolo / Kahului approach', st: '51205', nm: 38 },
    ],
  },
  {
    id: 'south', name: 'Honolulu → Maalaea (south) + 25 min drive', transferH: 25 / 60,
    legs: [
      { name: 'Mamala Bay', st: '51211', nm: 12 },
      { name: 'Kaiwi Channel', st: '51202', nm: 30 },
      { name: 'Lanai lee & Auau Channel', st: '51213', nm: 52 },
    ],
  },
];

export const T0 = Date.UTC(2023, 0, 1);
export const hourOf = (iso) => Math.round((Date.parse(iso) - T0) / 3600000);
export const isoOf = (k) => new Date(T0 + k * 3600000).toISOString().slice(0, 13) + ':00Z';
export const HST = -10;

// ---------- sea-state growth model ----------
export const BINS = [1.5, 2.2]; // Hs bins: < 1.5, 1.5-2.2, >= 2.2 m
const binOf = (hs) => (hs < BINS[0] ? 0 : hs < BINS[1] ? 1 : 2);

// For each station and lead time (0..maxLead hours), sorted ratios Hs(t+d)/Hs(t) per current-Hs bin.
export function fitGrowth(data, fromHour, toHour, maxLead = 4) {
  const model = {};
  for (const [st, s] of Object.entries(data.stations)) {
    model[st] = [];
    for (let d = 0; d <= maxLead; d++) {
      const bins = [[], [], []];
      for (let k = fromHour; k + d < toHour; k++) {
        const a = s.hs[k], b = s.hs[k + d];
        if (a === null || b === null || a <= 0) continue;
        bins[binOf(a)].push(b / a);
      }
      bins.forEach((b) => b.sort((x, y) => x - y));
      model[st].push(bins);
    }
  }
  return model;
}
export function ratioQuantile(model, st, lead, hs, q) {
  const d = Math.min(model[st].length - 1, Math.max(0, Math.round(lead)));
  let arr = model[st][d][binOf(hs)];
  if (arr.length < 50) arr = model[st][d].flat().sort((x, y) => x - y);
  const i = Math.min(arr.length - 1, Math.max(0, Math.ceil(q * arr.length) - 1));
  return arr[i];
}

// ---------- planning ----------
function legTimes(route, modes, craft) {
  const out = [];
  let t = craft.harborNm / craft.modes.foil.speed;
  route.legs.forEach((leg, i) => {
    const dt = leg.nm / craft.modes[modes[i]].speed;
    out.push({ start: t, mid: t + dt / 2, end: t + dt });
    t += dt;
  });
  return { legs: out, total: t + craft.harborNm / craft.modes.foil.speed };
}
export function energyOf(route, modes, craft) {
  return route.legs.reduce((s, leg, i) => s + leg.nm * craft.modes[modes[i]].energyPerNm, 0) + 2 * craft.harborNm * craft.modes.foil.energyPerNm;
}
export function wingContiguous(modes) {
  const first = modes.indexOf('wing'), last = modes.lastIndexOf('wing');
  if (first < 0) return true;
  for (let i = first; i <= last; i++) if (modes[i] !== 'wing') return false;
  return true;
}
function* modeCombos(n) {
  const idx = new Array(n).fill(0);
  while (true) {
    yield idx.map((i) => MODE_ORDER[i]);
    let p = n - 1;
    while (p >= 0 && idx[p] === MODE_ORDER.length - 1) { idx[p] = 0; p--; }
    if (p < 0) return;
    idx[p]++;
  }
}

// policy: { kind: 'naive' } uses Hs observed at departure for every leg
//         { kind: 'margin', m } observed + m metres
//         { kind: 'calibrated', risk } upper quantile of Hs at the time each leg is flown
export function plan(data, growth, hour, policy, craft = DEFAULT_CRAFT, routes = ROUTES) {
  let best = null;
  const usable = craft.rangeNm * (1 - craft.reservePct);
  for (const route of routes) {
    const obs = route.legs.map((l) => data.stations[l.st].hs[hour]);
    if (obs.some((v) => v === null)) continue;
    const q = policy.kind === 'calibrated' ? (policy.legQ ?? 1 - policy.risk / route.legs.length) : null;
    for (const modes of modeCombos(route.legs.length)) {
      if (!wingContiguous(modes)) continue;
      if (energyOf(route, modes, craft) > usable) continue;
      const lt = legTimes(route, modes, craft);
      let ok = true;
      const pred = [];
      route.legs.forEach((leg, i) => {
        let hs = obs[i];
        if (policy.kind === 'margin') hs += policy.m;
        if (policy.kind === 'calibrated') {
          // worst case over the hours the leg spans
          let w = 0;
          for (let d = Math.floor(lt.legs[i].start); d <= Math.ceil(lt.legs[i].end); d++) w = Math.max(w, obs[i] * ratioQuantile(growth, leg.st, d, obs[i], q));
          hs = w;
        }
        pred.push(hs);
        if (hs > craft.modes[modes[i]].hsMax) ok = false;
        // take-off happens at the start of the first wing leg, landing at the end of the last one
        if (modes[i] === 'wing' && (i === 0 || modes[i - 1] !== 'wing') && hs > craft.takeoffMax) ok = false;
        if (modes[i] === 'wing' && (i === modes.length - 1 || modes[i + 1] !== 'wing') && hs > craft.landingMax) ok = false;
      });
      if (!ok) continue;
      const doorH = lt.total + route.transferH;
      if (!best || doorH < best.doorH - 1e-9) best = { route, modes, doorH, blockH: lt.total, pred, obs, energy: energyOf(route, modes, craft) };
    }
  }
  return best; // null = cancel
}

// Fly a plan against what the sea actually did. If a leg's real Hs exceeds the planned mode's limit,
// the craft drops to the fastest mode the real sea allows (a disruption). If the battery cannot
// cover the slower leg(s) even using the reserve, the flight diverts or returns.
export function fly(data, hour, p, craft = DEFAULT_CRAFT) {
  const modes = [...p.modes];
  let t = craft.harborNm / craft.modes.foil.speed;
  let downmodes = 0, flying = false, landed = false;
  const actual = [];
  const water = (hs) => ['foil', 'hull'].find((m) => craft.modes[m].hsMax >= hs);
  for (let i = 0; i < p.route.legs.length; i++) {
    const leg = p.route.legs[i];
    const s = data.stations[leg.st].hs;
    const dtPlanned = leg.nm / craft.modes[modes[i]].speed;
    let hs = 0;
    for (let d = Math.floor(t); d <= Math.ceil(t + dtPlanned); d++) { const v = s[hour + d]; if (v !== null && v !== undefined) hs = Math.max(hs, v); }
    actual.push(hs);
    if (modes[i] === 'wing') {
      const canTakeOff = !landed && hs <= craft.takeoffMax;
      if ((flying || canTakeOff) && hs <= craft.modes.wing.hsMax) {
        flying = true;
      } else {
        // could not take off, or had to come down: continue on the water if the sea allows it
        if (flying && hs > craft.landingMax) return { completed: false, diverted: true, downmodes: downmodes + 1, actual, modes };
        const alt = water(hs);
        if (!alt) return { completed: false, diverted: true, downmodes: downmodes + 1, actual, modes };
        if (flying) landed = true;
        flying = false; modes[i] = alt; downmodes++;
      }
    } else {
      if (flying) { flying = false; landed = true; }
      if (hs > craft.modes[modes[i]].hsMax) {
        const alt = water(hs);
        if (!alt) return { completed: false, diverted: true, downmodes: downmodes + 1, actual, modes };
        if (alt !== modes[i]) { modes[i] = alt; downmodes++; }
      }
    }
    t += leg.nm / craft.modes[modes[i]].speed;
  }
  const energy = energyOf(p.route, modes, craft);
  if (energy > craft.rangeNm) return { completed: false, diverted: true, downmodes, actual, modes };
  const blockH = t + craft.harborNm / craft.modes.foil.speed;
  return { completed: true, diverted: false, downmodes, actual, modes, blockH, doorH: blockH + p.route.transferH, energy, delayH: blockH - p.blockH };
}

// Schedule: departures every hour 06:00-19:00 Hawaii time.
export function departures(data, fromHour, toHour, routes = ROUTES) {
  const need = [...new Set(routes.flatMap((r) => r.legs.map((l) => l.st)))];
  const out = [];
  for (let k = fromHour; k < toHour - 6; k++) {
    const local = (((k + HST) % 24) + 24) % 24;
    if (local < 6 || local > 19) continue;
    // score only departures where every buoy reports for the departure and the next 6 hours
    let ok = true;
    for (const st of need) for (let d = 0; d <= 6 && ok; d++) if (data.stations[st].hs[k + d] === null) ok = false;
    if (ok) out.push(k);
  }
  return out;
}

export function evaluate(data, growth, hours, policy, craft = DEFAULT_CRAFT, routes = ROUTES) {
  let dispatched = 0, completed = 0, disrupted = 0, diverted = 0, doorSum = 0, delaySum = 0, south = 0;
  const cancelReason = { takeoff: 0, cruise: 0, other: 0 };
  const byMonth = Array.from({ length: 12 }, () => ({ n: 0, done: 0 }));
  const byHour = Array.from({ length: 24 }, () => ({ n: 0, done: 0 }));
  const grid = Array.from({ length: 12 }, () => Array.from({ length: 24 }, () => ({ n: 0, done: 0 })));
  for (const k of hours) {
    const date = new Date(T0 + (k + HST) * 3600000);
    const mo = date.getUTCMonth(), hr = date.getUTCHours();
    byMonth[mo].n++; byHour[hr].n++; grid[mo][hr].n++;
    const p = plan(data, growth, k, policy, craft, routes);
    if (!p) {
      // which limit binds? relax take-off first, then the wing-borne cruise limit
      if (plan(data, growth, k, policy, { ...craft, takeoffMax: 99 }, routes)) cancelReason.takeoff++;
      else if (plan(data, growth, k, policy, { ...craft, takeoffMax: 99, modes: { ...craft.modes, wing: { ...craft.modes.wing, hsMax: 99 } } }, routes)) cancelReason.cruise++;
      else cancelReason.other++;
      continue;
    }
    dispatched++;
    if (p.route.id === 'south') south++;
    const f = fly(data, k, p, craft);
    if (f.downmodes > 0 || f.diverted) disrupted++;
    if (f.diverted) { diverted++; continue; }
    completed++; doorSum += f.doorH; delaySum += f.delayH;
    byMonth[mo].done++; byHour[hr].done++; grid[mo][hr].done++;
  }
  const n = hours.length;
  return {
    n, dispatched, completed, disrupted, diverted, south, cancelReason,
    dispatchRate: dispatched / n, completionRate: completed / n,
    disruptionRate: dispatched ? disrupted / dispatched : 0,
    meanDoorH: completed ? doorSum / completed : null, meanDelayH: completed ? delaySum / completed : null,
    byMonth, byHour, grid,
  };
}

// Tune the leg-level quantile on a held-out year so the realised in-flight downmode rate matches the
// trip-level target (the Bonferroni split is conservative because legs and hours are correlated).
export function tuneLegQuantile(data, growth, hours, target, craft = DEFAULT_CRAFT, routes = ROUTES) {
  let lo = 0.5, hi = 0.9999, best = hi;
  for (let it = 0; it < 18; it++) {
    const mid = (lo + hi) / 2;
    const e = evaluate(data, growth, hours, { kind: 'calibrated', legQ: mid }, craft, routes);
    if (e.disruptionRate <= target) { best = mid; hi = mid; } else lo = mid;
  }
  return best;
}

import * as R from './core/route.js';

const $ = (id) => document.getElementById(id);
const pct = (v, d = 1) => (v * 100).toFixed(d) + '%';
const hm = (h) => { const m = Math.round(h * 60); return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`; };
const S = { data: null, growth: null, tune: null, test: null, res: null, heatTab: 'planner', dep: 0 };

// approximate island outlines (lat, lon) for the schematic
const ISLANDS = {
  Oahu: [[21.71, -157.98], [21.58, -157.92], [21.46, -157.83], [21.36, -157.71], [21.29, -157.65], [21.26, -157.70], [21.25, -157.82], [21.30, -157.95], [21.29, -158.10], [21.38, -158.15], [21.53, -158.23], [21.58, -158.27], [21.68, -158.08]],
  Molokai: [[21.22, -157.30], [21.17, -157.24], [21.08, -157.30], [21.09, -157.10], [21.05, -156.90], [21.08, -156.72], [21.14, -156.71], [21.17, -156.90], [21.20, -157.05]],
  Lanai: [[20.92, -157.00], [20.83, -157.06], [20.74, -156.96], [20.74, -156.85], [20.82, -156.81], [20.90, -156.85]],
  Maui: [[21.03, -156.64], [20.94, -156.69], [20.81, -156.65], [20.79, -156.56], [20.86, -156.50], [20.95, -156.48], [20.90, -156.40], [20.94, -156.22], [20.86, -156.00], [20.75, -155.98], [20.62, -156.13], [20.58, -156.42], [20.70, -156.45], [20.80, -156.48], [20.82, -156.55]],
  Kahoolawe: [[20.60, -156.70], [20.54, -156.68], [20.51, -156.56], [20.57, -156.54]],
};
const PATHS = {
  north: [[[21.30, -157.87], [21.25, -157.80], [21.27, -157.68]], [[21.27, -157.68], [21.26, -157.35], [21.25, -157.00], [21.22, -156.78]], [[21.22, -156.78], [21.07, -156.62], [20.90, -156.47]]],
  south: [[[21.30, -157.87], [21.25, -157.80], [21.20, -157.62]], [[21.20, -157.62], [21.02, -157.32], [20.95, -157.08]], [[20.95, -157.08], [20.93, -156.86], [20.86, -156.70], [20.79, -156.51]]],
};
const BUOYS = { '51211': [21.297, -157.959], '51202': [21.417, -157.668], '51213': [20.750, -157.002], '51205': [21.018, -156.425] };
const MODE_COL = { wing: '#00a9e0', foil: '#27647f', hull: '#f0652f' };

async function main() {
  const data = await (await fetch('data/seastate.json')).json();
  S.data = data;
  const h24 = R.hourOf('2024-01-01T00:00Z'), h25 = R.hourOf('2025-01-01T00:00Z');
  S.growth = R.fitGrowth(data, 0, h24);
  S.tune = R.departures(data, h24, h25);
  S.test = R.departures(data, h25, data.hours);
  // replay pickers
  const days = [...new Set(S.test.map((k) => R.isoOf(k + R.HST).slice(0, 10)))];
  $('daySel').innerHTML = days.map((d) => `<option>${d}</option>`).join('');
  const q = new URLSearchParams(location.search);
  const startDay = q.get('day') && days.includes(q.get('day')) ? q.get('day') : (days.includes('2025-01-02') ? '2025-01-02' : days[0]);
  $('daySel').value = startDay;
  $('daySel').onchange = () => { fillHours(); replay(); };
  $('hourSel').onchange = replay;
  $('prevBtn').onclick = () => step(-1);
  $('nextBtn').onclick = () => step(1);
  fillHours(q.get('hour') || (startDay === '2025-01-02' ? '12' : null));
  for (const id of ['riskSel', 'tkoSel', 'wingSel', 'foilSel']) $(id).addEventListener('change', run);
  $('tkoSel').oninput = labels; $('wingSel').oninput = labels; $('foilSel').oninput = labels;
  $('heatTabs').innerHTML = [['planner', 'Planner'], ['wing', 'Wing-only, direct']].map(([k, l]) => `<button class="rg-tab ${k === S.heatTab ? 'is-active' : ''}" data-k="${k}">${l}</button>`).join('');
  $('heatTabs').querySelectorAll('.rg-tab').forEach((b) => b.addEventListener('click', () => { S.heatTab = b.dataset.k; $('heatTabs').querySelectorAll('.rg-tab').forEach((x) => x.classList.toggle('is-active', x === b)); renderHeat(); }));
  labels();
  run();
}

function labels() { $('tkoVal').textContent = (+$('tkoSel').value).toFixed(2) + ' m'; $('wingVal').textContent = (+$('wingSel').value).toFixed(2) + ' m'; $('foilVal').textContent = (+$('foilSel').value).toFixed(2) + ' m'; }

function craft() {
  const c = structuredClone(R.DEFAULT_CRAFT);
  c.takeoffMax = +$('tkoSel').value;
  c.modes.wing.hsMax = +$('wingSel').value;
  c.modes.foil.hsMax = +$('foilSel').value;
  return c;
}
function wingOnly(c) {
  const w = structuredClone(c);
  w.modes.foil.hsMax = -1; w.modes.hull.hsMax = -1;
  return w;
}

function run() {
  const c = craft(), risk = +$('riskSel').value;
  const legQ = R.tuneLegQuantile(S.data, S.growth, S.tune, risk, c);
  const planner = { kind: 'calibrated', legQ };
  const res = {
    legQ, risk, craft: c, planner,
    plan: R.evaluate(S.data, S.growth, S.test, planner, c),
    wing: R.evaluate(S.data, S.growth, S.test, { kind: 'naive' }, wingOnly(c), [R.ROUTES[0]]),
    direct: R.evaluate(S.data, S.growth, S.test, planner, c, [R.ROUTES[0]]),
    margin: R.evaluate(S.data, S.growth, S.test, { kind: 'margin', m: 0.2 }, c),
    naive: R.evaluate(S.data, S.growth, S.test, { kind: 'naive' }, c),
  };
  // fixed margin with the same (or lower) in-flight mode-drop rate as the planner
  for (let m = 0; m <= 0.8 + 1e-9; m += 0.05) {
    const e = R.evaluate(S.data, S.growth, S.test, { kind: 'margin', m }, c);
    if (e.disruptionRate <= res.plan.disruptionRate + 1e-9) { res.matched = { m, e }; break; }
  }
  S.res = res;
  renderKpis(); renderHeat(); renderCmp(); replay();
}

function renderKpis() {
  const { plan, wing, direct, risk } = S.res;
  $('kpis').innerHTML = `
    <div class="rg-kpi rg-kpi--dark"><div class="rg-kpi__label">Departures completed</div><div class="rg-kpi__value">${pct(plan.completionRate)}</div><div class="rg-kpi__cmp">of ${plan.n.toLocaleString()} scheduled in 2025 &middot; wing-only on the direct route: <b>${pct(wing.completionRate)}</b></div></div>
    <div class="rg-kpi"><div class="rg-kpi__label">In-flight mode drops</div><div class="rg-kpi__value">${pct(plan.disruptionRate, 2)}</div><div class="rg-kpi__cmp">target ${pct(risk, 1)}, tuned on 2024 only &middot; ${plan.diverted} diversions</div></div>
    <div class="rg-kpi"><div class="rg-kpi__label">Fixed safety margin, same mode-drop rate</div><div class="rg-kpi__value">${S.res.matched ? pct(S.res.matched.e.completionRate) : '-'}</div><div class="rg-kpi__cmp">${S.res.matched ? `+${S.res.matched.m.toFixed(2)} m on every leg, ${pct(S.res.matched.e.disruptionRate, 2)} drops` : ''} &middot; planner door to door ${hm(plan.meanDoorH)}</div></div>
    <div class="rg-kpi"><div class="rg-kpi__label">Cancellations caused by take-off sea state</div><div class="rg-kpi__value">${pct(plan.cancelReason.takeoff / Math.max(1, plan.n - plan.dispatched), 0)}</div><div class="rg-kpi__cmp">${plan.n - plan.dispatched} cancelled &middot; cruise limit: ${plan.cancelReason.cruise} &middot; south route used ${pct(plan.south / Math.max(1, plan.dispatched), 0)}</div></div>`;
}

function renderHeat() {
  const e = S.heatTab === 'planner' ? S.res.plan : S.res.wing;
  const W = 520, H = 250, L = 34, T = 8, cw = (W - L - 6) / 14, ch = (H - T - 30) / 12;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const col = (r) => {
    // white -> sky -> dark blue
    const a = [255, 255, 255], b = [0, 169, 224], c = [0, 43, 73];
    const t = Math.max(0, Math.min(1, r));
    const mix = (p, q, s) => p.map((v, i) => Math.round(v + (q[i] - v) * s));
    const rgb = t < 0.6 ? mix(a, b, t / 0.6) : mix(b, c, (t - 0.6) / 0.4);
    return `rgb(${rgb.join(',')})`;
  };
  let g = '';
  for (let m = 0; m < 12; m++) {
    g += `<text x="${L - 6}" y="${T + m * ch + ch / 2 + 4}" text-anchor="end">${months[m]}</text>`;
    for (let h = 6; h <= 19; h++) {
      const cell = e.grid[m][h];
      if (!cell.n) { g += `<rect x="${L + (h - 6) * cw + 1}" y="${T + m * ch + 1}" width="${cw - 2}" height="${ch - 2}" rx="3" fill="#eef1f3"/>`; continue; }
      const r = cell.done / cell.n;
      g += `<rect x="${L + (h - 6) * cw + 1}" y="${T + m * ch + 1}" width="${cw - 2}" height="${ch - 2}" rx="3" fill="${col(r)}"><title>${months[m]} ${h}:00 HST: ${cell.done}/${cell.n} completed</title></rect>`;
      if (r < 0.995) g += `<text x="${L + (h - 6) * cw + cw / 2}" y="${T + m * ch + ch / 2 + 4}" text-anchor="middle" style="fill:${r > 0.75 ? '#fff' : '#0d2236'};font-size:9.5px">${Math.round(r * 100)}</text>`;
    }
  }
  for (let h = 6; h <= 19; h += 1) g += `<text x="${L + (h - 6) * cw + cw / 2}" y="${H - 14}" text-anchor="middle">${h}</text>`;
  g += `<text x="${(L + W) / 2}" y="${H - 1}" text-anchor="middle">Departure hour (HST). Numbers: % completed when below 100. Gray: Pauwela buoy offline.</text>`;
  $('heat').innerHTML = `<svg viewBox="0 0 ${W} ${H}">${g}</svg>`;
}

function renderCmp() {
  const { plan, wing, direct, margin, naive, risk } = S.res;
  const rows = [
    ['Wing-only, direct route', wing], ['Any mode, direct route (planner)', direct], ['Both routes, observed Hs (no margin)', naive], ['Both routes, fixed +0.2 m margin', margin], ...(S.res.matched ? [[`Both routes, fixed +${S.res.matched.m.toFixed(2)} m (same drop rate)`, S.res.matched.e]] : []), [`Planner (both routes, ${pct(risk, 1)} target)`, plan, true],
  ];
  $('cmpTable').innerHTML = `<thead><tr><th>2025, ${plan.n.toLocaleString()} departures</th><th>Completed</th><th>Mode drops</th><th>Door to door</th></tr></thead><tbody>${rows.map(([n, e, us]) => `<tr class="${us ? 'is-us' : ''}"><td>${n}</td><td>${pct(e.completionRate)}</td><td>${pct(e.disruptionRate, 2)}</td><td>${e.meanDoorH ? hm(e.meanDoorH) : '-'}</td></tr>`).join('')}</tbody>`;
}

function fillHours(want) {
  const day = $('daySel').value;
  const ks = S.test.filter((k) => R.isoOf(k + R.HST).slice(0, 10) === day);
  $('hourSel').innerHTML = ks.map((k) => `<option value="${k}">${R.isoOf(k + R.HST).slice(11, 16)} HST</option>`).join('');
  if (want) { const k = ks.find((x) => R.isoOf(x + R.HST).slice(11, 13) === String(want).padStart(2, '0')); if (k) $('hourSel').value = k; }
}
function step(d) {
  const k = +$('hourSel').value;
  const i = S.test.indexOf(k) + d;
  if (i < 0 || i >= S.test.length) return;
  const nk = S.test[i];
  $('daySel').value = R.isoOf(nk + R.HST).slice(0, 10);
  fillHours();
  $('hourSel').value = nk;
  replay();
}

function project(lat, lon) {
  const x0 = -158.3, x1 = -155.95, y0 = 21.75, y1 = 20.45, W = 560, H = 250;
  return [((lon - x0) / (x1 - x0)) * W, ((lat - y0) / (y1 - y0)) * H];
}

function replay() {
  const k = +$('hourSel').value;
  const c = S.res.craft;
  const p = R.plan(S.data, S.growth, k, S.res.planner, c);
  const f = p ? R.fly(S.data, k, p, c) : null;
  let g = `<rect width="560" height="250" fill="#002b49"/>`;
  for (const [name, pts] of Object.entries(ISLANDS)) {
    const d = pts.map(([la, lo], i) => (i ? 'L' : 'M') + project(la, lo).map((v) => v.toFixed(1)).join(',')).join(' ') + 'Z';
    g += `<path d="${d}" fill="#0b506d" stroke="#27647f"/>`;
    const cx = pts.reduce((s, q) => s + q[0], 0) / pts.length, cy = pts.reduce((s, q) => s + q[1], 0) / pts.length;
    const [x, y] = project(cx, cy);
    if (name !== 'Kahoolawe') g += `<text x="${x}" y="${y + 4}" text-anchor="middle" style="fill:#88dbdf;font-size:11px;font-weight:600">${name}</text>`;
  }
  for (const r of R.ROUTES) {
    const chosen = p && p.route.id === r.id;
    PATHS[r.id].forEach((seg, i) => {
      const pts = seg.map(([la, lo]) => project(la, lo).map((v) => v.toFixed(1)).join(',')).join(' ');
      const mode = chosen ? (f && f.modes ? f.modes[i] : p.modes[i]) : null;
      g += `<polyline points="${pts}" fill="none" stroke="${chosen ? MODE_COL[mode] : 'rgba(255,255,255,.22)'}" stroke-width="${chosen ? 4 : 2}" stroke-linecap="round" ${chosen ? '' : 'stroke-dasharray="4 5"'}/>`;
    });
  }
  for (const [st, [la, lo]] of Object.entries(BUOYS)) {
    const [x, y] = project(la, lo);
    const hs = S.data.stations[st].hs[k];
    const below = st === '51213';
    g += `<circle cx="${x}" cy="${y}" r="5" fill="#fff" stroke="#00a9e0" stroke-width="2"/><text x="${x + (below ? 0 : 8)}" y="${y + (below ? 18 : -6)}" text-anchor="${below ? 'middle' : 'start'}" style="fill:#fff;font-size:10.5px">${st} · ${hs === null ? 'n/a' : hs.toFixed(2) + ' m'}</text>`;
  }
  g += `<g transform="translate(14 222)">${Object.entries(MODE_COL).map(([m, col], i) => `<rect x="${i * 70}" y="0" width="14" height="4" y="5" fill="${col}"/><text x="${i * 70 + 18}" y="9" style="fill:#cfe1ea;font-size:11px">${m[0].toUpperCase() + m.slice(1)}</text>`).join('')}</g>`;
  $('map').innerHTML = `<svg viewBox="0 0 560 250">${g}</svg>`;
  if (!p) {
    $('legTable').innerHTML = '';
    $('replayNote').innerHTML = 'Cancelled: no route and mode combination clears the sea-state limits with enough battery.';
    return;
  }
  const badge = (m) => `<span class="rg-mode rg-mode--${m}">${m[0].toUpperCase() + m.slice(1)}</span>`;
  $('legTable').innerHTML = `<thead><tr><th>${p.route.name}</th><th>Buoy</th><th>Hs now</th><th>Planned for</th><th>Mode</th><th>Hs flown</th></tr></thead><tbody>${p.route.legs.map((leg, i) => `<tr><td>${leg.name} <span style="color:#5d6c7b">${leg.nm} nm</span></td><td>${leg.st}</td><td>${p.obs[i].toFixed(2)} m</td><td>${p.pred[i].toFixed(2)} m</td><td>${badge(f.modes ? f.modes[i] : p.modes[i])}${f.modes && f.modes[i] !== p.modes[i] ? ` <span class="rg-bad">was ${p.modes[i]}</span>` : ''}</td><td class="${f.actual[i] > c.modes[p.modes[i]].hsMax ? 'rg-bad' : ''}">${f.actual[i].toFixed(2)} m</td></tr>`).join('')}</tbody>`;
  $('replayNote').innerHTML = f.completed
    ? `${f.downmodes ? `<span class="rg-bad">Mode drop:</span> the sea built faster than planned. ` : 'Flown as planned. '}Block time ${hm(f.blockH)}${p.route.transferH ? ` + ${Math.round(p.route.transferH * 60)} min drive` : ''}, ${Math.round((f.energy / c.rangeNm) * 100)}% of battery used.`
    : '<span class="rg-bad">Diverted:</span> the slower modes needed would have exceeded the battery.';
}

main().catch((e) => { console.error(e); document.body.insertAdjacentHTML('beforeend', `<pre>${e.stack}</pre>`); });

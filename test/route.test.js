import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as R from '../core/route.js';

const data = JSON.parse(readFileSync(new URL('../data/seastate.json', import.meta.url)));
const h24 = R.hourOf('2024-01-01T00:00Z'), h25 = R.hourOf('2025-01-01T00:00Z');
const growth = R.fitGrowth(data, 0, h24);
const tune = R.departures(data, h24, h25);
const testHours = R.departures(data, h25, data.hours);

test('buoy data: three years hourly, plausible wave heights', () => {
  assert.equal(data.hours, 26304); // 2023 + 2024 (leap) + 2025
  for (const [st, s] of Object.entries(data.stations)) {
    assert.equal(s.hs.length, data.hours, st);
    const v = s.hs.filter((x) => x !== null);
    assert.ok(v.length > 0.5 * data.hours, `${st} coverage`);
    assert.ok(v.every((x) => x > 0 && x < 12), `${st} range`);
  }
  assert.ok(testHours.length > 2000 && tune.length > 3000);
});

test('plans respect battery reserve and each mode limit for the planned-for sea state', () => {
  const c = R.DEFAULT_CRAFT;
  for (const k of testHours.slice(0, 400)) {
    for (const pol of [{ kind: 'naive' }, { kind: 'calibrated', legQ: 0.9 }, { kind: 'margin', m: 0.3 }]) {
      const p = R.plan(data, growth, k, pol);
      if (!p) continue;
      assert.ok(p.energy <= c.rangeNm * (1 - c.reservePct) + 1e-9);
      p.pred.forEach((hs, i) => assert.ok(hs <= c.modes[p.modes[i]].hsMax + 1e-9));
    }
  }
});

test('calm sea: all-wing on the direct route (fastest)', () => {
  const calm = structuredClone(data);
  const k = testHours[0];
  for (const s of Object.values(calm.stations)) for (let d = 0; d < 8; d++) s.hs[k + d] = 0.6;
  const p = R.plan(calm, growth, k, { kind: 'calibrated', legQ: 0.95 });
  assert.equal(p.route.id, 'north');
  assert.deepEqual(p.modes, ['wing', 'wing', 'wing']);
  const f = R.fly(calm, k, p);
  assert.ok(f.completed && f.downmodes === 0);
});

test('fly(): a sea that builds after departure forces a mode drop; an impossible sea diverts', () => {
  const k = testHours[0];
  const d1 = structuredClone(data);
  for (const s of Object.values(d1.stations)) for (let d = 0; d < 8; d++) s.hs[k + d] = 0.6;
  const p = R.plan(d1, growth, k, { kind: 'naive' });
  assert.deepEqual(p.modes, ['wing', 'wing', 'wing']);
  const st0 = p.route.legs[0].st, st1 = p.route.legs[1].st;
  for (let d = 0; d < 8; d++) d1.stations[st0].hs[k + d] = 1.4; // above the take-off limit, inside the foil limit
  const f = R.fly(d1, k, p);
  assert.ok(f.completed && f.downmodes === 1 && f.modes[0] === 'foil' && f.modes[1] === 'wing', JSON.stringify(f.modes));
  for (let d = 0; d < 8; d++) d1.stations[st0].hs[k + d] = 0.6;
  for (let d = 0; d < 8; d++) d1.stations[st1].hs[k + d] = 5.0; // above the landing limit while airborne
  assert.equal(R.fly(d1, k, p).diverted, true);
});

test('no look-ahead: a plan only reads the sea state at departure', () => {
  const k = testHours.find((h, i) => i > 100 && R.plan(data, growth, h, { kind: 'calibrated', legQ: 0.9 }));
  const p1 = R.plan(data, growth, k, { kind: 'calibrated', legQ: 0.9 });
  const d2 = structuredClone(data);
  for (const s of Object.values(d2.stations)) for (let d = 1; d < 10; d++) if (s.hs[k + d] !== null) s.hs[k + d] = 9;
  const p2 = R.plan(d2, growth, k, { kind: 'calibrated', legQ: 0.9 });
  assert.equal(p1.route.id, p2.route.id);
  assert.deepEqual(p1.modes, p2.modes);
});

test('risk knob tuned on 2024 holds out of sample on 2025 and is monotone', () => {
  let prev = null;
  for (const target of [0.005, 0.01, 0.02]) {
    const q = R.tuneLegQuantile(data, growth, tune, target);
    const e = R.evaluate(data, growth, testHours, { kind: 'calibrated', legQ: q });
    assert.ok(e.disruptionRate <= 2 * target && e.disruptionRate >= 0.3 * target, `target ${target}: ${e.disruptionRate}`);
    if (prev) assert.ok(e.disruptionRate >= prev.disruptionRate - 1e-9 && e.meanDoorH <= prev.meanDoorH + 1e-9);
    prev = e;
  }
});

test('planner beats wing-only on the direct route and a fixed safety margin', () => {
  const q = R.tuneLegQuantile(data, growth, tune, 0.01);
  const plan = R.evaluate(data, growth, testHours, { kind: 'calibrated', legQ: q });
  const wingOnly = structuredClone(R.DEFAULT_CRAFT);
  wingOnly.modes.foil.hsMax = -1; wingOnly.modes.hull.hsMax = -1;
  const wing = R.evaluate(data, growth, testHours, { kind: 'naive' }, wingOnly, [R.ROUTES[0]]);
  const margin = R.evaluate(data, growth, testHours, { kind: 'margin', m: 0.2 });
  assert.ok(plan.completionRate > wing.completionRate && plan.disruptionRate < wing.disruptionRate);
  assert.ok(plan.completionRate - margin.completionRate > 0.05, `${plan.completionRate} vs ${margin.completionRate}`);
  const r = plan.cancelReason;
  assert.equal(r.takeoff + r.cruise + r.other, plan.n - plan.dispatched);
  // at a matched (or lower) mode-drop rate, the calibrated planner keeps more departures than a fixed margin
  const strict = R.evaluate(data, growth, testHours, { kind: 'calibrated', legQ: R.tuneLegQuantile(data, growth, tune, 0.002) });
  assert.ok(strict.disruptionRate <= margin.disruptionRate + 0.0005 && strict.completionRate - margin.completionRate > 0.04);
});

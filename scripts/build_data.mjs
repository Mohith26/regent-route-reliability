// Build data/seastate.json from NOAA NDBC historical standard meteorological files (public data).
// Downloads https://www.ndbc.noaa.gov/data/historical/stdmet/<station>h<year>.txt.gz into raw/ if missing.
// Output: hourly significant wave height (m) per station, 2023-01-01..2025-12-31 UTC, gaps <= 3 h linearly filled, longer gaps null.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

const STATIONS = {
  '51211': 'Pearl Harbor entrance, Oahu (CDIP 233)',
  '51202': 'Mokapu Point, Oahu (CDIP 098)',
  '51213': 'Kaumalapau, Lanai (CDIP 239)',
  '51205': 'Pauwela, Maui (CDIP 187)',
};
const YEARS = [2023, 2024, 2025];
const T0 = Date.UTC(2023, 0, 1), HOURS = (Date.UTC(2026, 0, 1) - T0) / 3600000;
mkdirSync(new URL('../raw/', import.meta.url), { recursive: true });

async function load(st, y) {
  const f = new URL(`../raw/${st}h${y}.txt.gz`, import.meta.url);
  if (!existsSync(f)) {
    const r = await fetch(`https://www.ndbc.noaa.gov/data/historical/stdmet/${st}h${y}.txt.gz`);
    if (!r.ok) throw new Error(`download ${st} ${y}: ${r.status}`);
    writeFileSync(f, Buffer.from(await r.arrayBuffer()));
  }
  return gunzipSync(readFileSync(f)).toString('utf8');
}

const out = { source: 'NOAA National Data Buoy Center, historical stdmet (WVHT)', t0: '2023-01-01T00:00Z', hours: HOURS, stations: {} };
for (const st of Object.keys(STATIONS)) {
  const sum = new Float64Array(HOURS), cnt = new Uint16Array(HOURS);
  for (const y of YEARS) {
    const txt = await load(st, y);
    for (const line of txt.split('\n')) {
      if (!line || line.startsWith('#')) continue;
      const p = line.trim().split(/\s+/);
      const [Y, M, D, h, mi] = p.slice(0, 5).map(Number);
      const wvht = +p[8];
      if (!(wvht > 0 && wvht < 30)) continue;
      const t = Date.UTC(Y, M - 1, D, h, mi);
      const k = Math.round((t - T0) / 3600000);
      if (k < 0 || k >= HOURS) continue;
      sum[k] += wvht; cnt[k]++;
    }
  }
  const hs = Array.from({ length: HOURS }, (_, k) => (cnt[k] ? sum[k] / cnt[k] : null));
  // fill gaps up to 3 hours
  let last = -1;
  for (let k = 0; k < HOURS; k++) {
    if (hs[k] === null) continue;
    if (last >= 0 && k - last > 1 && k - last <= 4) for (let j = last + 1; j < k; j++) hs[j] = hs[last] + ((hs[k] - hs[last]) * (j - last)) / (k - last);
    last = k;
  }
  const valid = hs.filter((v) => v !== null).length;
  out.stations[st] = { name: STATIONS[st], coverage: +(valid / HOURS).toFixed(3), hs: hs.map((v) => (v === null ? null : Math.round(v * 100) / 100)) };
  console.log(st, STATIONS[st], 'coverage', (valid / HOURS).toFixed(3));
}
writeFileSync(new URL('../data/seastate.json', import.meta.url), JSON.stringify(out));

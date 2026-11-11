# Route Planner for Seaglider operators (REGENT concept)

**Live demo:** https://mohith26.github.io/regent-route-reliability/

An unofficial concept feature for a REGENT operator portal: for a passenger route (here Honolulu to Maui), plan every departure leg by leg, choosing the route and the mode for each leg (hull, foil or wing-borne), and then fly that plan against what the sea actually did. It answers the question operators and the press keep asking: with the craft's real sea-state limits, what share of departures fly, month by month and hour by hour, and how often does a flight have to drop out of wing mode mid-route? Civilian passenger operations only.

Not affiliated with REGENT. **Public data from NOAA NDBC** (historical standard meteorological files for stations 51211 Pearl Harbor, 51202 Mokapu Point, 51213 Kaumalapau, 51205 Pauwela, 2023-2025), processed by `scripts/build_data.mjs`.

## How it works

1. **Data.** Hourly significant wave height at four buoys along two candidate routes: north (Honolulu to Kahului via the Kaiwi Channel and north of Molokai) and south (Honolulu to Maalaea via the lee of Lanai, plus a 25-minute drive). Gaps up to 3 hours are interpolated; departures are scored only when every buoy reports.
2. **Envelope.** Hull to 0.9 m Hs, foil to 1.5 m (REGENT's 2021 Hawaii briefing: ~3 ft and ~5 ft), take-off in sea state 3 (1.25 m) and landing up to sea state 5 (4.0 m) as reported in 2025, wing-borne cruise to 3.0 m (my assumption; REGENT describes flight as "always 5-30 ft above wave peak"). 156 nm range at 156 kn, 20% reserve, foil 1.6x and hull 1.2x the energy per nm of wing. All of these are sliders.
3. **Planner.** For each departure, enumerate route x per-leg mode (wing legs contiguous; take-off at the first wing leg, landing at the last), keep combinations that fit the battery and whose *planned-for* sea state is inside each mode's limit, and pick the fastest door to door.
4. **Calibrated sea-state growth.** The planned-for wave height on a leg is not the value at departure: it is an upper quantile of Hs over the hours that leg will be flown, from empirical ratios Hs(t+d)/Hs(t) per buoy, lead time and current sea-state bin (fit on 2023). The quantile level is tuned on 2024 so the realised in-flight mode-drop rate matches the operator's target, then tested on 2025.
5. **Fly it.** Each plan is replayed against the observed sea: if take-off isn't possible or the sea exceeds the wing limit, the craft continues in the best water mode (a mode drop); if no mode is possible or the battery can't cover it, the flight diverts.

## Results on 2025 (2,586 scheduled departures, default envelope)

| Policy | Completed | In-flight mode drops |
|---|---|---|
| Wing-only, direct route, observed Hs | 89.9% | 1.19% |
| Both routes, observed Hs (no margin) | 93.2% | 1.39% |
| Both routes, fixed +0.2 m margin | 81.5% | 0.14% |
| Planner, 1% target | 92.5% | 0.75% |
| Planner, 0.2% target | 89.1% | 0.13% |

- At the same mode-drop rate, the calibrated planner keeps more departures flying than a flat safety margin: 89.1% vs 81.5% at about 0.13-0.14% drops, and 92.5% vs 89.8% (+0.10 m) at the 1% setting. A flat margin in metres is far too much near the take-off limit, where seas change little hour to hour, and too little offshore.
- The risk knob holds out of sample: targets of 0.5%, 1% and 2% tuned on 2024 give 0.30%, 0.75% and 1.27% on 2025.
- Under the default envelope, 42% of cancellations are caused by the take-off limit and 58% by the assumed cruise limit; November and April are the worst months (82% and 87%).
- Hawaii's Seaglider feasibility study (Nov 2025) reported >90% operability at harbors; this looks at the whole route and the mid-flight risk.

## Run

```
node scripts/build_data.mjs   # downloads NDBC files into raw/ and rebuilds data/seastate.json
node --test test/*.test.js    # 7 tests
python3 -m http.server        # open http://localhost:8000 (?day=2025-01-02&hour=12)
```

## Tests

Data integrity (hours, coverage, plausible Hs); every plan fits the battery reserve and each mode's limit for its planned-for sea state; calm sea gives all-wing on the direct route; a sea that builds above the take-off limit forces a foil leg, and an airborne leg above the landing limit diverts; no look-ahead (changing future buoy values doesn't change the plan); the 2024-tuned risk knob holds on 2025 and is monotone; the planner beats wing-only and a fixed margin at matched risk, and cancellation causes add up.

## Honest limitations

- Buoys are point measurements. Mid-channel and harbor conditions differ, wind (crosswind, gusts) and wave period are not modelled, and Pauwela (51205) was offline for parts of 2025, so those months are not scored.
- The envelope is a mix of public statements and my assumptions; the wing-borne cruise limit in particular is unknown and moves the answer a lot (try the slider).
- Mode drops are judged on hourly maxima over each leg, and transitions are instantaneous; the route geometry and leg lengths are approximate.
- The growth model is an empirical ratio quantile, not a wave forecast; using NOAA/PacIOOS WAVEWATCH III forecasts would be the next step.

## Novelty

REGENT's public material describes the three operating modes and the Hawaii feasibility study's harbor-level operability (>90%). Journalists have asked for exactly this: "sea state limits that translate into a realistic percentage of go days on candidate routes, month by month" (Beat of Hawaii, Oct 2025). I found no public route-level, departure-by-departure planner or mid-flight risk estimate from REGENT or its operators.

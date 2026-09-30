# GNOME Time Tracker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A GNOME Shell 48 extension that records the day's arrival (boot time), counts time worked excluding the lunch break, shows it in the top bar, sends milestone and break notifications, and keeps a monthly JSON history.

**Architecture:** Pure logic lives in two modules with no `gi://` imports: `lib/timecalc.js` (time maths and alert selection) and `lib/tracker.js` (day bookkeeping, with the clock, boot time, config and store injected). They are unit-tested with plain `gjs -m`. Thin GNOME-facing modules sit around them: `lib/store.js` (Gio file I/O), `lib/indicator.js` (panel button), `extension.js` (60 s GLib timer, settings, notifications) and `prefs.js` (Adw settings window).

**Tech Stack:** GJS 1.82 (ES modules), GNOME Shell 48 extension API, GSettings, libadwaita 1.7, `glib-compile-schemas`. No npm packages and no runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-09-30-gnome-time-tracker-design.md`

## Global Constraints

- Target GNOME Shell 48 only: `"shell-version": ["48"]`, ES module syntax, `export default class … extends Extension`.
- UUID `time-tracker@anjrakot`. Settings schema id `org.gnome.shell.extensions.time-tracker`.
- No runtime dependencies beyond GJS and GNOME Shell. No npm packages.
- `lib/timecalc.js` and `lib/tracker.js` must not import any `gi://` or `resource://` module, so they run under plain `gjs -m`.
- History folder: settings key `history-dir`; empty means `~/.local/share/time_tracker/`. Files: `YYYY-MM.json` (`{"2026-09-30": {"arrival": "09:49:48", "departure": "18:02:10", "workedMin": 432}}`) and `state.json` (`{"date": "2026-09-30", "fired": ["w240", "break-start"]}`).
- Defaults: thresholds `['4:00','7:00','7:45','8:00']`, break `12:30`–`13:30`, break alerts on.
- Alert ids: `w<minutes>` for work alerts, `break-start`, `break-end`. The largest threshold is final and uses critical urgency.
- Tick every 60 s (`GLib.timeout_add_seconds(GLib.PRIORITY_LOW, 60, …)`). Last seen is saved on the first tick of a day and then every 5 ticks, and on `disable()`.
- A break alert more than 10 minutes late is marked fired silently. Of several missed work alerts, only the largest is shown.
- Arrival rule: boot time (`btime` in `/proc/stat`) if it is today and not in the future, otherwise now. Truncate to whole seconds.
- Every GNOME callback is wrapped in try/catch and logs `[time-tracker] …` via `console.error`. The tick always returns `GLib.SOURCE_CONTINUE`.
- Commit messages end with the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Settings edited mid-day** (threshold added, removed or changed after some alerts fired): already-fired alerts never repeat, and a newly added threshold that is already past fires once. Pinned by `tracker: editing thresholds mid-day never repeats fired alerts` (Task 3).
2. **All thresholds removed:** no work alerts, no crash, label still updates, remaining `0`, next alert `null`. Pinned by `tracker: with no thresholds …` (Task 3) and `buildAlerts with no thresholds` (Task 1).
3. **History folder not writable** (disk full, bad path in settings): GNOME Shell is unaffected and the top-bar label keeps updating. Pinned by `tracker: a failing store makes tick throw but view keeps working` (Task 3), plus `extension.js` running `tick()` and `view()` in separate `_safe` calls (Task 4).
4. **Other days in the month file**, including hand edits: saving today must keep every other day untouched. Pinned by `tracker: other days in the month file are kept when today is saved` (Task 3).
5. **Clock set backwards** before the arrival (NTP correction, manual change): worked time is `0`, never negative. Pinned by `workedMinutes: arrival before the break` (`before arrival` case, Task 1) and `tracker: clock set back before arrival …` (Task 3).

---

## File Structure

```
.gitignore                          ignores the compiled schema
README.md                           usage, install, tests, logs
install.sh                          compiles the schema, symlinks the extension into ~/.local/share/gnome-shell/extensions
time-tracker@anjrakot/
  metadata.json                     extension manifest (GNOME 48)
  extension.js                      enable/disable, 60 s timer, settings, notifications
  prefs.js                          Adw settings window
  lib/timecalc.js                   pure: parse/format, worked time, alert times, alert selection, arrival rule
  lib/store.js                      Gio: JSON read/write (atomic, .bak recovery), boot time, history folder
  lib/tracker.js                    pure: day/arrival/fired/last-seen bookkeeping, notification texts, view data
  lib/indicator.js                  PanelMenu.Button: label and menu
  schemas/org.gnome.shell.extensions.time-tracker.gschema.xml
tests/
  harness.js                        test(), eq(), ok(), run() for gjs
  run.js                            imports every *.test.js and runs them
  timecalc.test.js
  store.test.js
  tracker.test.js
```

---

### Task 1: Scaffold, test harness and time maths (`lib/timecalc.js`)

**Files:**
- Create: `.gitignore`
- Create: `tests/harness.js`
- Create: `tests/run.js`
- Create: `tests/timecalc.test.js`
- Create: `time-tracker@anjrakot/lib/timecalc.js`

**Interfaces:**
- Consumes: nothing.
- Produces (all exported from `time-tracker@anjrakot/lib/timecalc.js`; Dates are local; durations are whole minutes; `cfg` is `{thresholds: number[] (sorted), breakStart: number, breakEnd: number, breakAlerts: boolean}`, with break values in minutes since midnight):
  - `DEFAULT_BREAK_START = 750`, `DEFAULT_BREAK_END = 810`
  - `parseHM(text) → number|null`, `formatHM(minutes) → "7:45"`, `formatDuration(minutes) → "5h12" | "4h" | "48min"`
  - `formatClock(date) → "09:49"`, `formatClockSec(date) → "09:49:48"`, `parseClock(day, "HH:MM[:SS]") → Date|null`
  - `dateKey(date) → "2026-09-30"`, `monthKey(date) → "2026-09"`
  - `breakWindow(arrival, cfg) → {bs: Date, be: Date}`
  - `parseThresholds(string[]) → number[]`, `configFrom({thresholds, breakStart, breakEnd, breakAlerts}) → cfg`
  - `workedMinutes(arrival, t, cfg) → number`, `alertTime(arrival, minutes, cfg) → Date`, `remainingMinutes(arrival, now, cfg) → number`
  - `buildAlerts(arrival, cfg) → Array<{id, kind: 'work'|'break', time: Date, minutes?: number, final?: boolean}>`
  - `selectDue(alerts, fired: string[], now) → {show: alert[], markFired: string[]}`
  - `nextAlert(alerts, fired, now) → alert|null`
  - `chooseArrival(now, bootTime: Date|null) → Date`
- Produces (from `tests/harness.js`): `test(name, fn)`, `eq(actual, expected, message?)` (compares with JSON.stringify), `ok(value, message?)`, `run()` (prints results and exits 1 on any failure).

- [ ] **Step 1: Create `.gitignore`**

```gitignore
gschemas.compiled
```

- [ ] **Step 2: Create the test harness `tests/harness.js`**

```js
// Minimal test harness for `gjs -m`: test(), eq(), ok(), run().
import System from 'system';

const tests = [];

export function test(name, fn) {
    tests.push({name, fn});
}

export function eq(actual, expected, message = '') {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a !== e)
        throw new Error(`${message} expected ${e}, got ${a}`);
}

export function ok(value, message = 'expected truthy value') {
    if (!value)
        throw new Error(message);
}

export function run() {
    let failed = 0;
    for (const {name, fn} of tests) {
        try {
            fn();
            print(`ok   ${name}`);
        } catch (e) {
            failed++;
            print(`FAIL ${name}\n     ${e.message}`);
        }
    }
    print(`\n${tests.length - failed}/${tests.length} passed`);
    System.exit(failed ? 1 : 0);
}
```

- [ ] **Step 3: Create `tests/run.js` (only the timecalc tests for now)**

```js
// Entry point: gjs -m tests/run.js
import {run} from './harness.js';
import './timecalc.test.js';

run();
```

- [ ] **Step 4: Write the failing tests `tests/timecalc.test.js`**

```js
import {eq, test} from './harness.js';
import {
    alertTime, buildAlerts, chooseArrival, configFrom, dateKey, formatClock, formatDuration,
    formatHM, monthKey, nextAlert, parseClock, parseHM, parseThresholds, remainingMinutes,
    selectDue, workedMinutes,
} from '../time-tracker@anjrakot/lib/timecalc.js';

// 2026-09-30 local time.
const at = (h, m, s = 0) => new Date(2026, 8, 30, h, m, s);
const CFG = configFrom({
    thresholds: ['4:00', '7:00', '7:45', '8:00'],
    breakStart: '12:30',
    breakEnd: '13:30',
    breakAlerts: true,
});

test('parseHM accepts H:MM and HH:MM, rejects the rest', () => {
    eq(parseHM('7:45'), 465);
    eq(parseHM('07:45'), 465);
    eq(parseHM(' 12:30 '), 750);
    eq(parseHM('0:00'), 0);
    for (const bad of ['', '7', '7:4', '7:60', '24:00', 'ab:cd', '7:45:00', '-1:00'])
        eq(parseHM(bad), null, `"${bad}"`);
});

test('formatting helpers', () => {
    eq(formatHM(465), '7:45');
    eq(formatHM(750), '12:30');
    eq(formatDuration(312), '5h12');
    eq(formatDuration(240), '4h');
    eq(formatDuration(305), '5h05');
    eq(formatDuration(48), '48min');
    eq(formatDuration(0), '0min');
    eq(formatClock(at(9, 5)), '09:05');
    eq(dateKey(at(9, 5)), '2026-09-30');
    eq(monthKey(at(9, 5)), '2026-09');
});

test('parseClock builds a Date on the given day', () => {
    eq(parseClock(at(0, 0), '09:49:48').getTime(), at(9, 49, 48).getTime());
    eq(parseClock(at(0, 0), '09:49').getTime(), at(9, 49).getTime());
    eq(parseClock(at(0, 0), 'garbage'), null);
    eq(parseClock(at(0, 0), undefined), null);
    eq(parseClock(at(0, 0), '25:00:00'), null);
});

test('parseThresholds sorts, de-duplicates and drops invalid or zero', () => {
    eq(parseThresholds(['8:00', '4:00', '7:45', '4:00', 'x', '0:00', '7:00']), [240, 420, 465, 480]);
    eq(parseThresholds([]), []);
});

test('configFrom falls back to the default break when invalid', () => {
    const bad = configFrom({thresholds: [], breakStart: '13:30', breakEnd: '12:30', breakAlerts: false});
    eq([bad.breakStart, bad.breakEnd, bad.breakAlerts], [750, 810, false]);
    const junk = configFrom({thresholds: [], breakStart: 'x', breakEnd: '13:00', breakAlerts: true});
    eq([junk.breakStart, junk.breakEnd], [750, 810]);
});

test('workedMinutes: arrival before the break', () => {
    eq(workedMinutes(at(8, 30), at(8, 30), CFG), 0);
    eq(workedMinutes(at(8, 30), at(8, 0), CFG), 0, 'before arrival');
    eq(workedMinutes(at(8, 30), at(12, 0), CFG), 210);
    eq(workedMinutes(at(8, 30), at(13, 0), CFG), 240, 'inside break is frozen');
    eq(workedMinutes(at(8, 30), at(13, 30), CFG), 240);
    eq(workedMinutes(at(8, 30), at(17, 30), CFG), 480);
});

test('workedMinutes: arrival inside and after the break', () => {
    eq(workedMinutes(at(12, 45), at(13, 15), CFG), 0);
    eq(workedMinutes(at(12, 45), at(14, 30), CFG), 60);
    eq(workedMinutes(at(14, 0), at(15, 0), CFG), 60);
});

test('workedMinutes truncates to whole minutes', () => {
    eq(workedMinutes(at(9, 49, 48), at(10, 0, 0), CFG), 10);
});

test('alertTime: before, inside and after the break', () => {
    eq(formatClock(alertTime(at(8, 30), 480, CFG)), '17:30', 'spec example');
    eq(formatClock(alertTime(at(8, 30), 240, CFG)), '12:30', 'lands exactly on break start');
    eq(formatClock(alertTime(at(8, 30), 180, CFG)), '11:30');
    eq(formatClock(alertTime(at(12, 45), 60, CFG)), '14:30', 'counts from break end');
    eq(formatClock(alertTime(at(14, 0), 240, CFG)), '18:00');
});

test('alertTime is consistent with workedMinutes', () => {
    for (const arrival of [at(7, 0), at(9, 49, 48), at(12, 30), at(13, 10), at(13, 30), at(15, 0)]) {
        for (const minutes of [1, 60, 240, 465, 480]) {
            const t = alertTime(arrival, minutes, CFG);
            eq(workedMinutes(arrival, t, CFG), minutes, `${formatClock(arrival)} +${minutes}`);
        }
    }
});

test('remainingMinutes counts down to the last threshold and stops at 0', () => {
    eq(remainingMinutes(at(8, 30), at(16, 0), CFG), 90);
    eq(remainingMinutes(at(8, 30), at(19, 0), CFG), 0);
    eq(remainingMinutes(at(8, 30), at(16, 0), {...CFG, thresholds: []}), 0);
});

test('buildAlerts: work alerts with ids, final flag and break alerts', () => {
    const alerts = buildAlerts(at(8, 30), CFG);
    eq(alerts.map(a => a.id), ['w240', 'w420', 'w465', 'w480', 'break-start', 'break-end']);
    eq(alerts.map(a => formatClock(a.time)), ['12:30', '16:30', '17:15', '17:30', '12:30', '13:30']);
    eq(alerts.filter(a => a.final).map(a => a.id), ['w480']);
});

test('buildAlerts skips break alerts after arrival or when disabled', () => {
    eq(buildAlerts(at(12, 45), CFG).filter(a => a.kind === 'break').map(a => a.id), ['break-end']);
    eq(buildAlerts(at(14, 0), CFG).filter(a => a.kind === 'break').length, 0);
    eq(buildAlerts(at(8, 30), {...CFG, breakAlerts: false}).filter(a => a.kind === 'break').length, 0);
});

test('buildAlerts with no thresholds', () => {
    eq(buildAlerts(at(8, 30), {...CFG, thresholds: [], breakAlerts: false}), []);
});

test('selectDue: nothing due, then exactly one due', () => {
    const alerts = buildAlerts(at(8, 30), CFG);
    eq(selectDue(alerts, [], at(10, 0)), {show: [], markFired: []});
    const r = selectDue(alerts, ['break-start', 'break-end'], at(12, 30));
    eq(r.show.map(a => a.id), ['w240']);
    eq(r.markFired, ['w240']);
});

test('selectDue: several missed work alerts -> only the largest is shown', () => {
    const alerts = buildAlerts(at(8, 0), CFG);
    const r = selectDue(alerts, [], at(16, 30));
    eq(r.show.map(a => a.id), ['w420']);
    eq([...r.markFired].sort(), ['break-end', 'break-start', 'w240', 'w420']);
});

test('selectDue: already fired alerts are never shown again', () => {
    const alerts = buildAlerts(at(8, 0), CFG);
    eq(selectDue(alerts, ['w240', 'w420', 'break-start', 'break-end'], at(16, 30)).show, []);
});

test('selectDue: break alerts on time, latest wins, stale ones are silent', () => {
    const alerts = buildAlerts(at(9, 0), CFG);
    eq(selectDue(alerts, [], at(12, 31)).show.map(a => a.id), ['break-start']);
    eq(selectDue(alerts, [], at(13, 35)).show.map(a => a.id), ['break-end'], 'break-start skipped');
    const stale = selectDue(alerts, [], at(13, 41));
    eq(stale.show.map(a => a.id), [], 'more than 10 min late');
    eq([...stale.markFired].sort(), ['break-end', 'break-start']);
});

test('nextAlert returns the earliest upcoming unfired alert', () => {
    const alerts = buildAlerts(at(8, 30), CFG);
    eq(nextAlert(alerts, [], at(10, 0)).id, 'w240');
    eq(nextAlert(alerts, ['w240', 'break-start'], at(12, 40)).id, 'break-end');
    eq(nextAlert(alerts, [], at(18, 0)), null);
});

test('chooseArrival: boot today -> boot time, otherwise now', () => {
    const now = at(10, 43);
    eq(chooseArrival(now, at(9, 49, 48)).getTime(), at(9, 49, 48).getTime());
    eq(chooseArrival(now, new Date(2026, 8, 29, 18, 0)).getTime(), now.getTime(), 'booted yesterday');
    eq(chooseArrival(now, at(11, 0)).getTime(), now.getTime(), 'boot in the future');
    eq(chooseArrival(now, null).getTime(), now.getTime(), 'unknown boot time');
});
```

- [ ] **Step 5: Run the tests and confirm they fail**

Run: `gjs -m tests/run.js`
Expected: FAIL. gjs prints `Gjs-CRITICAL … Failed to resolve imports for module: '…/tests/run.js'` and exits 1, because `lib/timecalc.js` does not exist yet.

- [ ] **Step 6: Implement `time-tracker@anjrakot/lib/timecalc.js`**

```js
// Pure time maths for the tracker. No gi:// imports so it runs under plain `gjs -m`.
// All Dates are local time; durations are whole minutes.

const MINUTE_MS = 60 * 1000;
const STALE_BREAK_MS = 10 * MINUTE_MS;

export const DEFAULT_BREAK_START = 12 * 60 + 30;
export const DEFAULT_BREAK_END = 13 * 60 + 30;

const pad = n => String(n).padStart(2, '0');

/** "7:45" / "07:45" -> 465, anything else -> null. Hours 0-23. */
export function parseHM(text) {
    const m = /^(\d{1,2}):([0-5]\d)$/.exec(String(text).trim());
    if (!m)
        return null;
    const h = Number(m[1]);
    return h > 23 ? null : h * 60 + Number(m[2]);
}

/** 465 -> "7:45" (the settings format). */
export function formatHM(minutes) {
    return `${Math.floor(minutes / 60)}:${pad(minutes % 60)}`;
}

/** 312 -> "5h12", 240 -> "4h", 48 -> "48min". */
export function formatDuration(minutes) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    if (h === 0)
        return `${m}min`;
    return m === 0 ? `${h}h` : `${h}h${pad(m)}`;
}

/** Date -> "09:49". */
export function formatClock(date) {
    return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Date -> "09:49:48". */
export function formatClockSec(date) {
    return `${formatClock(date)}:${pad(date.getSeconds())}`;
}

/** "09:49:48" or "09:49" on the local date of `day` -> Date, or null if invalid. */
export function parseClock(day, text) {
    const m = /^(\d{2}):([0-5]\d)(?::([0-5]\d))?$/.exec(String(text));
    if (!m || Number(m[1]) > 23)
        return null;
    return new Date(day.getFullYear(), day.getMonth(), day.getDate(),
        Number(m[1]), Number(m[2]), Number(m[3] ?? 0));
}

/** Date -> "2026-09-30". */
export function dateKey(date) {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Date -> "2026-09". */
export function monthKey(date) {
    return dateKey(date).slice(0, 7);
}

function atMinutes(day, minutes) {
    return new Date(day.getFullYear(), day.getMonth(), day.getDate(),
        Math.floor(minutes / 60), minutes % 60);
}

/** Break start/end as Dates on the day of `arrival`. */
export function breakWindow(arrival, cfg) {
    return {bs: atMinutes(arrival, cfg.breakStart), be: atMinutes(arrival, cfg.breakEnd)};
}

/** Settings strings -> sorted, de-duplicated positive minutes; invalid entries dropped. */
export function parseThresholds(list) {
    const minutes = list.map(parseHM).filter(m => m !== null && m > 0);
    return [...new Set(minutes)].sort((a, b) => a - b);
}

/** Raw settings values -> validated config. Invalid break falls back to 12:30-13:30. */
export function configFrom({thresholds, breakStart, breakEnd, breakAlerts}) {
    let bs = parseHM(breakStart);
    let be = parseHM(breakEnd);
    if (bs === null || be === null || be <= bs) {
        bs = DEFAULT_BREAK_START;
        be = DEFAULT_BREAK_END;
    }
    return {
        thresholds: parseThresholds(thresholds),
        breakStart: bs,
        breakEnd: be,
        breakAlerts: Boolean(breakAlerts),
    };
}

/** Whole minutes worked between `arrival` and `t`, excluding the break. */
export function workedMinutes(arrival, t, cfg) {
    if (t <= arrival)
        return 0;
    const {bs, be} = breakWindow(arrival, cfg);
    const overlap = Math.max(0, Math.min(t, be) - Math.max(arrival, bs));
    return Math.floor((t - arrival - overlap) / MINUTE_MS);
}

/** The instant at which workedMinutes reaches `minutes`. */
export function alertTime(arrival, minutes, cfg) {
    const {bs, be} = breakWindow(arrival, cfg);
    const start = arrival >= bs && arrival < be ? be : arrival;
    let t = start.getTime() + minutes * MINUTE_MS;
    if (start < bs && t > bs.getTime())
        t += be - bs;
    return new Date(t);
}

/** Minutes left until the largest threshold (0 when there are none). */
export function remainingMinutes(arrival, now, cfg) {
    const last = cfg.thresholds.length ? cfg.thresholds[cfg.thresholds.length - 1] : 0;
    return Math.max(0, last - workedMinutes(arrival, now, cfg));
}

/**
 * All alerts for a day, as {id, kind: 'work'|'break', time, minutes?, final?}.
 * Break alerts are only included when enabled and when arrival is before them.
 */
export function buildAlerts(arrival, cfg) {
    const last = cfg.thresholds[cfg.thresholds.length - 1];
    const alerts = cfg.thresholds.map(minutes => ({
        id: `w${minutes}`,
        kind: 'work',
        minutes,
        final: minutes === last,
        time: alertTime(arrival, minutes, cfg),
    }));
    if (cfg.breakAlerts) {
        const {bs, be} = breakWindow(arrival, cfg);
        if (arrival < bs)
            alerts.push({id: 'break-start', kind: 'break', time: bs});
        if (arrival < be)
            alerts.push({id: 'break-end', kind: 'break', time: be});
    }
    return alerts;
}

/**
 * Catch-up rule. Returns {show, markFired}: alerts to notify now and every id to
 * record as fired. Only the largest due work alert is shown; of the break alerts
 * only the latest due one is considered, and it is dropped silently when stale.
 */
export function selectDue(alerts, fired, now) {
    const due = alerts.filter(a => a.time <= now && !fired.includes(a.id));
    const show = [];

    const work = due.filter(a => a.kind === 'work');
    if (work.length)
        show.push(work.reduce((a, b) => (b.minutes > a.minutes ? b : a)));

    const breaks = due.filter(a => a.kind === 'break');
    if (breaks.length) {
        const latest = breaks.reduce((a, b) => (b.time > a.time ? b : a));
        if (now - latest.time <= STALE_BREAK_MS)
            show.push(latest);
    }

    return {show, markFired: due.map(a => a.id)};
}

/** The earliest alert still to come, or null. */
export function nextAlert(alerts, fired, now) {
    const upcoming = alerts.filter(a => a.time > now && !fired.includes(a.id));
    return upcoming.reduce((a, b) => (a === null || b.time < a.time ? b : a), null);
}

/** Arrival rule: boot time when the machine was started today, otherwise now. */
export function chooseArrival(now, bootTime) {
    if (bootTime && dateKey(bootTime) === dateKey(now) && bootTime <= now)
        return bootTime;
    return now;
}
```

- [ ] **Step 7: Run the tests and confirm they pass**

Run: `gjs -m tests/run.js`
Expected: `20/20 passed`, exit code 0.

- [ ] **Step 8: Commit**

```bash
git add .gitignore tests/harness.js tests/run.js tests/timecalc.test.js "time-tracker@anjrakot/lib/timecalc.js"
git commit -m "feat: time maths and alert selection with gjs test harness

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: JSON storage and boot time (`lib/store.js`)

**Files:**
- Create: `tests/store.test.js`
- Modify: `tests/run.js` (add one import)
- Create: `time-tracker@anjrakot/lib/store.js`

**Interfaces:**
- Consumes: nothing from Task 1 (the harness only).
- Produces (exported from `time-tracker@anjrakot/lib/store.js`):
  - `resolveHistoryDir(setting: string) → string`: `''` means `<user data dir>/time_tracker`, and `~` / `~/…` are expanded.
  - `parseBootTime(procStatText) → Date|null`, `readBootTime() → Date|null` (never throws).
  - `class Store(dir)` with `dir` (string), `loadMonth("YYYY-MM") → object`, `saveMonth("YYYY-MM", object)`, `loadState() → object`, `saveState(object)`. A missing file loads as `{}`. Invalid or non-object JSON is moved to `<name>.bak` and loads as `{}`. Saves create the folder, write atomically and **throw** on failure; the caller decides what to do.

- [ ] **Step 1: Write the failing tests `tests/store.test.js`**

```js
import GLib from 'gi://GLib';
import {eq, ok, test} from './harness.js';
import {parseBootTime, resolveHistoryDir, Store} from '../time-tracker@anjrakot/lib/store.js';

const tempStore = () => new Store(GLib.dir_make_tmp('time-tracker-XXXXXX'));
const path = (store, name) => GLib.build_filenamev([store.dir, name]);
const writeRaw = (store, name, text) => GLib.file_set_contents(path(store, name), text);
const exists = (store, name) => GLib.file_test(path(store, name), GLib.FileTest.EXISTS);

test('store: missing files read as empty objects', () => {
    const store = tempStore();
    eq(store.loadMonth('2026-09'), {});
    eq(store.loadState(), {});
});

test('store: month and state round-trip', () => {
    const store = tempStore();
    const month = {'2026-09-30': {arrival: '09:49:48', departure: '18:02:10', workedMin: 432}};
    store.saveMonth('2026-09', month);
    store.saveState({date: '2026-09-30', fired: ['w240']});
    eq(store.loadMonth('2026-09'), month);
    eq(store.loadState(), {date: '2026-09-30', fired: ['w240']});
    ok(exists(store, '2026-09.json'));
});

test('store: creates a missing folder on write', () => {
    const store = new Store(GLib.build_filenamev([GLib.dir_make_tmp('time-tracker-XXXXXX'), 'a', 'b']));
    store.saveState({date: '2026-09-30', fired: []});
    eq(store.loadState(), {date: '2026-09-30', fired: []});
});

test('store: corrupt JSON is moved to .bak and reads as empty', () => {
    const store = tempStore();
    writeRaw(store, 'state.json', '{"date": "2026-09-30", "fir');
    eq(store.loadState(), {});
    ok(exists(store, 'state.json.bak'), 'backup kept');
    ok(!exists(store, 'state.json'), 'corrupt file moved away');
});

test('store: JSON that is not an object is treated as corrupt', () => {
    const store = tempStore();
    writeRaw(store, '2026-09.json', '[1, 2, 3]');
    eq(store.loadMonth('2026-09'), {});
    ok(exists(store, '2026-09.json.bak'));
});

test('parseBootTime reads the btime line of /proc/stat', () => {
    eq(parseBootTime('cpu  1 2 3\nbtime 1790750988\nprocesses 42\n').getTime(), 1790750988000);
    eq(parseBootTime('cpu  1 2 3\n'), null);
});

test('resolveHistoryDir: default, ~ expansion, absolute', () => {
    const def = GLib.build_filenamev([GLib.get_user_data_dir(), 'time_tracker']);
    eq(resolveHistoryDir(''), def);
    eq(resolveHistoryDir('   '), def);
    eq(resolveHistoryDir('~/work/hours'), GLib.build_filenamev([GLib.get_home_dir(), 'work/hours']));
    eq(resolveHistoryDir('/srv/hours'), '/srv/hours');
});
```

- [ ] **Step 2: Register them in `tests/run.js`**

Add this line after `import './timecalc.test.js';`:

```js
import './store.test.js';
```

- [ ] **Step 3: Run the tests and confirm they fail**

Run: `gjs -m tests/run.js`
Expected: FAIL. gjs prints `Failed to resolve imports for module: '…/tests/run.js'` and exits 1, because `lib/store.js` does not exist yet.

- [ ] **Step 4: Implement `time-tracker@anjrakot/lib/store.js`**

```js
// Filesystem access: JSON files in the history folder, plus the system boot time.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const STATE_FILE = 'state.json';

/** Settings value -> absolute folder. Empty = ~/.local/share/time_tracker, "~/" expanded. */
export function resolveHistoryDir(setting) {
    const value = (setting ?? '').trim();
    if (value === '')
        return GLib.build_filenamev([GLib.get_user_data_dir(), 'time_tracker']);
    if (value === '~' || value.startsWith('~/'))
        return GLib.build_filenamev([GLib.get_home_dir(), value.slice(1)]);
    return value;
}

/** Contents of /proc/stat -> boot Date, or null if there is no btime line. */
export function parseBootTime(procStat) {
    const m = /^btime\s+(\d+)$/m.exec(procStat);
    return m ? new Date(Number(m[1]) * 1000) : null;
}

/** The system boot time, or null if it cannot be read. */
export function readBootTime() {
    try {
        const [, bytes] = GLib.file_get_contents('/proc/stat');
        return parseBootTime(new TextDecoder().decode(bytes));
    } catch (e) {
        console.error(`[time-tracker] cannot read boot time: ${e}`);
        return null;
    }
}

export class Store {
    constructor(dir) {
        this.dir = dir;
    }

    loadMonth(month) {
        return this._read(`${month}.json`);
    }

    saveMonth(month, data) {
        this._write(`${month}.json`, data);
    }

    loadState() {
        return this._read(STATE_FILE);
    }

    saveState(state) {
        this._write(STATE_FILE, state);
    }

    /** Missing file -> {}. Unreadable or non-object JSON -> moved to <name>.bak, then {}. */
    _read(name) {
        const path = GLib.build_filenamev([this.dir, name]);
        const file = Gio.File.new_for_path(path);
        try {
            const [, bytes] = file.load_contents(null);
            const data = JSON.parse(new TextDecoder().decode(bytes));
            if (typeof data !== 'object' || data === null || Array.isArray(data))
                throw new Error('not a JSON object');
            return data;
        } catch (e) {
            if (e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                return {};
            console.error(`[time-tracker] invalid ${path}, moving it to .bak: ${e}`);
            try {
                file.move(Gio.File.new_for_path(`${path}.bak`), Gio.FileCopyFlags.OVERWRITE, null, null);
            } catch (moveError) {
                console.error(`[time-tracker] cannot back up ${path}: ${moveError}`);
            }
            return {};
        }
    }

    /** Atomic: replace_contents writes a temporary file and renames it over the target. */
    _write(name, data) {
        GLib.mkdir_with_parents(this.dir, 0o755);
        const file = Gio.File.new_for_path(GLib.build_filenamev([this.dir, name]));
        const bytes = new TextEncoder().encode(`${JSON.stringify(data, null, 2)}\n`);
        file.replace_contents(bytes, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
    }
}
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `gjs -m tests/run.js`
Expected: `27/27 passed`. Two `Gjs-Console-CRITICAL … invalid … moving it to .bak` lines on stderr are expected; they come from the corrupt-file tests.

- [ ] **Step 6: Commit**

```bash
git add tests/store.test.js tests/run.js "time-tracker@anjrakot/lib/store.js"
git commit -m "feat: atomic JSON store with .bak recovery and boot time reader

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Day bookkeeping (`lib/tracker.js`)

**Files:**
- Create: `tests/tracker.test.js`
- Modify: `tests/run.js` (add one import)
- Create: `time-tracker@anjrakot/lib/tracker.js`

**Interfaces:**
- Consumes (from Task 1, `./timecalc.js`): `breakWindow`, `buildAlerts`, `chooseArrival`, `dateKey`, `formatClock`, `formatClockSec`, `formatDuration`, `monthKey`, `nextAlert`, `parseClock`, `remainingMinutes`, `selectDue`, `workedMinutes`, `configFrom` (tests only).
- Consumes (duck-typed, matching the Task 2 `Store` API): `{loadMonth, saveMonth, loadState, saveState}`.
- Produces (exported from `time-tracker@anjrakot/lib/tracker.js`):
  - `SAVE_EVERY_TICKS = 5`
  - `class Tracker({store, config: () => cfg, now: () => Date, bootTime: () => Date|null})` with:
    - `arrival` getter → `Date|null`
    - `tick() → Array<{title: string, body: string, urgent: boolean}>`. Loads or rolls over the day, marks and returns due notifications, and saves last seen on the first tick of a day and every 5th tick after that. Throws if the store throws.
    - `view() → {arrival: Date, worked: number, remaining: number, next: {label: string, time: Date}|null}`
    - `resetArrival()`: arrival = now (whole seconds), fired alerts cleared, both files saved.
    - `stop()`: saves the departure. Does nothing if `tick()`/`view()` never ran.

- [ ] **Step 1: Write the failing tests `tests/tracker.test.js`**

```js
import {eq, ok, test} from './harness.js';
import {configFrom} from '../time-tracker@anjrakot/lib/timecalc.js';
import {SAVE_EVERY_TICKS, Tracker} from '../time-tracker@anjrakot/lib/tracker.js';

const day = (d, h, m, s = 0) => new Date(2026, 8, d, h, m, s); // September 2026
const at = (h, m, s = 0) => day(30, h, m, s);
const CFG = configFrom({
    thresholds: ['4:00', '7:00', '7:45', '8:00'],
    breakStart: '12:30',
    breakEnd: '13:30',
    breakAlerts: true,
});

// In-memory stand-in for Store; JSON copies mimic real serialisation.
class FakeStore {
    constructor() {
        this.files = {};
        this.writes = 0;
    }

    loadMonth(month) {
        return this._get(`${month}.json`);
    }

    saveMonth(month, data) {
        this._set(`${month}.json`, data);
    }

    loadState() {
        return this._get('state.json');
    }

    saveState(state) {
        this._set('state.json', state);
    }

    _get(name) {
        return name in this.files ? JSON.parse(this.files[name]) : {};
    }

    _set(name, data) {
        this.writes++;
        this.files[name] = JSON.stringify(data);
    }
}

function setup({store = new FakeStore(), now = at(10, 43), boot = at(9, 49, 48), cfg = CFG} = {}) {
    const clock = {now};
    const tracker = new Tracker({
        store,
        config: () => cfg,
        now: () => clock.now,
        bootTime: () => boot,
    });
    return {store, clock, tracker};
}

test('tracker: first run of the day uses today\'s boot time and writes history', () => {
    const {store, tracker} = setup();
    tracker.tick();
    eq(tracker.arrival.getTime(), at(9, 49, 48).getTime());
    const entry = store.loadMonth('2026-09')['2026-09-30'];
    eq(entry.arrival, '09:49:48');
    eq(entry.departure, '10:43:00');
    eq(entry.workedMin, 53);
    eq(store.loadState(), {date: '2026-09-30', fired: []});
});

test('tracker: booted yesterday -> arrival is now (whole seconds)', () => {
    const {tracker} = setup({now: at(8, 15, 20), boot: day(29, 22, 0)});
    tracker.tick();
    eq(tracker.arrival.getTime(), at(8, 15, 20).getTime());
});

test('tracker: a restart on the same day keeps the saved arrival', () => {
    const {store} = setup();
    setup({store}).tracker.tick();
    const later = setup({store, now: at(15, 0), boot: at(14, 55)});
    later.tracker.tick();
    eq(later.tracker.arrival.getTime(), at(9, 49, 48).getTime());
});

test('tracker: fired alerts survive a restart and do not repeat', () => {
    const {store, clock, tracker} = setup({now: at(9, 0), boot: at(8, 0)});
    tracker.tick();
    clock.now = at(12, 0);
    eq(tracker.tick().map(m => m.title), ['⏱ 4h done']);
    const again = setup({store, now: at(12, 5), boot: at(12, 3)});
    eq(again.tracker.tick(), []);
});

test('tracker: missed alerts after a shutdown -> one notification with the latest', () => {
    const store = new FakeStore();
    setup({store, now: at(8, 1), boot: at(8, 0)}).tracker.tick();
    const back = setup({store, now: at(16, 30), boot: at(16, 28)});
    const msgs = back.tracker.tick();
    eq(msgs.map(m => m.title), ['⏱ 7h done']);
    eq(msgs[0].body, '30min left (since 08:00)');
    eq([...store.loadState().fired].sort(), ['break-end', 'break-start', 'w240', 'w420']);
});

test('tracker: final alert is urgent, break alerts have their own text', () => {
    const {clock, tracker} = setup({now: at(8, 30), boot: at(8, 30)});
    tracker.tick();
    clock.now = at(12, 30);
    eq(tracker.tick().map(m => [m.title, m.body]), [
        ['⏱ 4h done', '4h left (since 08:30)'],
        ['Break time 🍽', 'Back at 13:30'],
    ]);
    clock.now = at(13, 30);
    eq(tracker.tick(), [{title: 'Back to work 💼', body: '4h done so far (since 08:30)', urgent: false}]);
    clock.now = at(17, 30);
    const [final] = tracker.tick();
    eq([final.title, final.urgent], ['⏱ 8h done', true]);
});

test('tracker: last seen is saved on the first tick and every SAVE_EVERY_TICKS ticks', () => {
    const {store, clock, tracker} = setup();
    tracker.tick();
    for (let i = 1; i <= SAVE_EVERY_TICKS; i++) {
        clock.now = new Date(at(10, 43).getTime() + i * 60000);
        tracker.tick();
    }
    eq(store.loadMonth('2026-09')['2026-09-30'].departure, '10:48:00');
});

test('tracker: stop() records the departure', () => {
    const {store, clock, tracker} = setup();
    tracker.tick();
    clock.now = at(17, 2, 10);
    tracker.stop();
    const entry = store.loadMonth('2026-09')['2026-09-30'];
    eq([entry.departure, entry.workedMin], ['17:02:10', 372]);
});

test('tracker: stop() before any tick writes nothing', () => {
    const {store, tracker} = setup();
    tracker.stop();
    eq(store.writes, 0);
});

test('tracker: crossing midnight closes the old day and starts a new one', () => {
    const {store, clock, tracker} = setup({now: day(30, 23, 50), boot: day(30, 9, 0)});
    tracker.tick();
    clock.now = new Date(2026, 9, 1, 0, 0, 30); // 1 October
    tracker.tick();
    eq(store.loadMonth('2026-09')['2026-09-30'].departure, '23:50:00');
    eq(store.loadMonth('2026-10')['2026-10-01'].arrival, '00:00:30');
    eq(store.loadState(), {date: '2026-10-01', fired: []});
});

test('tracker: resetArrival sets arrival to now and clears fired alerts', () => {
    const {store, clock, tracker} = setup({now: at(12, 0), boot: at(7, 0)});
    tracker.tick();
    clock.now = at(14, 10, 5);
    tracker.resetArrival();
    eq(tracker.arrival.getTime(), at(14, 10, 5).getTime());
    eq(store.loadState(), {date: '2026-09-30', fired: []});
    eq(store.loadMonth('2026-09')['2026-09-30'].arrival, '14:10:05');
});

test('tracker: view() gives worked, remaining and next alert', () => {
    const {clock, tracker} = setup({now: at(8, 30), boot: at(8, 30)});
    tracker.tick();
    clock.now = at(14, 0);
    const v = tracker.view();
    eq([v.worked, v.remaining], [270, 210]);
    eq(v.next.label, '7h');
    eq(v.next.time.getTime(), at(16, 30).getTime());
    clock.now = at(18, 0);
    tracker.tick();
    eq(tracker.view().next, null);
});

test('tracker: a corrupt history arrival is replaced using the arrival rule', () => {
    const store = new FakeStore();
    store.saveMonth('2026-09', {'2026-09-30': {arrival: 'oops'}});
    const {tracker} = setup({store});
    tracker.tick();
    eq(store.loadMonth('2026-09')['2026-09-30'].arrival, '09:49:48');
    ok(tracker.arrival);
});

test('tracker: state.json from another day is ignored', () => {
    const store = new FakeStore();
    store.saveState({date: '2026-09-29', fired: ['w240', 'w420', 'w465', 'w480']});
    const {clock, tracker} = setup({store, now: at(8, 0), boot: at(8, 0)});
    tracker.tick();
    clock.now = at(12, 0);
    eq(tracker.tick().map(m => m.title), ['⏱ 4h done']);
});

test('tracker: editing thresholds mid-day never repeats fired alerts', () => {
    let cfg = CFG;
    const store = new FakeStore();
    const clock = {now: at(8, 0)};
    const tracker = new Tracker({store, config: () => cfg, now: () => clock.now, bootTime: () => at(8, 0)});
    tracker.tick();
    clock.now = at(12, 0);
    eq(tracker.tick().map(m => m.title), ['⏱ 4h done']);
    cfg = configFrom({thresholds: ['4:00', '6:00', '8:00'], breakStart: '12:30', breakEnd: '13:30', breakAlerts: false});
    clock.now = at(15, 1);
    eq(tracker.tick().map(m => m.title), ['⏱ 6h done'], 'new past threshold fires once');
    clock.now = at(15, 2);
    eq(tracker.tick(), []);
});

test('tracker: with no thresholds there are no work alerts and the view still works', () => {
    const cfg = configFrom({thresholds: [], breakStart: '12:30', breakEnd: '13:30', breakAlerts: false});
    const {clock, tracker} = setup({now: at(8, 0), boot: at(8, 0), cfg});
    tracker.tick();
    clock.now = at(18, 0);
    eq(tracker.tick(), []);
    const v = tracker.view();
    eq([v.worked, v.remaining, v.next], [540, 0, null]);
});

test('tracker: a failing store makes tick throw but view keeps working', () => {
    const store = new FakeStore();
    store._set = () => {
        throw new Error('disk full');
    };
    const {tracker} = setup({store});
    let threw = false;
    try {
        tracker.tick();
    } catch {
        threw = true;
    }
    ok(threw, 'tick reports the write error');
    eq(tracker.view().worked, 53);
});

test('tracker: other days in the month file are kept when today is saved', () => {
    const store = new FakeStore();
    const other = {arrival: '08:02:00', departure: '17:40:00', workedMin: 518};
    store.saveMonth('2026-09', {'2026-09-29': other});
    const {clock, tracker} = setup({store});
    tracker.tick();
    clock.now = at(17, 0);
    tracker.stop();
    eq(store.loadMonth('2026-09')['2026-09-29'], other);
    eq(Object.keys(store.loadMonth('2026-09')).sort(), ['2026-09-29', '2026-09-30']);
});

test('tracker: clock set back before arrival gives 0 worked, not negative', () => {
    const {clock, tracker} = setup();
    tracker.tick();
    clock.now = at(9, 0);
    eq(tracker.view().worked, 0);
});
```

- [ ] **Step 2: Register them in `tests/run.js`**

Add this line after `import './store.test.js';`:

```js
import './tracker.test.js';
```

- [ ] **Step 3: Run the tests and confirm they fail**

Run: `gjs -m tests/run.js`
Expected: FAIL. gjs prints `Failed to resolve imports for module: '…/tests/run.js'` and exits 1, because `lib/tracker.js` does not exist yet.

- [ ] **Step 4: Implement `time-tracker@anjrakot/lib/tracker.js`**

```js
// Day bookkeeping: arrival, last seen, fired alerts. No gi:// imports; the clock,
// boot time, config and store are injected so this runs under plain `gjs -m`.
import {
    breakWindow, buildAlerts, chooseArrival, dateKey, formatClock, formatClockSec, formatDuration,
    monthKey, nextAlert, parseClock, remainingMinutes, selectDue, workedMinutes,
} from './timecalc.js';

export const SAVE_EVERY_TICKS = 5;

const wholeSeconds = date => new Date(Math.floor(date.getTime() / 1000) * 1000);

export class Tracker {
    /**
     * @param {object} deps
     * @param {{loadMonth, saveMonth, loadState, saveState}} deps.store
     * @param {() => object} deps.config  validated config (see timecalc.configFrom)
     * @param {() => Date} deps.now
     * @param {() => Date|null} deps.bootTime
     */
    constructor({store, config, now, bootTime}) {
        this._store = store;
        this._config = config;
        this._now = now;
        this._bootTime = bootTime;
        this._day = null;
        this._arrival = null;
        this._fired = [];
        this._ticks = 0;
        this._lastTick = null;
    }

    get arrival() {
        return this._arrival;
    }

    /** Run once a minute. Returns the notifications to show: [{title, body, urgent}]. */
    tick() {
        const now = this._now();
        this._ensureDay(now);
        this._lastTick = now;

        const cfg = this._config();
        const {show, markFired} = selectDue(buildAlerts(this._arrival, cfg), this._fired, now);
        if (markFired.length) {
            this._fired.push(...markFired);
            this._saveState();
        }

        if (this._ticks % SAVE_EVERY_TICKS === 0)
            this._saveLastSeen(now);
        this._ticks++;

        return show.map(alert => this._message(alert, now, cfg));
    }

    /** Data for the panel indicator. */
    view() {
        const now = this._now();
        this._ensureDay(now);
        const cfg = this._config();
        const next = nextAlert(buildAlerts(this._arrival, cfg), this._fired, now);
        return {
            arrival: this._arrival,
            worked: workedMinutes(this._arrival, now, cfg),
            remaining: remainingMinutes(this._arrival, now, cfg),
            next: next && {label: alertLabel(next), time: next.time},
        };
    }

    /** "Reset arrival to now": new arrival, today's fired alerts cleared. */
    resetArrival() {
        const now = this._now();
        this._ensureDay(now);
        this._arrival = wholeSeconds(now);
        this._fired = [];
        this._saveState();
        this._saveLastSeen(now);
    }

    /** Called from disable(): record departure. */
    stop() {
        if (this._day === null)
            return;
        const now = this._now();
        this._saveLastSeen(dateKey(now) === this._day ? now : this._lastTick);
    }

    _ensureDay(now) {
        const key = dateKey(now);
        if (this._day === key)
            return;
        if (this._day !== null && this._lastTick !== null)
            this._saveLastSeen(this._lastTick); // close the previous day
        this._day = key;
        this._ticks = 0;

        // Read everything first so a failing write cannot leave the day half-loaded.
        const month = this._store.loadMonth(monthKey(now));
        const state = this._store.loadState();
        const saved = month[key] && parseClock(now, month[key].arrival);
        this._arrival = saved || wholeSeconds(chooseArrival(now, this._bootTime()));
        const sameDay = state.date === key && Array.isArray(state.fired);
        this._fired = sameDay ? state.fired.filter(id => typeof id === 'string') : [];

        if (!saved) {
            month[key] = this._entry(now);
            this._store.saveMonth(monthKey(now), month);
        }
        if (!sameDay)
            this._saveState();
    }

    _entry(departure) {
        const end = departure < this._arrival ? this._arrival : departure;
        return {
            arrival: formatClockSec(this._arrival),
            departure: formatClockSec(end),
            workedMin: workedMinutes(this._arrival, end, this._config()),
        };
    }

    _saveLastSeen(t) {
        const month = monthKey(this._arrival);
        const data = this._store.loadMonth(month);
        data[this._day] = this._entry(t);
        this._store.saveMonth(month, data);
    }

    _saveState() {
        this._store.saveState({date: this._day, fired: this._fired});
    }

    _message(alert, now, cfg) {
        const since = `since ${formatClock(this._arrival)}`;
        if (alert.id === 'break-start') {
            const back = formatClock(breakWindow(this._arrival, cfg).be);
            return {title: 'Break time 🍽', body: `Back at ${back}`, urgent: false};
        }
        if (alert.id === 'break-end') {
            const worked = formatDuration(workedMinutes(this._arrival, now, cfg));
            return {title: 'Back to work 💼', body: `${worked} done so far (${since})`, urgent: false};
        }
        const title = `⏱ ${formatDuration(alert.minutes)} done`;
        if (alert.final)
            return {title, body: `Day complete — you can go home 🏠 (${since})`, urgent: true};
        const left = formatDuration(remainingMinutes(this._arrival, now, cfg));
        return {title, body: `${left} left (${since})`, urgent: false};
    }
}

function alertLabel(alert) {
    if (alert.id === 'break-start')
        return 'Break';
    if (alert.id === 'break-end')
        return 'Back to work';
    return formatDuration(alert.minutes);
}
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `gjs -m tests/run.js 2>/dev/null | tail -1`
Expected: `46/46 passed`.

- [ ] **Step 6: Commit**

```bash
git add tests/tracker.test.js tests/run.js "time-tracker@anjrakot/lib/tracker.js"
git commit -m "feat: tracker for arrival, fired alerts, last seen and day rollover

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: GNOME Shell integration (manifest, schema, indicator, extension, installer)

The code here only runs inside GNOME Shell, so verification is: schema compile, syntax check, then a real session check.

**Files:**
- Create: `time-tracker@anjrakot/metadata.json`
- Create: `time-tracker@anjrakot/schemas/org.gnome.shell.extensions.time-tracker.gschema.xml`
- Create: `time-tracker@anjrakot/lib/indicator.js`
- Create: `time-tracker@anjrakot/extension.js`
- Create: `install.sh`

**Interfaces:**
- Consumes: `Tracker` (Task 3); `Store`, `readBootTime`, `resolveHistoryDir` (Task 2); `configFrom`, `formatClock`, `formatDuration` (Task 1).
- Produces:
  - GSettings keys: `alert-thresholds` (`as`), `break-start` (`s`), `break-end` (`s`), `break-alerts` (`b`), `history-dir` (`s`), `test-notification` (`u`; the extension shows a test notification whenever it changes).
  - `TrackerIndicator({onReset, onOpenFolder, onSettings})` with `update(view)`, where `view` is the `Tracker.view()` shape.

- [ ] **Step 1: Create `time-tracker@anjrakot/metadata.json`**

```json
{
  "uuid": "time-tracker@anjrakot",
  "name": "Time Tracker",
  "description": "Counts office time from the first start of the day (lunch break excluded), alerts at milestones and keeps a monthly history.",
  "shell-version": ["48"],
  "settings-schema": "org.gnome.shell.extensions.time-tracker",
  "url": "https://github.com/Fafafa12/time_tracker"
}
```

- [ ] **Step 2: Create the settings schema**

`time-tracker@anjrakot/schemas/org.gnome.shell.extensions.time-tracker.gschema.xml`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<schemalist>
  <schema id="org.gnome.shell.extensions.time-tracker" path="/org/gnome/shell/extensions/time-tracker/">
    <key name="alert-thresholds" type="as">
      <default>['4:00', '7:00', '7:45', '8:00']</default>
      <summary>Work alerts</summary>
      <description>Time worked (H:MM) at which to notify. The largest is the end of the day.</description>
    </key>
    <key name="break-start" type="s">
      <default>'12:30'</default>
      <summary>Break start (HH:MM)</summary>
    </key>
    <key name="break-end" type="s">
      <default>'13:30'</default>
      <summary>Break end (HH:MM)</summary>
    </key>
    <key name="break-alerts" type="b">
      <default>true</default>
      <summary>Notify at break start and end</summary>
    </key>
    <key name="history-dir" type="s">
      <default>''</default>
      <summary>History folder</summary>
      <description>Empty means ~/.local/share/time_tracker</description>
    </key>
    <key name="test-notification" type="u">
      <default>0</default>
      <summary>Incremented by the preferences to request a test notification</summary>
    </key>
  </schema>
</schemalist>
```

- [ ] **Step 3: Check the schema compiles**

Run: `glib-compile-schemas --strict --dry-run "time-tracker@anjrakot/schemas" && echo schema-ok`
Expected: `schema-ok`.

- [ ] **Step 4: Create `time-tracker@anjrakot/lib/indicator.js`**

```js
// Top-bar button: "⏱ 5h12" label plus a menu with today's details and actions.
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {formatClock, formatDuration} from './timecalc.js';

export const TrackerIndicator = GObject.registerClass(
class TrackerIndicator extends PanelMenu.Button {
    /**
     * @param {object} actions
     * @param {() => void} actions.onReset
     * @param {() => void} actions.onOpenFolder
     * @param {() => void} actions.onSettings
     */
    _init({onReset, onOpenFolder, onSettings}) {
        super._init(0.5, 'Time Tracker');

        this._label = new St.Label({text: '⏱ …', y_align: Clutter.ActorAlign.CENTER});
        this.add_child(this._label);

        this._arrival = this._addInfo();
        this._worked = this._addInfo();
        this._remaining = this._addInfo();
        this._next = this._addInfo();
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addAction('Reset arrival to now', onReset);
        this.menu.addAction('Open history folder', onOpenFolder);
        this.menu.addAction('Settings', onSettings);
    }

    _addInfo() {
        const item = new PopupMenu.PopupMenuItem('', {reactive: false});
        this.menu.addMenuItem(item);
        return item.label;
    }

    /** @param {{arrival: Date, worked: number, remaining: number, next: ?{label: string, time: Date}}} view */
    update(view) {
        this._label.text = `⏱ ${formatDuration(view.worked)}`;
        this._arrival.text = `Arrival: ${formatClock(view.arrival)}`;
        this._worked.text = `Worked: ${formatDuration(view.worked)}`;
        this._remaining.text = `Remaining: ${formatDuration(view.remaining)}`;
        this._next.text = view.next
            ? `Next alert: ${view.next.label} at ${formatClock(view.next.time)}`
            : 'Next alert: none, day complete';
    }
});
```

- [ ] **Step 5: Create `time-tracker@anjrakot/extension.js`**

```js
// Entry point: wires settings, the tracker, the top-bar indicator and notifications.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {TrackerIndicator} from './lib/indicator.js';
import {readBootTime, resolveHistoryDir, Store} from './lib/store.js';
import {configFrom} from './lib/timecalc.js';
import {Tracker} from './lib/tracker.js';

const TICK_SECONDS = 60;
const ICON = 'preferences-system-time-symbolic';

export default class TimeTrackerExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._config = this._readConfig();
        this._tracker = this._createTracker();

        this._indicator = new TrackerIndicator({
            onReset: () => this._safe(() => {
                this._tracker.resetArrival();
                this._refresh();
            }),
            onOpenFolder: () => this._safe(() => this._openFolder()),
            onSettings: () => this._safe(() => this.openPreferences()),
        });
        Main.panel.addToStatusArea(this.uuid, this._indicator);

        this._settingsId = this._settings.connect('changed', (_s, key) => this._safe(() => this._onSettingChanged(key)));

        this._refresh();
        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, TICK_SECONDS, () => {
            this._refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    disable() {
        if (this._timeoutId) {
            GLib.Source.remove(this._timeoutId);
            this._timeoutId = 0;
        }
        if (this._settingsId) {
            this._settings.disconnect(this._settingsId);
            this._settingsId = 0;
        }
        this._safe(() => this._tracker?.stop());
        this._indicator?.destroy();
        this._source?.destroy();
        this._indicator = null;
        this._source = null;
        this._tracker = null;
        this._settings = null;
    }

    _createTracker() {
        this._historyDir = resolveHistoryDir(this._settings.get_string('history-dir'));
        return new Tracker({
            store: new Store(this._historyDir),
            config: () => this._config,
            now: () => new Date(),
            bootTime: readBootTime,
        });
    }

    _readConfig() {
        return configFrom({
            thresholds: this._settings.get_strv('alert-thresholds'),
            breakStart: this._settings.get_string('break-start'),
            breakEnd: this._settings.get_string('break-end'),
            breakAlerts: this._settings.get_boolean('break-alerts'),
        });
    }

    _onSettingChanged(key) {
        if (key === 'test-notification') {
            this._notify({title: '⏱ Time Tracker', body: 'Test notification: alerts are working', urgent: false});
            return;
        }
        if (key === 'history-dir') {
            this._tracker.stop();
            this._tracker = this._createTracker();
        }
        this._config = this._readConfig();
        this._refresh();
    }

    /** One tick: send due notifications, then update the label even if the tick failed. */
    _refresh() {
        this._safe(() => {
            for (const message of this._tracker.tick())
                this._notify(message);
        });
        this._safe(() => this._indicator.update(this._tracker.view()));
    }

    _notify({title, body, urgent}) {
        if (!this._source) {
            this._source = new MessageTray.Source({title: 'Time Tracker', iconName: ICON});
            this._source.connect('destroy', () => {
                this._source = null;
            });
            Main.messageTray.add(this._source);
        }
        const urgency = urgent ? MessageTray.Urgency.CRITICAL : MessageTray.Urgency.NORMAL;
        this._source.addNotification(new MessageTray.Notification({source: this._source, title, body, urgency}));
    }

    _openFolder() {
        GLib.mkdir_with_parents(this._historyDir, 0o755);
        Gio.AppInfo.launch_default_for_uri(GLib.filename_to_uri(this._historyDir, null), null);
    }

    _safe(fn) {
        try {
            return fn();
        } catch (e) {
            console.error(`[time-tracker] ${e}\n${e?.stack ?? ''}`);
            return undefined;
        }
    }
}
```

- [ ] **Step 6: Create `install.sh`**

```bash
#!/usr/bin/env bash
# Links the extension into GNOME Shell and compiles its settings schema.
set -euo pipefail

UUID="time-tracker@anjrakot"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$UUID"
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"

glib-compile-schemas "$SRC/schemas"

mkdir -p "$(dirname "$DEST")"
if [ -e "$DEST" ] && [ ! -L "$DEST" ]; then
    echo "error: $DEST exists and is not a symlink; remove it first" >&2
    exit 1
fi
ln -sfn "$SRC" "$DEST"

echo "Linked $DEST -> $SRC"
echo "Wayland: log out and back in once, then run: gnome-extensions enable $UUID"
```

Then make it executable: `chmod +x install.sh`

- [ ] **Step 7: Syntax-check the GNOME modules and rerun the unit tests**

Run:
```bash
for f in extension.js lib/indicator.js; do cp "time-tracker@anjrakot/$f" /tmp/tt-check.mjs && node --check /tmp/tt-check.mjs && echo "$f ok"; done
bash -n install.sh && echo "install.sh ok"
gjs -m tests/run.js 2>/dev/null | tail -1
```
Expected: `extension.js ok`, `lib/indicator.js ok`, `install.sh ok`, `46/46 passed`.

- [ ] **Step 8: Install, then check in a real session (the user does this step)**

Run: `./install.sh`
Expected: `Linked ~/.local/share/gnome-shell/extensions/time-tracker@anjrakot -> …`, and `time-tracker@anjrakot/schemas/gschemas.compiled` now exists (ignored by git).

The user then logs out and back in (Wayland only loads new extensions at login) and runs:
```bash
gnome-extensions enable time-tracker@anjrakot
gnome-extensions info time-tracker@anjrakot          # State: ACTIVE
python3 -m json.tool ~/.local/share/time_tracker/$(date +%Y-%m).json
cat ~/.local/share/time_tracker/state.json
journalctl --user -b -o cat /usr/bin/gnome-shell | grep time-tracker   # expect no output
```
Expected:
- The top bar shows `⏱ <worked>`.
- The menu shows `Arrival: 09:49` on 2026-09-30 (the output of `uptime -s`).
- The month file has today's entry with `"arrival": "09:49:48"`.
- `state.json` has today's date.
- There are no `[time-tracker]` errors in the journal.

Test notification without the settings window: `gsettings --schemadir "time-tracker@anjrakot/schemas" set org.gnome.shell.extensions.time-tracker test-notification 1`. Expected: a "⏱ Time Tracker" popup.

Lock and unlock the screen. Expected: the arrival is unchanged and the label is updated within 60 s.

- [ ] **Step 9: Commit**

```bash
git add "time-tracker@anjrakot/metadata.json" "time-tracker@anjrakot/schemas/org.gnome.shell.extensions.time-tracker.gschema.xml" "time-tracker@anjrakot/lib/indicator.js" "time-tracker@anjrakot/extension.js" install.sh
git commit -m "feat: GNOME Shell extension with top-bar indicator, notifications and installer

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Settings window (`prefs.js`)

**Files:**
- Create: `time-tracker@anjrakot/prefs.js`

**Interfaces:**
- Consumes: GSettings keys from Task 4; `formatHM`, `parseHM`, `parseThresholds` (Task 1).
- Produces: `export default class TimeTrackerPreferences extends ExtensionPreferences` with `fillPreferencesWindow(window)`.

- [ ] **Step 1: Create `time-tracker@anjrakot/prefs.js`**

```js
// Settings window (runs in its own process, not in GNOME Shell).
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {formatHM, parseHM, parseThresholds} from './lib/timecalc.js';

const isThreshold = text => (parseHM(text) ?? 0) > 0;

function markValid(row, valid) {
    if (valid)
        row.remove_css_class('error');
    else
        row.add_css_class('error');
}

export default class TimeTrackerPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window._settings = settings; // keep alive as long as the window

        const page = new Adw.PreferencesPage({title: 'Time Tracker', iconName: 'preferences-system-time-symbolic'});
        page.add(this._alertsGroup(settings));
        page.add(this._breakGroup(settings));
        page.add(this._historyGroup(settings));
        window.add(page);
    }

    _alertsGroup(settings) {
        const group = new Adw.PreferencesGroup({
            title: 'Work alerts',
            description: 'Time worked (H:MM) at which to notify. The largest one is the end of the day. Press ✓ to save.',
        });
        const rows = [];

        const save = () => {
            const values = rows.map(r => r.text).filter(isThreshold);
            settings.set_strv('alert-thresholds', parseThresholds(values).map(formatHM));
        };

        const addRow = text => {
            const row = new Adw.EntryRow({title: 'Alert after', text, showApplyButton: true});
            const remove = new Gtk.Button({iconName: 'user-trash-symbolic', valign: Gtk.Align.CENTER, cssClasses: ['flat']});
            remove.connect('clicked', () => {
                rows.splice(rows.indexOf(row), 1);
                group.remove(row);
                save();
            });
            row.add_suffix(remove);
            row.connect('changed', () => markValid(row, row.text === '' || isThreshold(row.text)));
            row.connect('apply', save);
            rows.push(row);
            group.add(row);
            return row;
        };

        settings.get_strv('alert-thresholds').forEach(addRow);

        const add = new Gtk.Button({iconName: 'list-add-symbolic', valign: Gtk.Align.CENTER, cssClasses: ['flat']});
        add.connect('clicked', () => addRow('').grab_focus());
        group.set_header_suffix(add);
        return group;
    }

    _breakGroup(settings) {
        const group = new Adw.PreferencesGroup({title: 'Break', description: 'Not counted as work time. Press ✓ to save.'});
        const start = new Adw.EntryRow({title: 'Break start (HH:MM)', text: settings.get_string('break-start'), showApplyButton: true});
        const end = new Adw.EntryRow({title: 'Break end (HH:MM)', text: settings.get_string('break-end'), showApplyButton: true});

        const validate = () => {
            const s = parseHM(start.text);
            const e = parseHM(end.text);
            const valid = s !== null && e !== null && e > s;
            markValid(start, valid);
            markValid(end, valid);
            return valid ? [s, e] : null;
        };
        const apply = () => {
            const range = validate();
            if (!range)
                return;
            settings.set_string('break-start', formatHM(range[0]));
            settings.set_string('break-end', formatHM(range[1]));
        };
        for (const row of [start, end]) {
            row.connect('changed', validate);
            row.connect('apply', apply);
            group.add(row);
        }

        const alerts = new Adw.SwitchRow({title: 'Break alerts', subtitle: 'Notify at break start and end'});
        settings.bind('break-alerts', alerts, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(alerts);
        return group;
    }

    _historyGroup(settings) {
        const group = new Adw.PreferencesGroup({title: 'History'});
        const dir = new Adw.EntryRow({
            title: 'History folder (empty = ~/.local/share/time_tracker)',
            text: settings.get_string('history-dir'),
            showApplyButton: true,
        });
        dir.connect('apply', () => settings.set_string('history-dir', dir.text.trim()));
        group.add(dir);

        const test = new Adw.ActionRow({title: 'Test notification', subtitle: 'Check that alerts appear'});
        const send = new Gtk.Button({label: 'Send', valign: Gtk.Align.CENTER});
        send.connect('clicked', () => settings.set_uint('test-notification', settings.get_uint('test-notification') + 1));
        test.add_suffix(send);
        group.add(test);
        return group;
    }
}
```

- [ ] **Step 2: Syntax check**

Run: `cp "time-tracker@anjrakot/prefs.js" /tmp/tt-check.mjs && node --check /tmp/tt-check.mjs && echo prefs ok`
Expected: `prefs ok`.

- [ ] **Step 3: Check it in the real session (no re-login needed; prefs runs in its own process)**

Run: `gnome-extensions prefs time-tracker@anjrakot`
Expected, checking each item:
- Four alert rows (`4:00`, `7:00`, `7:45`, `8:00`), break `12:30` / `13:30`, the break alerts switch on, and an empty history folder.
- Type `7:4` in an alert row: the row turns red. Type `7:40` and press ✓: `gsettings --schemadir "time-tracker@anjrakot/schemas" get org.gnome.shell.extensions.time-tracker alert-thresholds` shows `7:40`. Set it back to `7:45`.
- Press ＋: an empty row appears. Enter `6:00` and press ✓: the setting now contains `6:00`. Delete that row with the trash button: the setting no longer contains it.
- Enter break end `12:00`: both break rows turn red and pressing ✓ saves nothing.
- Press **Send** under "Test notification": a "⏱ Time Tracker" popup appears.
- Choose **Settings** in the top-bar menu: the same window opens.

- [ ] **Step 4: Commit**

```bash
git add "time-tracker@anjrakot/prefs.js"
git commit -m "feat: settings window for alerts, break and history folder

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: README and final verification

**Files:**
- Create: `README.md`

**Interfaces:**
- Consumes: everything above. Produces: documentation only.

- [ ] **Step 1: Create `README.md`**

```markdown
# Time Tracker (GNOME Shell extension)

Counts time at the office from the first computer start of the day, excluding the
lunch break, and shows it in the top bar (`⏱ 5h12`).

- Arrival = boot time if the computer was started today, otherwise the first time the
  extension runs that day. Saved, so reboots on the same day don't change it.
- Alerts at 4h, 7h, 7h45 and 8h worked (8h stays on screen), plus break start/end.
  An alert never repeats; after being away you get only the latest one you missed.
- History: one file per month in `~/.local/share/time_tracker/` (e.g. `2026-09.json`)
  with arrival, departure (last time the computer was on) and minutes worked.
- Settings (thresholds, break, history folder, test notification):
  `gnome-extensions prefs time-tracker@anjrakot` or the top-bar menu.

Requires GNOME Shell 48.

## Install

```bash
./install.sh
# Wayland: log out and back in once, then
gnome-extensions enable time-tracker@anjrakot
```

After changing `extension.js` or `lib/*.js`, log out and back in to reload
(the settings window reloads each time it is opened).

## Tests

```bash
gjs -m tests/run.js
```

## Logs

```bash
journalctl --user -f -o cat /usr/bin/gnome-shell | grep time-tracker
```
```

- [ ] **Step 2: Final verification**

Run:
```bash
gjs -m tests/run.js 2>/dev/null | tail -1
glib-compile-schemas --strict --dry-run "time-tracker@anjrakot/schemas" && echo schema-ok
git status --short
```
Expected: `46/46 passed`, `schema-ok`, and no untracked files except `README.md` (`gschemas.compiled` is ignored).

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: README with install, tests and logs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

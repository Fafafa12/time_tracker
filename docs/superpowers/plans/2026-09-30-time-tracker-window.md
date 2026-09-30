# Time Tracker v2 Implementation Plan: breaks, overtime and the Time Tracker window

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add manual breaks and an on/off fixed break, overtime for every day, a D-Bus service in the extension, and a separate libadwaita app (Today · History · Stats) that edits history through that service.

**Architecture:**
- **Pure logic** (no `gi://` imports, tested with `gjs -m`):
  - `lib/timecalc.js`: time maths over merged break intervals
  - `lib/day.js`: history entry format, validation, recalculation
  - `lib/stats.js`: periods, totals, averages, records, chart data
  - `lib/tracker.js`: today's state and actions
- **Extension** (inside GNOME Shell): exports `lib/dbus.js` (TrackerService) and stays the only writer of the data files.
- **App** (`app/`, separate GTK process): reads the month files through a read-only `Store`, and sends every change to the extension over D-Bus.
- **Dev tool** (`dev/preview.sh`): renders the app to PNG without touching the desktop.

**Tech Stack:** GJS 1.82 (ES modules), GNOME Shell 48 extension API, GTK 4.18, libadwaita 1.7, Cairo/PangoCairo, GSettings, D-Bus (Gio). No npm, no runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-09-30-time-tracker-window-design.md` (builds on `2026-09-30-gnome-time-tracker-design.md`)

## Global Constraints

- **Versions:** GNOME Shell 48, libadwaita 1.7, GTK 4.18, GJS 1.82. No npm packages and no runtime dependencies.
- **Pure modules:** `lib/timecalc.js`, `lib/day.js`, `lib/stats.js` and `lib/tracker.js` must not import any `gi://` or `resource://` module. `lib/dbus-api.js` has no imports at all.
- **App imports:** the app imports shared code with relative paths, `../time-tracker@anjrakot/lib/...` from `app/` and `../../time-tracker@anjrakot/lib/...` from `app/pages/`.
- **Single writer:** only the extension writes the data files. The app uses `new Store(dir, {readOnly: true})` and D-Bus.
- **D-Bus:**
  - name `io.github.fafafa12.TimeTrackerService`, object path `/io/github/fafafa12/TimeTrackerService`, interface `io.github.fafafa12.TimeTrackerService`
  - app id `io.github.fafafa12.TimeTracker` (a different name, because GTK registers the app id on the bus)
- **D-Bus errors:** a `UserError` becomes `org.freedesktop.DBus.Error.InvalidArgs` with its message. Any other error becomes `org.freedesktop.DBus.Error.Failed`.
- **Entry format v2:**
  ```
  {"arrival","departure","breaks":[["HH:MM:SS","HH:MM:SS"]],"openBreak":null|"HH:MM:SS","fixedBreak":["H:MM","H:MM"]|null,"targetMin","workedMin","overtimeMin"}
  ```
  An old v1 entry reads as: `fixedBreak` `["12:30","13:30"]`, `targetMin` `480`, `breaks` `[]`, `openBreak` `null`.
- **Target:** the largest alert threshold (`targetOf(cfg)`), or 0 when there are none.
- **New setting:** `fixed-break` (`b`, default `true`).
- **Forbidden for the executor:**
  - `gsettings set`, `dconf write`/`reset`, `gnome-extensions enable`/`disable`
  - starting `gnome-shell` in any form. Headless runs write the user's REAL dconf, which already damaged the desktop once.
  - Only `dev/preview.sh` may run the app. It uses in-memory GSettings, a private D-Bus, and Broadway bound to 127.0.0.1.
- **Real-session checks:** done by the user, all together in Task 8 (one logout).
- **Commit messages** end with the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Upgrading in the middle of a day**, while today's entry is still in v1 format: the arrival is kept and the entry gains the v2 fields on its next save. Pinned by `tracker: a v1 entry for today (upgrade mid-day) keeps its arrival and gains v2 fields` (Task 1).
2. **"＋ Add day" on a date that already exists:** refused with "This day already exists: edit it in the list", never a silent overwrite. Pinned by `validateDay: adding a day that already exists is refused` (Task 1). The dialog wiring is checked in the Task 6 preview.
3. **Editing a past day while the extension keeps saving today** into the same month file: the edit survives. Pinned by `tracker: a past-day edit survives the next saves of today` (Task 1).
4. **Target or fixed-break settings changed mid-day:** today follows the new settings, and past days keep their own copy. Pinned by `tracker: settings changed mid-day apply to today only` (Task 1).
5. **The extension turned off or on while the window is open:** the banner shows "The tracker is off — view only", editing is disabled, and the window recovers by itself when the extension comes back. Checked with `dev/preview.sh --offline` (Task 5) and in the real session (Task 8).

---

## File Structure

```
time-tracker@anjrakot/
  lib/timecalc.js     MODIFY  break intervals, config {fixedBreak}, targetOf, formatSigned, dateFromKey
  lib/day.js          NEW     Day <-> entry, computeDay, closeDay, validateDay, dayFromInput/inputFromDay
  lib/stats.js        NEW     periodRange, shiftPeriod, datesIn, monthsIn, summarize
  lib/tracker.js      MODIFY  breaks, openBreak, view() (JSON), start/finishBreak, setArrival, saveDay, deleteDay
  lib/store.js        MODIFY  readOnly option
  lib/dbus-api.js     NEW     bus name, path, interface XML, error names
  lib/dbus.js         NEW     TrackerService (exported by the extension)
  lib/indicator.js    MODIFY  break toggle, Open Time Tracker, overtime line, ☕ label
  extension.js        MODIFY  fixed-break config, D-Bus export, Changed each tick, open app
  prefs.js            MODIFY  Fixed daily break switch
  schemas/...xml      MODIFY  fixed-break key
app/
  main.js, window.js, client.js, data.js, style.css, dayDialog.js, time-tracker (launcher)
  pages/today.js, pages/history.js, pages/stats.js
  widgets/anim.js, ring.js, timeline.js, barChart.js, confetti.js
  icons/hicolor/scalable/actions/tt-stats-symbolic.svg, icons/hicolor/scalable/apps/io.github.fafafa12.TimeTracker.svg
  io.github.fafafa12.TimeTracker.desktop.in
dev/fake-service.js, dev/preview.sh
tests/day.test.js, tests/stats.test.js, tests/dbus.test.js (NEW); timecalc/tracker/store tests and run.js (MODIFY)
install.sh, README.md (MODIFY)
```

---

### Task 1: Break-aware time maths, day model and tracker (pure core)

**Files:**
- Modify (replace whole file): `time-tracker@anjrakot/lib/timecalc.js`, `time-tracker@anjrakot/lib/tracker.js`, `tests/timecalc.test.js`, `tests/tracker.test.js`, `tests/run.js`
- Create: `time-tracker@anjrakot/lib/day.js`, `tests/day.test.js`

**Interfaces:**
- **Consumes:** nothing new. `tests/harness.js` is unchanged.
- **Produces from `timecalc.js`:**
  - Kept from v1: `parseHM`, `formatHM`, `formatDuration`, `formatClock`, `formatClockSec`, `parseClock`, `dateKey`, `monthKey`, `parseThresholds`, `thresholdsToSave`, `selectDue`, `chooseArrival`, `DEFAULT_BREAK_START`, `DEFAULT_BREAK_END`.
  - `breakWindow` is **removed**.
  - New or changed:
    - `formatSigned(min) → "+0h25" | "−1h10"`
    - `dateFromKey("YYYY-MM-DD") → Date|null`
    - `atMinutes(day, min) → Date`
    - `configFrom({thresholds, fixedBreak: bool, breakStart, breakEnd, breakAlerts}) → {thresholds, fixedBreak: {start, end}|null, breakAlerts}`
    - `targetOf(cfg) → number`
    - `mergeIntervals([[s, e]]) → [[s, e]]`
    - `breakIntervals(arrival, {fixedBreak, breaks: [[Date, Date]], openBreak: Date|null}) → [[ms, ms|Infinity]]`
    - `workedMinutes(arrival, t, intervals)`, `breakMinutes(arrival, t, intervals)`
    - `alertTime(arrival, min, intervals) → Date|null` (null means paused)
    - `remainingMinutes(arrival, now, cfg, intervals)`
    - `buildAlerts(arrival, cfg, intervals)` (a work alert's `time` may be null)
    - `nextAlert(alerts, fired, now)` (earliest timed alert, otherwise the first paused one, otherwise null)
- **Produces from `day.js`:**
  - `DEFAULT_TARGET_MIN = 480`
  - `readDay(key, entry) → Day|null`, where Day = `{date, arrival, departure|null, breaks: [[Date, Date]], openBreak|null, fixedBreak|null, targetMin}`
  - `intervalsOf(day)`
  - `computeDay(day, until?) → {workedMin, overtimeMin, breakMin}`
  - `closeDay(day, departure) → Day`
  - `writeDay(day) → entry`
  - `validateDay(input, key, now, {adding, exists}?) → [{field, message}]`
  - `dayFromInput(key, input, targetMin) → Day`
  - `inputFromDay(day) → input`, where input = `{arrival, departure, breaks: [[s, e]], fixedBreak: [s, e]|null}` as "H:MM"
- **Produces from `tracker.js`:**
  - `UserError`, `SAVE_EVERY_TICKS`
  - `Tracker` with `tick()`, `view()`, `startBreak()`, `finishBreak()`, `setArrival(text)`, `resetArrival()`, `saveDay(key, input)`, `deleteDay(key)`, `stop()`, `moveTo(store)`, and the `arrival` getter.
  - `view()` returns JSON: `{date, arrival: "HH:MM:SS", workedMin, targetMin, overtimeMin, remainingMin, onBreak, openBreak, breaks: [["HH:MM:SS", "HH:MM:SS"]], fixedBreak: ["H:MM", "H:MM"]|null, next: {label, time: "HH:MM"}|{label, paused: true}|null, leaveAt: "HH:MM"|null}`

- [ ] **Step 1: Replace `tests/timecalc.test.js`**

````js
import {eq, test} from './harness.js';
import {
    alertTime, breakIntervals, breakMinutes, buildAlerts, chooseArrival, configFrom, dateFromKey,
    dateKey, formatClock, formatDuration, formatHM, formatSigned, mergeIntervals, monthKey,
    nextAlert, parseClock, parseHM, parseThresholds, remainingMinutes, selectDue, targetOf,
    thresholdsToSave, workedMinutes,
} from '../time-tracker@anjrakot/lib/timecalc.js';

// 2026-09-30 local time.
const at = (h, m, s = 0) => new Date(2026, 8, 30, h, m, s);
const CFG = configFrom({
    thresholds: ['4:00', '7:00', '7:45', '8:00'],
    fixedBreak: true,
    breakStart: '12:30',
    breakEnd: '13:30',
    breakAlerts: true,
});
// Break intervals of a day with the default fixed break plus optional manual/open breaks.
const iv = (arrival, extra = {}) => breakIntervals(arrival, {fixedBreak: CFG.fixedBreak, ...extra});

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
    eq(formatSigned(25), '+0h25');
    eq(formatSigned(-70), '−1h10');
    eq(formatSigned(0), '+0h00');
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
    eq(parseClock(at(0, 0), '8:05').getTime(), at(8, 5).getTime(), 'hand-edited H:MM');
});

test('dateFromKey parses valid keys only', () => {
    eq(dateFromKey('2026-09-30').getTime(), at(0, 0).getTime());
    eq(dateFromKey('2026-02-30'), null);
    eq(dateFromKey('30/09/2026'), null);
    eq(dateFromKey(undefined), null);
});

test('parseThresholds sorts, de-duplicates and drops invalid or zero', () => {
    eq(parseThresholds(['8:00', '4:00', '7:45', '4:00', 'x', '0:00', '7:00']), [240, 420, 465, 480]);
    eq(parseThresholds([]), []);
});

test('configFrom: fixed break on/off and fallback when invalid', () => {
    eq(CFG.fixedBreak, {start: 750, end: 810});
    eq(configFrom({thresholds: [], fixedBreak: false, breakStart: '12:30', breakEnd: '13:30'}).fixedBreak, null);
    const bad = configFrom({thresholds: [], fixedBreak: true, breakStart: '13:30', breakEnd: '12:30', breakAlerts: false});
    eq([bad.fixedBreak, bad.breakAlerts], [{start: 750, end: 810}, false]);
    eq(configFrom({thresholds: [], fixedBreak: true, breakStart: 'x', breakEnd: '13:00'}).fixedBreak, {start: 750, end: 810});
});

test('targetOf is the largest threshold, 0 without thresholds', () => {
    eq(targetOf(CFG), 480);
    eq(targetOf({...CFG, thresholds: []}), 0);
});

test('mergeIntervals sorts and merges overlapping and touching pairs', () => {
    eq(mergeIntervals([[5, 8], [1, 3], [2, 4], [8, 9], [7, 7]]), [[1, 4], [5, 9]]);
    eq(mergeIntervals([[1, 2], [3, Infinity], [5, 6]]), [[1, 2], [3, Infinity]]);
    eq(mergeIntervals([]), []);
});

test('workedMinutes with the fixed break: arrival before the break', () => {
    const a = at(8, 30);
    eq(workedMinutes(a, at(8, 30), iv(a)), 0);
    eq(workedMinutes(a, at(8, 0), iv(a)), 0, 'before arrival');
    eq(workedMinutes(a, at(12, 0), iv(a)), 210);
    eq(workedMinutes(a, at(13, 0), iv(a)), 240, 'inside break is frozen');
    eq(workedMinutes(a, at(13, 30), iv(a)), 240);
    eq(workedMinutes(a, at(17, 30), iv(a)), 480);
});

test('workedMinutes: arrival inside and after the break, no fixed break', () => {
    eq(workedMinutes(at(12, 45), at(13, 15), iv(at(12, 45))), 0);
    eq(workedMinutes(at(12, 45), at(14, 30), iv(at(12, 45))), 60);
    eq(workedMinutes(at(14, 0), at(15, 0), iv(at(14, 0))), 60);
    eq(workedMinutes(at(8, 30), at(17, 30), []), 540, 'fixed break off');
});

test('workedMinutes with manual breaks, overlaps counted once, and an open break', () => {
    const a = at(8, 0);
    const manual = iv(a, {breaks: [[at(10, 0), at(10, 15)], [at(13, 0), at(14, 0)]]});
    eq(workedMinutes(a, at(16, 0), manual), 480 - 15 - 90, 'fixed 12:30-13:30 merged with 13:00-14:00');
    eq(breakMinutes(a, at(16, 0), manual), 105);
    const open = iv(a, {openBreak: at(15, 10)});
    eq(workedMinutes(a, at(15, 40), open), 370, 'open break stops the count');
    eq(workedMinutes(a, at(18, 0), open), 370);
});

test('workedMinutes truncates to whole minutes', () => {
    eq(workedMinutes(at(9, 49, 48), at(10, 0, 0), iv(at(9, 49, 48))), 10);
});

test('alertTime: before, inside and after the fixed break', () => {
    eq(formatClock(alertTime(at(8, 30), 480, iv(at(8, 30)))), '17:30', 'spec example');
    eq(formatClock(alertTime(at(8, 30), 240, iv(at(8, 30)))), '12:30', 'lands exactly on break start');
    eq(formatClock(alertTime(at(8, 30), 180, iv(at(8, 30)))), '11:30');
    eq(formatClock(alertTime(at(12, 45), 60, iv(at(12, 45)))), '14:30', 'counts from break end');
    eq(formatClock(alertTime(at(14, 0), 240, iv(at(14, 0)))), '18:00');
});

test('alertTime shifts after manual breaks and is null while an open break runs', () => {
    const a = at(8, 30);
    eq(formatClock(alertTime(a, 480, iv(a, {breaks: [[at(15, 0), at(15, 20)]]}))), '17:50');
    eq(alertTime(a, 480, iv(a, {openBreak: at(15, 10)})), null, 'paused');
    eq(formatClock(alertTime(a, 240, iv(a, {openBreak: at(15, 10)}))), '12:30', 'reached before the open break');
});

test('alertTime is consistent with workedMinutes', () => {
    const extras = [{}, {breaks: [[at(9, 0), at(9, 30)], [at(15, 0), at(16, 0)]]}];
    for (const extra of extras) {
        for (const arrival of [at(7, 0), at(9, 49, 48), at(12, 30), at(13, 10), at(13, 30), at(15, 0)]) {
            for (const minutes of [1, 60, 240, 465, 480]) {
                const intervals = iv(arrival, extra);
                const t = alertTime(arrival, minutes, intervals);
                eq(workedMinutes(arrival, t, intervals), minutes, `${formatClock(arrival)} +${minutes}`);
            }
        }
    }
});

test('remainingMinutes counts down to the target and stops at 0', () => {
    eq(remainingMinutes(at(8, 30), at(16, 0), CFG, iv(at(8, 30))), 90);
    eq(remainingMinutes(at(8, 30), at(19, 0), CFG, iv(at(8, 30))), 0);
    eq(remainingMinutes(at(8, 30), at(16, 0), {...CFG, thresholds: []}, iv(at(8, 30))), 0);
});

test('buildAlerts: work alerts with ids, final flag and fixed-break alerts', () => {
    const alerts = buildAlerts(at(8, 30), CFG, iv(at(8, 30)));
    eq(alerts.map(a => a.id), ['w240', 'w420', 'w465', 'w480', 'break-start', 'break-end']);
    eq(alerts.map(a => formatClock(a.time)), ['12:30', '16:30', '17:15', '17:30', '12:30', '13:30']);
    eq(alerts.filter(a => a.final).map(a => a.id), ['w480']);
});

test('buildAlerts skips break alerts after arrival, when disabled or without a fixed break', () => {
    const breakIds = (arrival, cfg) => buildAlerts(arrival, cfg, iv(arrival)).filter(a => a.kind === 'break').map(a => a.id);
    eq(breakIds(at(12, 45), CFG), ['break-end']);
    eq(breakIds(at(14, 0), CFG), []);
    eq(breakIds(at(8, 30), {...CFG, breakAlerts: false}), []);
    eq(breakIds(at(8, 30), {...CFG, fixedBreak: null}), []);
});

test('buildAlerts with no thresholds', () => {
    eq(buildAlerts(at(8, 30), {...CFG, thresholds: [], breakAlerts: false}, []), []);
});

test('buildAlerts marks work alerts past an open break as paused (time null)', () => {
    const a = at(8, 30);
    const alerts = buildAlerts(a, CFG, iv(a, {openBreak: at(15, 10)}));
    eq(alerts.filter(x => x.kind === 'work').map(x => x.time && formatClock(x.time)), ['12:30', null, null, null]);
});

test('selectDue: nothing due, then exactly one due', () => {
    const alerts = buildAlerts(at(8, 30), CFG, iv(at(8, 30)));
    eq(selectDue(alerts, [], at(10, 0)), {show: [], markFired: []});
    const r = selectDue(alerts, ['break-start', 'break-end'], at(12, 30));
    eq(r.show.map(a => a.id), ['w240']);
    eq(r.markFired, ['w240']);
});

test('selectDue: several missed work alerts -> only the largest is shown', () => {
    const alerts = buildAlerts(at(8, 0), CFG, iv(at(8, 0)));
    const r = selectDue(alerts, [], at(16, 30));
    eq(r.show.map(a => a.id), ['w420']);
    eq([...r.markFired].sort(), ['break-end', 'break-start', 'w240', 'w420']);
});

test('selectDue: already fired alerts are never shown again', () => {
    const alerts = buildAlerts(at(8, 0), CFG, iv(at(8, 0)));
    eq(selectDue(alerts, ['w240', 'w420', 'break-start', 'break-end'], at(16, 30)).show, []);
});

test('selectDue: break alerts on time, latest wins, stale ones are silent', () => {
    const alerts = buildAlerts(at(9, 0), CFG, iv(at(9, 0)));
    eq(selectDue(alerts, [], at(12, 31)).show.map(a => a.id), ['break-start']);
    eq(selectDue(alerts, [], at(13, 35)).show.map(a => a.id), ['break-end'], 'break-start skipped');
    const stale = selectDue(alerts, [], at(13, 41));
    eq(stale.show.map(a => a.id), [], 'more than 10 min late');
    eq([...stale.markFired].sort(), ['break-end', 'break-start']);
});

test('selectDue never fires a paused alert', () => {
    const a = at(8, 0);
    const alerts = buildAlerts(a, CFG, iv(a, {openBreak: at(15, 0)}));
    eq(selectDue(alerts, ['w240', 'break-start', 'break-end'], at(23, 0)).show, []);
});

test('nextAlert: earliest upcoming, then paused, then null', () => {
    const alerts = buildAlerts(at(8, 30), CFG, iv(at(8, 30)));
    eq(nextAlert(alerts, [], at(10, 0)).id, 'w240');
    eq(nextAlert(alerts, ['w240', 'break-start'], at(12, 40)).id, 'break-end');
    eq(nextAlert(alerts, [], at(18, 0)), null);
    const onBreak = buildAlerts(at(8, 30), CFG, iv(at(8, 30), {openBreak: at(15, 10)}));
    const next = nextAlert(onBreak, ['w240', 'break-start', 'break-end'], at(15, 20));
    eq([next.id, next.time], ['w420', null]);
});

test('chooseArrival: boot today -> boot time, otherwise now', () => {
    const now = at(10, 43);
    eq(chooseArrival(now, at(9, 49, 48)).getTime(), at(9, 49, 48).getTime());
    eq(chooseArrival(now, new Date(2026, 8, 29, 18, 0)).getTime(), now.getTime(), 'booted yesterday');
    eq(chooseArrival(now, at(11, 0)).getTime(), now.getTime(), 'boot in the future');
    eq(chooseArrival(now, null).getTime(), now.getTime(), 'unknown boot time');
});

test('thresholdsToSave: nothing is saved while a filled row is invalid', () => {
    eq(thresholdsToSave(['4:00', '7:4x']), null);
    eq(thresholdsToSave(['4:00', '0:00']), null);
    eq(thresholdsToSave(['8:00', '', ' 4:00 ', '4:00']), ['4:00', '8:00'], 'empty rows ignored');
    eq(thresholdsToSave([]), []);
});
````

- [ ] **Step 2: Create `tests/day.test.js`**

````js
import {eq, ok, test} from './harness.js';
import {
    closeDay, computeDay, dayFromInput, inputFromDay, readDay, validateDay, writeDay,
} from '../time-tracker@anjrakot/lib/day.js';

const on = (d, h, m, s = 0) => new Date(2026, 8, d, h, m, s); // September 2026
const NOW = on(30, 10, 0);
const V2 = {
    arrival: '08:02:00', departure: '17:40:00', breaks: [['15:00:00', '15:20:00']],
    openBreak: null, fixedBreak: ['12:30', '13:30'], targetMin: 480, workedMin: 0, overtimeMin: 0,
};

test('day: a v1 entry reads with defaults (fixed 12:30-13:30, 8h, no breaks)', () => {
    const day = readDay('2026-09-29', {arrival: '08:02:00', departure: '17:40:00', workedMin: 518});
    eq(day.fixedBreak, {start: 750, end: 810});
    eq([day.targetMin, day.breaks, day.openBreak], [480, [], null]);
    eq(computeDay(day), {workedMin: 518, overtimeMin: 38, breakMin: 60});
});

test('day: a v2 entry reads breaks, a disabled fixed break and its own target', () => {
    const day = readDay('2026-09-29', {...V2, fixedBreak: null, targetMin: 420});
    eq(day.fixedBreak, null);
    eq(day.breaks.map(([s, e]) => [s.getHours(), s.getMinutes(), e.getMinutes()]), [[15, 0, 20]]);
    eq(computeDay(day), {workedMin: 558, overtimeMin: 138, breakMin: 20});
});

test('day: invalid arrival or key reads as null; bad breaks are dropped', () => {
    eq(readDay('2026-09-29', {arrival: 'oops'}), null);
    eq(readDay('2026-13-01', {arrival: '08:00:00'}), null);
    eq(readDay('2026-09-29', null), null);
    const day = readDay('2026-09-29', {...V2, breaks: [['15:00:00', '14:00:00'], 'x', ['16:00:00', '16:10:00']]});
    eq(day.breaks.length, 1);
});

test('day: an invalid fixedBreak falls back to the default', () => {
    eq(readDay('2026-09-29', {...V2, fixedBreak: ['13:30', '12:30']}).fixedBreak, {start: 750, end: 810});
});

test('day: writeDay recomputes derived fields and round-trips', () => {
    const day = readDay('2026-09-29', V2);
    const entry = writeDay(day);
    eq(entry, {...V2, workedMin: 498, overtimeMin: 18});
    eq(writeDay(readDay('2026-09-29', entry)), entry);
});

test('day: closeDay finishes an open break at departure', () => {
    const day = readDay('2026-09-29', {...V2, breaks: [], openBreak: '16:00:00', departure: '16:00:00'});
    const closed = closeDay(day, on(29, 17, 40));
    eq(closed.openBreak, null);
    eq(closed.breaks.map(([s, e]) => [s.getHours(), e.getHours(), e.getMinutes()]), [[16, 17, 40]]);
    eq(computeDay(closed).workedMin, 418);
    ok(day.openBreak, 'original untouched');
});

test('day: writeDay never writes a departure before arrival', () => {
    const day = readDay('2026-09-29', {...V2, departure: '07:00:00'});
    eq(writeDay(day).departure, '08:02:00');
    eq(writeDay(day).workedMin, 0);
});

test('validateDay: a valid past day has no errors', () => {
    const input = {arrival: '8:02', departure: '17:40', breaks: [['15:00', '15:20']], fixedBreak: ['12:30', '13:30']};
    eq(validateDay(input, '2026-09-29', NOW), []);
    eq(validateDay({...input, fixedBreak: null, breaks: []}, '2026-09-29', NOW), []);
});

test('validateDay: each rule reports its field', () => {
    const fields = (input, key = '2026-09-29') => validateDay(input, key, NOW).map(e => e.field);
    const base = {arrival: '8:00', departure: '17:00', breaks: [], fixedBreak: null};
    eq(fields(base, '2026-10-01'), ['date']);
    eq(fields(base, '2026-09-30'), ['date'], 'today');
    eq(fields(base, 'nope'), ['date']);
    eq(fields({...base, arrival: '8h'}), ['arrival']);
    eq(fields({...base, departure: ''}), ['departure']);
    eq(fields({...base, departure: '7:00'}), ['departure']);
    eq(fields({...base, fixedBreak: ['13:30', '12:30']}), ['fixedBreak']);
    eq(fields({...base, breaks: [['15:00', '14:00']]}), ['breaks.0']);
    eq(fields({...base, breaks: [['7:00', '8:30'], ['9:00', '9:10']]}), ['breaks.0'], 'before arrival');
    eq(fields({...base, breaks: [['16:50', '17:10']]}), ['breaks.0'], 'after departure');
});

test('validateDay messages are readable', () => {
    const [error] = validateDay({arrival: '9:00', departure: '8:00', breaks: []}, '2026-09-29', NOW);
    eq(error.message, 'Departure must be after arrival');
});

test('dayFromInput and inputFromDay are inverse (seconds dropped)', () => {
    const input = {arrival: '8:02', departure: '17:40', breaks: [['15:00', '15:20']], fixedBreak: ['12:30', '13:30']};
    const day = dayFromInput('2026-09-29', input, 480);
    eq(computeDay(day), {workedMin: 498, overtimeMin: 18, breakMin: 80});
    eq(inputFromDay(day), input);
});

test('validateDay: adding a day that already exists is refused', () => {
    const input = {arrival: '8:00', departure: '17:00', breaks: [], fixedBreak: null};
    eq(validateDay(input, '2026-09-29', NOW, {adding: true, exists: true}).map(e => e.message),
        ['This day already exists: edit it in the list']);
    eq(validateDay(input, '2026-09-29', NOW, {adding: true, exists: false}), []);
    eq(validateDay(input, '2026-09-29', NOW, {adding: false, exists: true}), [], 'editing it is fine');
});
````

- [ ] **Step 3: Replace `tests/tracker.test.js`**

````js
import {eq, ok, test} from './harness.js';
import {configFrom} from '../time-tracker@anjrakot/lib/timecalc.js';
import {SAVE_EVERY_TICKS, Tracker, UserError} from '../time-tracker@anjrakot/lib/tracker.js';

const day = (d, h, m, s = 0) => new Date(2026, 8, d, h, m, s); // September 2026
const at = (h, m, s = 0) => day(30, h, m, s);
const CFG = configFrom({
    thresholds: ['4:00', '7:00', '7:45', '8:00'],
    fixedBreak: true,
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
    eq([v.workedMin, v.remainingMin, v.targetMin, v.overtimeMin], [270, 210, 480, -210]);
    eq(v.next, {label: '7h', time: '16:30'});
    eq([v.arrival, v.leaveAt, v.onBreak, v.fixedBreak], ['08:30:00', '17:30', false, ['12:30', '13:30']]);
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
    cfg = configFrom({thresholds: ['4:00', '6:00', '8:00'], fixedBreak: true, breakStart: '12:30', breakEnd: '13:30', breakAlerts: false});
    clock.now = at(15, 1);
    eq(tracker.tick().map(m => m.title), ['⏱ 6h done'], 'new past threshold fires once');
    clock.now = at(15, 2);
    eq(tracker.tick(), []);
});

test('tracker: with no thresholds there are no work alerts and the view still works', () => {
    const cfg = configFrom({thresholds: [], fixedBreak: true, breakStart: '12:30', breakEnd: '13:30', breakAlerts: false});
    const {clock, tracker} = setup({now: at(8, 0), boot: at(8, 0), cfg});
    tracker.tick();
    clock.now = at(18, 0);
    eq(tracker.tick(), []);
    const v = tracker.view();
    eq([v.workedMin, v.remainingMin, v.next, v.leaveAt], [540, 0, null, null]);
});

test('tracker: a failing store never throws from tick and view keeps working', () => {
    const store = new FakeStore();
    store._set = () => {
        throw new Error('disk full');
    };
    const {tracker} = setup({store});
    eq(tracker.tick(), []);
    eq(tracker.view().workedMin, 53);
});

test('tracker: a failing store still delivers due notifications', () => {
    const store = new FakeStore();
    const {clock, tracker} = setup({store, now: at(8, 0), boot: at(8, 0)});
    tracker.tick();
    store._set = () => {
        throw new Error('disk full');
    };
    clock.now = at(12, 0);
    eq(tracker.tick().map(m => m.title), ['⏱ 4h done']);
    clock.now = at(12, 1);
    eq(tracker.tick(), [], 'not repeated within the session');
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
    eq(tracker.view().workedMin, 0);
});

test('tracker: moveTo carries arrival and fired alerts into the new folder', () => {
    const oldStore = new FakeStore();
    const newStore = new FakeStore();
    const {clock, tracker} = setup({store: oldStore, now: at(8, 0), boot: at(8, 0)});
    tracker.tick();
    clock.now = at(12, 0);
    eq(tracker.tick().map(m => m.title), ['⏱ 4h done']);
    clock.now = at(12, 5);
    tracker.moveTo(newStore);
    eq(newStore.loadMonth('2026-09')['2026-09-30'].arrival, '08:00:00');
    eq(newStore.loadState(), {date: '2026-09-30', fired: ['w240']});
    eq(oldStore.loadMonth('2026-09')['2026-09-30'].departure, '12:05:00', 'old folder closed');
    clock.now = at(12, 6);
    eq(tracker.tick(), []);
    const restarted = setup({store: newStore, now: at(13, 0), boot: at(12, 59)});
    eq(restarted.tracker.tick(), [], 'no repeat after a restart either');
    eq(restarted.tracker.arrival.getTime(), at(8, 0).getTime());
});

test('tracker: moveTo works when the old folder is failing', () => {
    const oldStore = new FakeStore();
    const newStore = new FakeStore();
    const {tracker} = setup({store: oldStore});
    tracker.tick();
    oldStore._set = () => {
        throw new Error('gone');
    };
    tracker.moveTo(newStore);
    eq(newStore.loadMonth('2026-09')['2026-09-30'].arrival, '09:49:48');
});

test('tracker: a hand-edited arrival in the month file is adopted', () => {
    const {store, clock, tracker} = setup();
    tracker.tick();
    const month = store.loadMonth('2026-09');
    month['2026-09-30'].arrival = '8:05';
    store.saveMonth('2026-09', month);
    clock.now = at(11, 0);
    tracker.stop();
    eq(tracker.arrival.getTime(), at(8, 5).getTime());
    eq(store.loadMonth('2026-09')['2026-09-30'].arrival, '08:05:00');
    clock.now = at(12, 6);
    eq(tracker.tick().map(m => m.title), ['⏱ 4h done']);
});

test('tracker: resetArrival wins over a pending hand edit', () => {
    const {store, clock, tracker} = setup();
    tracker.tick();
    const month = store.loadMonth('2026-09');
    month['2026-09-30'].arrival = '08:00:00';
    store.saveMonth('2026-09', month);
    clock.now = at(14, 0);
    tracker.resetArrival();
    eq(tracker.arrival.getTime(), at(14, 0).getTime());
    eq(store.loadMonth('2026-09')['2026-09-30'].arrival, '14:00:00');
});

function throwsUserError(fn, message) {
    try {
        fn();
    } catch (e) {
        ok(e instanceof UserError, `expected a UserError, got ${e}`);
        eq(e.message, message);
        return;
    }
    throw new Error(`expected "${message}"`);
}

test('tracker: history entries record breaks, fixed break and target', () => {
    const {store, tracker} = setup();
    tracker.tick();
    eq(store.loadMonth('2026-09')['2026-09-30'], {
        arrival: '09:49:48', departure: '10:43:00', breaks: [], openBreak: null,
        fixedBreak: ['12:30', '13:30'], targetMin: 480, workedMin: 53, overtimeMin: -427,
    });
});

test('tracker: start and finish a break; worked time excludes it', () => {
    const {store, clock, tracker} = setup({now: at(8, 0), boot: at(8, 0)});
    tracker.tick();
    clock.now = at(15, 10);
    tracker.startBreak();
    eq(store.loadMonth('2026-09')['2026-09-30'].openBreak, '15:10:00');
    clock.now = at(15, 40);
    const onBreak = tracker.view();
    eq([onBreak.onBreak, onBreak.openBreak, onBreak.workedMin, onBreak.leaveAt], [true, '15:10:00', 370, null]);
    tracker.finishBreak();
    const entry = store.loadMonth('2026-09')['2026-09-30'];
    eq([entry.openBreak, entry.breaks], [null, [['15:10:00', '15:40:00']]]);
    eq(tracker.view().leaveAt, '17:30', '8h + 1h fixed + 30min manual');
});

test('tracker: break actions refuse the wrong state', () => {
    const {tracker} = setup();
    tracker.tick();
    throwsUserError(() => tracker.finishBreak(), 'No break in progress');
    tracker.startBreak();
    throwsUserError(() => tracker.startBreak(), 'Already on a break');
});

test('tracker: work alerts pause during a break and move later after it', () => {
    const {clock, tracker} = setup({now: at(8, 0), boot: at(8, 0)});
    tracker.tick();
    clock.now = at(15, 0);
    tracker.tick();
    tracker.startBreak();
    clock.now = at(16, 30);
    eq(tracker.tick(), [], 'no 7h alert while on break');
    eq(tracker.view().next, {label: '7h', paused: true});
    tracker.finishBreak();
    clock.now = at(17, 29);
    eq(tracker.tick(), []);
    clock.now = at(17, 30);
    eq(tracker.tick().map(m => m.title), ['⏱ 7h done'], '16:00 + 1h30 of break');
});

test('tracker: an open break survives a restart', () => {
    const {store, clock, tracker} = setup();
    tracker.tick();
    clock.now = at(15, 10);
    tracker.startBreak();
    tracker.stop();
    const again = setup({store, now: at(15, 30), boot: at(15, 25)});
    again.tracker.tick();
    eq(again.tracker.view().openBreak, '15:10:00');
    again.tracker.finishBreak();
    eq(store.loadMonth('2026-09')['2026-09-30'].breaks, [['15:10:00', '15:30:00']]);
});

test('tracker: crossing midnight with an open break closes it at the last tick', () => {
    const {store, clock, tracker} = setup({now: day(30, 22, 0), boot: day(30, 9, 0)});
    tracker.tick();
    tracker.startBreak();
    clock.now = day(30, 22, 30);
    tracker.tick();
    clock.now = new Date(2026, 9, 1, 0, 0, 30);
    tracker.tick();
    const closed = store.loadMonth('2026-09')['2026-09-30'];
    eq([closed.openBreak, closed.breaks, closed.departure], [null, [['22:00:00', '22:30:00']], '22:30:00']);
    eq(tracker.view().onBreak, false, 'the new day starts without a break');
});

test('tracker: the fixed break switched off counts the lunch hour as work', () => {
    const cfg = configFrom({thresholds: ['8:00'], fixedBreak: false, breakStart: '12:30', breakEnd: '13:30', breakAlerts: true});
    const {store, clock, tracker} = setup({now: at(8, 0), boot: at(8, 0), cfg});
    tracker.tick();
    clock.now = at(16, 0);
    eq(tracker.tick().map(m => m.title), ['⏱ 8h done']);
    eq(store.loadMonth('2026-09')['2026-09-30'].fixedBreak, null);
});

test('tracker: setArrival moves arrival, clears fired alerts and refuses the future', () => {
    const {store, clock, tracker} = setup({now: at(12, 0), boot: at(8, 0)});
    eq(tracker.tick().map(m => m.title), ['⏱ 4h done']);
    tracker.setArrival('7:30');
    eq(store.loadMonth('2026-09')['2026-09-30'].arrival, '07:30:00');
    eq(store.loadState().fired, []);
    clock.now = at(12, 1);
    eq(tracker.tick().map(m => m.title), ['⏱ 4h done'], 'catch-up for the new arrival');
    throwsUserError(() => tracker.setArrival('13:00'), 'Arrival cannot be in the future');
    throwsUserError(() => tracker.setArrival('7h30'), 'Arrival: use H:MM');
});

test('tracker: saveDay edits a past day and keeps its own target', () => {
    const store = new FakeStore();
    store.saveMonth('2026-09', {'2026-09-29': {arrival: '08:02:00', departure: '17:40:00', targetMin: 420}});
    const {tracker} = setup({store});
    tracker.tick();
    tracker.saveDay('2026-09-29', {arrival: '8:00', departure: '17:00', breaks: [['15:00', '15:30']], fixedBreak: null});
    eq(store.loadMonth('2026-09')['2026-09-29'], {
        arrival: '08:00:00', departure: '17:00:00', breaks: [['15:00:00', '15:30:00']], openBreak: null,
        fixedBreak: null, targetMin: 420, workedMin: 510, overtimeMin: 90,
    });
    eq(store.loadMonth('2026-09')['2026-09-30'].arrival, '09:49:48', 'today untouched');
});

test('tracker: saveDay adds a missing day with the current target, in its own month', () => {
    const {store, tracker} = setup();
    tracker.tick();
    tracker.saveDay('2026-08-31', {arrival: '9:00', departure: '18:00', breaks: [], fixedBreak: ['12:30', '13:30']});
    eq(store.loadMonth('2026-08')['2026-08-31'].workedMin, 480);
    eq(store.loadMonth('2026-08')['2026-08-31'].targetMin, 480);
});

test('tracker: saveDay refuses invalid input and today', () => {
    const {tracker} = setup();
    tracker.tick();
    throwsUserError(() => tracker.saveDay('2026-09-29', {arrival: '9:00', departure: '8:00', breaks: []}),
        'Departure must be after arrival');
    throwsUserError(() => tracker.saveDay('2026-09-30', {arrival: '8:00', departure: '9:00', breaks: []}),
        'Today is edited on the Today page');
});

test('tracker: deleteDay removes past days only', () => {
    const store = new FakeStore();
    store.saveMonth('2026-09', {'2026-09-29': {arrival: '08:00:00', departure: '17:00:00'}});
    const {tracker} = setup({store});
    tracker.tick();
    tracker.deleteDay('2026-09-29');
    eq(Object.keys(store.loadMonth('2026-09')), ['2026-09-30']);
    throwsUserError(() => tracker.deleteDay('2026-09-29'), 'No entry for 2026-09-29');
    throwsUserError(() => tracker.deleteDay('2026-09-30'), 'Only past days can be deleted');
    throwsUserError(() => tracker.deleteDay('yesterday'), 'Invalid date');
});

test('tracker: a v1 entry for today (upgrade mid-day) keeps its arrival and gains v2 fields', () => {
    const store = new FakeStore();
    store.saveMonth('2026-09', {'2026-09-30': {arrival: '08:10:00', departure: '10:00:00', workedMin: 110}});
    const {tracker} = setup({store});
    tracker.tick();
    const entry = store.loadMonth('2026-09')['2026-09-30'];
    eq([entry.arrival, entry.breaks, entry.fixedBreak, entry.targetMin], ['08:10:00', [], ['12:30', '13:30'], 480]);
});

test('tracker: a past-day edit survives the next saves of today', () => {
    const store = new FakeStore();
    const {clock, tracker} = setup({store});
    tracker.tick();
    tracker.saveDay('2026-09-29', {arrival: '8:00', departure: '17:00', breaks: [], fixedBreak: ['12:30', '13:30']});
    for (let i = 1; i <= SAVE_EVERY_TICKS; i++) {
        clock.now = new Date(at(10, 43).getTime() + i * 60000);
        tracker.tick();
    }
    tracker.stop();
    eq(store.loadMonth('2026-09')['2026-09-29'].departure, '17:00:00');
});

test('tracker: settings changed mid-day apply to today only', () => {
    let cfg = CFG;
    const store = new FakeStore();
    store.saveMonth('2026-09', {'2026-09-29': {arrival: '08:00:00', departure: '17:00:00', fixedBreak: ['12:30', '13:30'], targetMin: 480}});
    const clock = {now: at(10, 0)};
    const tracker = new Tracker({store, config: () => cfg, now: () => clock.now, bootTime: () => at(8, 0)});
    tracker.tick();
    cfg = configFrom({thresholds: ['7:00'], fixedBreak: false, breakStart: '12:30', breakEnd: '13:30', breakAlerts: true});
    clock.now = at(11, 0);
    tracker.stop();
    const month = store.loadMonth('2026-09');
    eq([month['2026-09-30'].targetMin, month['2026-09-30'].fixedBreak], [420, null]);
    eq([month['2026-09-29'].targetMin, month['2026-09-29'].fixedBreak], [480, ['12:30', '13:30']]);
});
````

- [ ] **Step 4: Replace `tests/run.js`**

````js
// Entry point: gjs -m tests/run.js
import {run} from './harness.js';
import './timecalc.test.js';
import './store.test.js';
import './tracker.test.js';
import './day.test.js';

run();
````

- [ ] **Step 5: Run the tests and confirm they fail**

Run: `gjs -m tests/run.js`
Expected: FAIL. gjs prints `Failed to resolve imports for module: '…/tests/run.js'` and exits 1, because `lib/day.js` does not exist yet and the new timecalc exports are missing.

- [ ] **Step 6: Replace `time-tracker@anjrakot/lib/timecalc.js`**

````js
// Pure time maths for the tracker. No gi:// imports so it runs under plain `gjs -m`.
// All Dates are local time; durations are whole minutes. Break intervals are
// [startMs, endMs] pairs; an open break ends at Infinity.

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

/** 25 -> "+0h25", -70 -> "−1h10", 0 -> "+0h00". */
export function formatSigned(minutes) {
    const abs = Math.abs(minutes);
    return `${minutes < 0 ? '−' : '+'}${Math.floor(abs / 60)}h${pad(abs % 60)}`;
}

/** Date -> "09:49". */
export function formatClock(date) {
    return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Date -> "09:49:48". */
export function formatClockSec(date) {
    return `${formatClock(date)}:${pad(date.getSeconds())}`;
}

/** "09:49:48", "09:49" or "9:49" on the local date of `day` -> Date, or null if invalid. */
export function parseClock(day, text) {
    const m = /^(\d{1,2}):([0-5]\d)(?::([0-5]\d))?$/.exec(String(text));
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

/** "2026-09-30" -> local midnight Date, or null if invalid. */
export function dateFromKey(key) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key));
    if (!m)
        return null;
    const date = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return dateKey(date) === key ? date : null;
}

/** Minutes since midnight -> Date on the local date of `day`. */
export function atMinutes(day, minutes) {
    return new Date(day.getFullYear(), day.getMonth(), day.getDate(),
        Math.floor(minutes / 60), minutes % 60);
}

/** Settings strings -> sorted, de-duplicated positive minutes; invalid entries dropped. */
export function parseThresholds(list) {
    const minutes = list.map(parseHM).filter(m => m !== null && m > 0);
    return [...new Set(minutes)].sort((a, b) => a - b);
}

/** Prefs rows -> settings list, or null when a filled row is invalid (then nothing is saved). */
export function thresholdsToSave(texts) {
    const filled = texts.map(t => t.trim()).filter(t => t !== '');
    if (filled.some(t => !((parseHM(t) ?? 0) > 0)))
        return null;
    return parseThresholds(filled).map(formatHM);
}

/**
 * Raw settings values -> validated config
 * {thresholds, fixedBreak: {start, end} | null, breakAlerts}.
 * An invalid fixed break falls back to 12:30-13:30.
 */
export function configFrom({thresholds, fixedBreak, breakStart, breakEnd, breakAlerts}) {
    let start = parseHM(breakStart);
    let end = parseHM(breakEnd);
    if (start === null || end === null || end <= start) {
        start = DEFAULT_BREAK_START;
        end = DEFAULT_BREAK_END;
    }
    return {
        thresholds: parseThresholds(thresholds),
        fixedBreak: fixedBreak ? {start, end} : null,
        breakAlerts: Boolean(breakAlerts),
    };
}

/** The day's target: the largest threshold, or 0 when there are none. */
export function targetOf(cfg) {
    return cfg.thresholds.length ? cfg.thresholds[cfg.thresholds.length - 1] : 0;
}

/** Sort and merge overlapping or touching [start, end] pairs. */
export function mergeIntervals(list) {
    const sorted = list.filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const [s, e] of sorted) {
        const last = merged[merged.length - 1];
        if (last && s <= last[1])
            last[1] = Math.max(last[1], e);
        else
            merged.push([s, e]);
    }
    return merged;
}

/**
 * The day's merged break intervals: the fixed break ({start, end} minutes on the
 * date of `arrival`, or null), the finished manual breaks ([Date, Date] pairs) and
 * the open break (a Date, running until Infinity, or null).
 */
export function breakIntervals(arrival, {fixedBreak = null, breaks = [], openBreak = null}) {
    const list = breaks.map(([s, e]) => [s.getTime(), e.getTime()]);
    if (fixedBreak)
        list.push([atMinutes(arrival, fixedBreak.start).getTime(), atMinutes(arrival, fixedBreak.end).getTime()]);
    if (openBreak)
        list.push([openBreak.getTime(), Infinity]);
    return mergeIntervals(list);
}

function overlapMs(arrival, t, intervals) {
    const a = arrival.getTime();
    const b = t.getTime();
    return intervals.reduce((sum, [s, e]) => sum + Math.max(0, Math.min(b, e) - Math.max(a, s)), 0);
}

/** Whole minutes worked between `arrival` and `t`, excluding the breaks. */
export function workedMinutes(arrival, t, intervals) {
    if (t <= arrival)
        return 0;
    return Math.floor((t - arrival - overlapMs(arrival, t, intervals)) / MINUTE_MS);
}

/** Whole minutes of break between `arrival` and `t`. */
export function breakMinutes(arrival, t, intervals) {
    if (t <= arrival)
        return 0;
    return Math.round(overlapMs(arrival, t, intervals) / MINUTE_MS);
}

/** The instant at which workedMinutes reaches `minutes`, or null while paused by an open break. */
export function alertTime(arrival, minutes, intervals) {
    let need = minutes * MINUTE_MS;
    let cursor = arrival.getTime();
    for (const [s, e] of intervals) {
        if (e <= cursor)
            continue;
        if (s > cursor) {
            if (need <= s - cursor)
                return new Date(cursor + need);
            need -= s - cursor;
        }
        if (e === Infinity)
            return null;
        cursor = e;
    }
    return new Date(cursor + need);
}

/** Minutes left until the target (0 once reached or with no thresholds). */
export function remainingMinutes(arrival, now, cfg, intervals) {
    return Math.max(0, targetOf(cfg) - workedMinutes(arrival, now, intervals));
}

/**
 * All alerts for a day, as {id, kind: 'work'|'break', time: Date|null, minutes?, final?}.
 * A work alert's time is null while paused by an open break. Break alerts exist only
 * for the fixed break, when enabled, and when arrival is before them.
 */
export function buildAlerts(arrival, cfg, intervals) {
    const last = targetOf(cfg);
    const alerts = cfg.thresholds.map(minutes => ({
        id: `w${minutes}`,
        kind: 'work',
        minutes,
        final: minutes === last,
        time: alertTime(arrival, minutes, intervals),
    }));
    if (cfg.fixedBreak && cfg.breakAlerts) {
        const bs = atMinutes(arrival, cfg.fixedBreak.start);
        const be = atMinutes(arrival, cfg.fixedBreak.end);
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
    const due = alerts.filter(a => a.time !== null && a.time <= now && !fired.includes(a.id));
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

/** The earliest timed alert still to come; otherwise the first paused one; otherwise null. */
export function nextAlert(alerts, fired, now) {
    const pending = alerts.filter(a => !fired.includes(a.id));
    const timed = pending.filter(a => a.time !== null && a.time > now);
    if (timed.length)
        return timed.reduce((a, b) => (b.time < a.time ? b : a));
    const paused = pending.filter(a => a.time === null);
    return paused.length ? paused.reduce((a, b) => (b.minutes < a.minutes ? b : a)) : null;
}

/** Arrival rule: boot time when the machine was started today, otherwise now. */
export function chooseArrival(now, bootTime) {
    if (bootTime && dateKey(bootTime) === dateKey(now) && bootTime <= now)
        return bootTime;
    return now;
}
````

- [ ] **Step 7: Create `time-tracker@anjrakot/lib/day.js`**

````js
// One day of history: JSON entry <-> Day, recalculation and validation.
// Pure (no gi:// imports): shared by the extension and the app.
//
// Day = {date: "YYYY-MM-DD", arrival: Date, departure: Date|null,
//        breaks: [[Date, Date]], openBreak: Date|null,
//        fixedBreak: {start, end}|null (minutes), targetMin: number}
import {
    DEFAULT_BREAK_END, DEFAULT_BREAK_START, atMinutes, breakIntervals, breakMinutes,
    dateFromKey, dateKey, formatClockSec, formatHM, parseClock, parseHM, workedMinutes,
} from './timecalc.js';

export const DEFAULT_TARGET_MIN = 480;
const DEFAULT_FIXED = {start: DEFAULT_BREAK_START, end: DEFAULT_BREAK_END};

function readFixed(value) {
    if (value === null)
        return null;
    if (!Array.isArray(value))
        return {...DEFAULT_FIXED}; // v1 entry: the default fixed break applied
    const start = parseHM(value[0]);
    const end = parseHM(value[1]);
    return start !== null && end !== null && end > start ? {start, end} : {...DEFAULT_FIXED};
}

/** JSON entry -> Day, filling v1 defaults. Null when the arrival is missing or invalid. */
export function readDay(key, entry) {
    const day = dateFromKey(key);
    const arrival = day && entry && parseClock(day, entry.arrival);
    if (!arrival)
        return null;
    const breaks = (Array.isArray(entry.breaks) ? entry.breaks : [])
        .map(pair => (Array.isArray(pair) ? [parseClock(day, pair[0]), parseClock(day, pair[1])] : []))
        .filter(([s, e]) => s && e && e > s);
    return {
        date: key,
        arrival,
        departure: parseClock(day, entry.departure),
        breaks,
        openBreak: entry.openBreak ? parseClock(day, entry.openBreak) : null,
        fixedBreak: readFixed(entry.fixedBreak),
        targetMin: Number.isInteger(entry.targetMin) && entry.targetMin >= 0 ? entry.targetMin : DEFAULT_TARGET_MIN,
    };
}

/** The day's merged break intervals. */
export function intervalsOf(day) {
    return breakIntervals(day.arrival, day);
}

/** Worked, overtime and break minutes from arrival until `until` (default: departure). */
export function computeDay(day, until = day.departure ?? day.arrival) {
    const intervals = intervalsOf(day);
    const workedMin = workedMinutes(day.arrival, until, intervals);
    return {
        workedMin,
        overtimeMin: workedMin - day.targetMin,
        breakMin: breakMinutes(day.arrival, until, intervals),
    };
}

/** A copy of the day ended at `departure`; an open break is finished there. */
export function closeDay(day, departure) {
    const breaks = [...day.breaks];
    if (day.openBreak && day.openBreak < departure)
        breaks.push([day.openBreak, departure]);
    return {...day, departure, breaks, openBreak: null};
}

/** Day -> JSON entry, with workedMin and overtimeMin recomputed. */
export function writeDay(day) {
    const departure = day.departure && day.departure > day.arrival ? day.departure : day.arrival;
    const {workedMin, overtimeMin} = computeDay(day, departure);
    return {
        arrival: formatClockSec(day.arrival),
        departure: formatClockSec(departure),
        breaks: day.breaks.map(([s, e]) => [formatClockSec(s), formatClockSec(e)]),
        openBreak: day.openBreak ? formatClockSec(day.openBreak) : null,
        fixedBreak: day.fixedBreak ? [formatHM(day.fixedBreak.start), formatHM(day.fixedBreak.end)] : null,
        targetMin: day.targetMin,
        workedMin,
        overtimeMin,
    };
}

/**
 * Check a day typed in the dialog: {arrival, departure, breaks: [[s, e]], fixedBreak: [s, e]|null},
 * all "H:MM". Returns [{field, message}]; empty when valid. Past days only. When adding a
 * day, pass `{adding: true, exists}` so an existing day is not overwritten by mistake.
 */
export function validateDay(input, key, now, {adding = false, exists = false} = {}) {
    const errors = [];
    const day = dateFromKey(key);
    if (!day)
        errors.push({field: 'date', message: 'Invalid date'});
    else if (key > dateKey(now))
        errors.push({field: 'date', message: 'The date is in the future'});
    else if (key === dateKey(now))
        errors.push({field: 'date', message: 'Today is edited on the Today page'});
    else if (adding && exists)
        errors.push({field: 'date', message: 'This day already exists: edit it in the list'});

    const arrival = parseHM(input.arrival ?? '');
    const departure = parseHM(input.departure ?? '');
    if (arrival === null)
        errors.push({field: 'arrival', message: 'Arrival: use H:MM'});
    if (departure === null)
        errors.push({field: 'departure', message: 'Departure: use H:MM'});
    if (arrival !== null && departure !== null && departure <= arrival)
        errors.push({field: 'departure', message: 'Departure must be after arrival'});

    if (input.fixedBreak) {
        const s = parseHM(input.fixedBreak[0] ?? '');
        const e = parseHM(input.fixedBreak[1] ?? '');
        if (s === null || e === null || e <= s)
            errors.push({field: 'fixedBreak', message: 'Fixed break: end must be after start (H:MM)'});
    }

    (input.breaks ?? []).forEach(([start, end], i) => {
        const s = parseHM(start ?? '');
        const e = parseHM(end ?? '');
        if (s === null || e === null || e <= s)
            errors.push({field: `breaks.${i}`, message: `Break ${i + 1}: end must be after start (H:MM)`});
        else if (arrival !== null && departure !== null && (s < arrival || e > departure))
            errors.push({field: `breaks.${i}`, message: `Break ${i + 1} must be between arrival and departure`});
    });
    return errors;
}

/** A valid dialog input (see validateDay) -> Day. */
export function dayFromInput(key, input, targetMin) {
    const day = dateFromKey(key);
    const at = text => atMinutes(day, parseHM(text));
    return {
        date: key,
        arrival: at(input.arrival),
        departure: at(input.departure),
        breaks: (input.breaks ?? []).map(([s, e]) => [at(s), at(e)]),
        openBreak: null,
        fixedBreak: input.fixedBreak ? {start: parseHM(input.fixedBreak[0]), end: parseHM(input.fixedBreak[1])} : null,
        targetMin,
    };
}

/** Day -> dialog input with "H:MM" strings (seconds dropped). */
export function inputFromDay(day) {
    const hm = date => formatHM(date.getHours() * 60 + date.getMinutes());
    return {
        arrival: hm(day.arrival),
        departure: hm(day.departure ?? day.arrival),
        breaks: day.breaks.map(([s, e]) => [hm(s), hm(e)]),
        fixedBreak: day.fixedBreak ? [formatHM(day.fixedBreak.start), formatHM(day.fixedBreak.end)] : null,
    };
}
````

- [ ] **Step 8: Replace `time-tracker@anjrakot/lib/tracker.js`**

````js
// Day bookkeeping: arrival, breaks, last seen, fired alerts, and edits of past days.
// No gi:// imports; the clock, boot time, config and store are injected so this
// runs under plain `gjs -m`.
import {closeDay, dayFromInput, readDay, validateDay, writeDay} from './day.js';
import {
    alertTime, atMinutes, breakIntervals, buildAlerts, chooseArrival, dateFromKey, dateKey,
    formatClock, formatClockSec, formatDuration, formatHM, monthKey, nextAlert, parseClock,
    parseHM, remainingMinutes, selectDue, targetOf, workedMinutes,
} from './timecalc.js';

export const SAVE_EVERY_TICKS = 5;

/** An action refused because of what the user asked (shown to them as is). */
export class UserError extends Error {}

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
        this._breaks = [];
        this._openBreak = null;
        this._fired = [];
        this._ticks = 0;
        this._lastTick = null;
        this._writtenArrival = null;
    }

    get arrival() {
        return this._arrival;
    }

    /**
     * Run once a minute. Returns the notifications to show: [{title, body, urgent}].
     * Save failures are logged, never thrown, so due alerts are always delivered.
     */
    tick() {
        const now = this._now();
        this._ensureDay(now);
        this._lastTick = now;

        const cfg = this._config();
        const {show, markFired} = selectDue(buildAlerts(this._arrival, cfg, this._intervals(cfg)), this._fired, now);
        const messages = show.map(alert => this._message(alert, now, cfg));
        if (markFired.length) {
            this._fired.push(...markFired);
            this._trySave('state', () => this._saveState());
        }
        if (this._ticks++ % SAVE_EVERY_TICKS === 0)
            this._trySave('history', () => this._saveLastSeen(now));
        return messages;
    }

    /** Today, JSON-friendly: what the top bar and GetToday show. */
    view() {
        const now = this._now();
        this._ensureDay(now);
        const cfg = this._config();
        const intervals = this._intervals(cfg);
        const targetMin = targetOf(cfg);
        const workedMin = workedMinutes(this._arrival, now, intervals);
        const next = nextAlert(buildAlerts(this._arrival, cfg, intervals), this._fired, now);
        const leave = targetMin > 0 ? alertTime(this._arrival, targetMin, intervals) : null;
        return {
            date: this._day,
            arrival: formatClockSec(this._arrival),
            workedMin,
            targetMin,
            overtimeMin: workedMin - targetMin,
            remainingMin: remainingMinutes(this._arrival, now, cfg, intervals),
            onBreak: this._openBreak !== null,
            openBreak: this._openBreak && formatClockSec(this._openBreak),
            breaks: this._breaks.map(([s, e]) => [formatClockSec(s), formatClockSec(e)]),
            fixedBreak: cfg.fixedBreak && [formatHM(cfg.fixedBreak.start), formatHM(cfg.fixedBreak.end)],
            next: next && (next.time
                ? {label: alertLabel(next), time: formatClock(next.time)}
                : {label: alertLabel(next), paused: true}),
            leaveAt: leave && formatClock(leave),
        };
    }

    startBreak() {
        const now = this._now();
        this._ensureDay(now);
        if (this._openBreak)
            throw new UserError('Already on a break');
        this._openBreak = wholeSeconds(now);
        this._trySave('history', () => this._saveLastSeen(now));
    }

    finishBreak() {
        const now = this._now();
        this._ensureDay(now);
        if (!this._openBreak)
            throw new UserError('No break in progress');
        const end = wholeSeconds(now);
        if (end > this._openBreak)
            this._breaks.push([this._openBreak, end]);
        this._openBreak = null;
        this._trySave('history', () => this._saveLastSeen(now));
    }

    /** "Set arrival…": today at "H:MM" (not in the future); today's fired alerts cleared. */
    setArrival(text) {
        const now = this._now();
        this._ensureDay(now);
        const minutes = parseHM(text);
        if (minutes === null)
            throw new UserError('Arrival: use H:MM');
        const arrival = atMinutes(now, minutes);
        if (arrival > now)
            throw new UserError('Arrival cannot be in the future');
        this._arrival = arrival;
        this._fired = [];
        this._trySave('state', () => this._saveState());
        this._trySave('history', () => this._saveLastSeen(now, {adopt: false}));
    }

    /** "Reset arrival to now": new arrival, today's fired alerts cleared. */
    resetArrival() {
        const now = this._now();
        this._ensureDay(now);
        this._arrival = wholeSeconds(now);
        this._fired = [];
        this._trySave('state', () => this._saveState());
        this._trySave('history', () => this._saveLastSeen(now, {adopt: false}));
    }

    /**
     * Edit or add a past day from dialog input (see day.validateDay). The day keeps its
     * own target; a new day gets the current one. Save errors are thrown.
     */
    saveDay(key, input) {
        const errors = validateDay(input, key, this._now());
        if (errors.length)
            throw new UserError(errors.map(e => e.message).join('\n'));
        const month = this._store.loadMonth(key.slice(0, 7));
        const targetMin = readDay(key, month[key])?.targetMin ?? targetOf(this._config());
        month[key] = writeDay(dayFromInput(key, input, targetMin));
        this._store.saveMonth(key.slice(0, 7), month);
    }

    /** Remove a past day. Save errors are thrown. */
    deleteDay(key) {
        if (!dateFromKey(key))
            throw new UserError('Invalid date');
        if (key >= dateKey(this._now()))
            throw new UserError('Only past days can be deleted');
        const month = this._store.loadMonth(key.slice(0, 7));
        if (!(key in month))
            throw new UserError(`No entry for ${key}`);
        delete month[key];
        this._store.saveMonth(key.slice(0, 7), month);
    }

    /** Called from disable() and on session shutdown: record departure. */
    stop() {
        if (this._day === null)
            return;
        const now = this._now();
        if (dateKey(now) === this._day)
            this._trySave('history', () => this._saveLastSeen(now));
        else
            this._trySave('history', () => this._saveLastSeen(this._lastTick, {close: true}));
    }

    /** History folder changed: close today in the old store, carry today into the new one. */
    moveTo(store) {
        this.stop();
        this._store = store;
        if (this._day === null)
            return;
        this._trySave('state', () => {
            const state = store.loadState();
            if (state.date === this._day && Array.isArray(state.fired))
                this._fired = [...new Set([...this._fired, ...state.fired.filter(id => typeof id === 'string')])];
            this._saveState();
        });
        this._trySave('history', () => this._saveLastSeen(this._now(), {adopt: false}));
    }

    _ensureDay(now) {
        const key = dateKey(now);
        if (this._day === key)
            return;
        if (this._day !== null && this._lastTick !== null)
            this._trySave('history', () => this._saveLastSeen(this._lastTick, {close: true})); // close the previous day
        this._day = key;
        this._ticks = 0;

        // Read everything first so a failing write cannot leave the day half-loaded.
        const month = this._store.loadMonth(monthKey(now));
        const state = this._store.loadState();
        const saved = readDay(key, month[key]);
        this._arrival = saved ? saved.arrival : wholeSeconds(chooseArrival(now, this._bootTime()));
        this._breaks = saved ? saved.breaks : [];
        this._openBreak = saved ? saved.openBreak : null;
        const sameDay = state.date === key && Array.isArray(state.fired);
        this._fired = sameDay ? state.fired.filter(id => typeof id === 'string') : [];

        if (saved) {
            this._writtenArrival = month[key].arrival;
        } else {
            month[key] = this._entry(now);
            this._trySave('history', () => this._store.saveMonth(monthKey(now), month));
            this._writtenArrival = month[key].arrival;
        }
        if (!sameDay)
            this._trySave('state', () => this._saveState());
    }

    _intervals(cfg) {
        return breakIntervals(this._arrival, {fixedBreak: cfg.fixedBreak, breaks: this._breaks, openBreak: this._openBreak});
    }

    /** Today's entry with the current settings copied in; `close` finishes an open break. */
    _entry(departure, {close = false} = {}) {
        const cfg = this._config();
        const day = {
            date: this._day,
            arrival: this._arrival,
            departure,
            breaks: this._breaks,
            openBreak: this._openBreak,
            fixedBreak: cfg.fixedBreak,
            targetMin: targetOf(cfg),
        };
        return writeDay(close ? closeDay(day, departure) : day);
    }

    /**
     * Rewrite today's entry. With `adopt`, an arrival hand-edited in the file since
     * our last write wins over the one in memory.
     */
    _saveLastSeen(t, {adopt = true, close = false} = {}) {
        const month = monthKey(this._arrival);
        const data = this._store.loadMonth(month);
        const onDisk = data[this._day]?.arrival;
        if (adopt && onDisk !== undefined && onDisk !== this._writtenArrival) {
            const edited = parseClock(this._arrival, onDisk);
            if (edited)
                this._arrival = edited;
        }
        data[this._day] = this._entry(t, {close});
        this._store.saveMonth(month, data);
        this._writtenArrival = data[this._day].arrival;
    }

    _saveState() {
        this._store.saveState({date: this._day, fired: this._fired});
    }

    _trySave(what, save) {
        try {
            save();
        } catch (e) {
            console.error(`[time-tracker] cannot save ${what}: ${e}`);
        }
    }

    _message(alert, now, cfg) {
        const since = `since ${formatClock(this._arrival)}`;
        if (alert.id === 'break-start') {
            const back = formatClock(atMinutes(this._arrival, cfg.fixedBreak.end));
            return {title: 'Break time 🍽', body: `Back at ${back}`, urgent: false};
        }
        if (alert.id === 'break-end') {
            const worked = formatDuration(workedMinutes(this._arrival, now, this._intervals(cfg)));
            return {title: 'Back to work 💼', body: `${worked} done so far (${since})`, urgent: false};
        }
        const title = `⏱ ${formatDuration(alert.minutes)} done`;
        if (alert.final)
            return {title, body: `Day complete — you can go home 🏠 (${since})`, urgent: true};
        const left = formatDuration(remainingMinutes(this._arrival, now, cfg, this._intervals(cfg)));
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
````

- [ ] **Step 9: Run the tests and confirm they pass**

Run: `gjs -m tests/run.js 2>/dev/null | tail -1`
Expected: `88/88 passed`.

Note: `extension.js` and `lib/indicator.js` still use the v1 `view()` shape until Task 4. That's fine, because the extension is not reloaded before the real-session checks in Task 8.

- [ ] **Step 10: Commit**

```bash
git add "tests/timecalc.test.js" "tests/day.test.js" "tests/tracker.test.js" "tests/run.js" "time-tracker@anjrakot/lib/timecalc.js" "time-tracker@anjrakot/lib/day.js" "time-tracker@anjrakot/lib/tracker.js"
git commit -m "feat: manual and optional fixed breaks, overtime, day model and tracker actions

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Stats and a read-only store

**Files:**
- Create: `time-tracker@anjrakot/lib/stats.js`, `tests/stats.test.js`
- Modify (replace whole file): `time-tracker@anjrakot/lib/store.js`, `tests/store.test.js`
- Modify: `tests/run.js` (add one import)

**Interfaces:**
- **Consumes:** `computeDay`, `readDay` (from `day.js`); `dateKey` (from `timecalc.js`).
- **Produces from `stats.js`:**
  - `periodRange(kind: 'week'|'month', anchor) → {start, end}` (a week runs Monday to Sunday)
  - `shiftPeriod(kind, anchor, step) → Date`
  - `datesIn(range) → string[]`, `monthsIn(range) → string[]`
  - `summarize(days, range, now) → {days, workedMin, overtimeMin, avgWorkedMin, avgArrival, avgDeparture, avgBreakMin, records: {earliestArrival, latestDeparture, longestDay, shortestDay}, chart}`
    - Each record is `{date, value}` or null.
    - Averages are minutes of the day, or null.
    - `chart` entries are `{date, workedMin, targetMin, overtimeMin, today}` or `{date, empty: true}`.
- **Produces from `store.js`:** `new Store(dir, {readOnly})`. A read-only store never moves invalid files and throws on any save.

- [ ] **Step 1: Create `tests/stats.test.js`**

````js
import {eq, test} from './harness.js';
import {readDay} from '../time-tracker@anjrakot/lib/day.js';
import {datesIn, monthsIn, periodRange, shiftPeriod, summarize} from '../time-tracker@anjrakot/lib/stats.js';
import {dateKey} from '../time-tracker@anjrakot/lib/timecalc.js';

const key = range => [dateKey(range.start), dateKey(range.end)];
// Days of September 2026 (Wed 30 = "today"); all with the default fixed break and 8h target.
const DAYS = [
    readDay('2026-09-24', {arrival: '07:58:00', departure: '17:05:00'}), // 8h07 (+7)
    readDay('2026-09-25', {arrival: '08:15:00', departure: '16:15:00'}), // 7h00 (-60)
    readDay('2026-09-28', {arrival: '08:31:00', departure: '17:12:00'}), // 7h41 (-19)
    readDay('2026-09-29', {arrival: '08:02:00', departure: '17:40:00'}), // 8h38 (+38)
    readDay('2026-09-30', {arrival: '09:49:48', departure: '10:00:00'}), // today
];
const NOW = new Date(2026, 8, 30, 15, 0);

test('periodRange: Monday-Sunday weeks and calendar months', () => {
    eq(key(periodRange('week', new Date(2026, 8, 30))), ['2026-09-28', '2026-10-04']);
    eq(key(periodRange('week', new Date(2026, 8, 28))), ['2026-09-28', '2026-10-04'], 'Monday itself');
    eq(key(periodRange('week', new Date(2026, 9, 4))), ['2026-09-28', '2026-10-04'], 'Sunday');
    eq(key(periodRange('month', new Date(2026, 8, 30))), ['2026-09-01', '2026-09-30']);
    eq(key(periodRange('month', new Date(2026, 1, 10))), ['2026-02-01', '2026-02-28']);
});

test('shiftPeriod moves by one week or month', () => {
    eq(dateKey(shiftPeriod('week', new Date(2026, 8, 30), -1)), '2026-09-23');
    eq(dateKey(shiftPeriod('month', new Date(2026, 0, 31), -1)), '2025-12-01');
    eq(dateKey(shiftPeriod('month', new Date(2026, 11, 5), 1)), '2027-01-01');
});

test('datesIn and monthsIn: a week can span two months', () => {
    const range = periodRange('week', new Date(2026, 8, 30));
    eq(datesIn(range).length, 7);
    eq(monthsIn(range), ['2026-09', '2026-10']);
});

test('summarize: totals and averages use finished days only (today left out)', () => {
    const s = summarize(DAYS, periodRange('month', NOW), NOW);
    eq([s.days, s.workedMin, s.overtimeMin], [4, 487 + 420 + 461 + 518, 7 - 60 - 19 + 38]);
    eq(s.avgWorkedMin, Math.round((487 + 420 + 461 + 518) / 4));
    eq(s.avgArrival, Math.round((478 + 495 + 511 + 482) / 4));
    eq(s.avgDeparture, Math.round((1025 + 975 + 1032 + 1060) / 4));
    eq(s.avgBreakMin, 60);
});

test('summarize: records with their dates', () => {
    const {records} = summarize(DAYS, periodRange('month', NOW), NOW);
    eq(records.earliestArrival, {date: '2026-09-24', value: 478});
    eq(records.latestDeparture, {date: '2026-09-29', value: 1060});
    eq(records.longestDay, {date: '2026-09-29', value: 518});
    eq(records.shortestDay, {date: '2026-09-25', value: 420});
});

test('summarize: chart has one entry per date, today flagged and computed until now', () => {
    const {chart} = summarize(DAYS, periodRange('week', NOW), NOW);
    eq(chart.map(c => c.date), ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04']);
    eq(chart[0], {date: '2026-09-28', workedMin: 461, targetMin: 480, overtimeMin: -19, today: false});
    eq([chart[2].today, chart[2].workedMin], [true, 250]);
    eq(chart[3], {date: '2026-10-01', empty: true});
});

test('summarize: an empty period', () => {
    const s = summarize([], periodRange('month', new Date(2026, 5, 1)), NOW);
    eq([s.days, s.workedMin, s.overtimeMin, s.avgWorkedMin, s.avgArrival], [0, 0, 0, null, null]);
    eq(s.records, {earliestArrival: null, latestDeparture: null, longestDay: null, shortestDay: null});
    eq(s.chart.every(c => c.empty), true);
});
````

- [ ] **Step 2: Replace `tests/store.test.js`** (adds the read-only test at the end)

````js
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {eq, ok, test} from './harness.js';
import {parseBootTime, resolveHistoryDir, Store} from '../time-tracker@anjrakot/lib/store.js';

const tempStore = () => new Store(GLib.dir_make_tmp('time-tracker-XXXXXX'));
const path = (store, name) => GLib.build_filenamev([store.dir, name]);
const writeRaw = (store, name, text) => GLib.file_set_contents(path(store, name), text);
const exists = (store, name) => GLib.file_test(path(store, name), GLib.FileTest.EXISTS);
const backups = (store, name) => {
    const found = [];
    const children = Gio.File.new_for_path(store.dir).enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
    for (let info = children.next_file(null); info; info = children.next_file(null)) {
        if (info.get_name().startsWith(`${name}.`) && info.get_name().endsWith('.bak'))
            found.push(info.get_name());
    }
    return found;
};

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
    eq(backups(store, 'state.json').length, 1, 'backup kept');
    ok(!exists(store, 'state.json'), 'corrupt file moved away');
});

test('store: JSON that is not an object is treated as corrupt', () => {
    const store = tempStore();
    writeRaw(store, '2026-09.json', '[1, 2, 3]');
    eq(store.loadMonth('2026-09'), {});
    eq(backups(store, '2026-09.json').length, 1);
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

test('store: a second corruption keeps the first backup', () => {
    const store = tempStore();
    writeRaw(store, '2026-09.json', '{bad one');
    store.loadMonth('2026-09');
    writeRaw(store, '2026-09.json', '{bad two');
    store.loadMonth('2026-09');
    eq(backups(store, '2026-09.json').length, 2);
});

test('store: an unreadable file is left in place and the read throws', () => {
    if (GLib.get_user_name() === 'root')
        return; // root can read mode 000 files
    const store = tempStore();
    store.saveMonth('2026-09', {'2026-09-29': {arrival: '08:00:00'}});
    Gio.File.new_for_path(path(store, '2026-09.json'))
        .set_attribute_uint32('unix::mode', 0, Gio.FileQueryInfoFlags.NONE, null);
    let threw = false;
    try {
        store.loadMonth('2026-09');
    } catch {
        threw = true;
    }
    ok(threw, 'read error is reported');
    ok(exists(store, '2026-09.json'), 'file not moved');
    eq(backups(store, '2026-09.json').length, 0);
});

test('store: a read-only store never moves invalid files and refuses writes', () => {
    const dir = tempStore().dir;
    const store = new Store(dir, {readOnly: true});
    writeRaw(store, '2026-09.json', '{broken');
    eq(store.loadMonth('2026-09'), {});
    ok(exists(store, '2026-09.json'), 'left in place');
    eq(backups(store, '2026-09.json').length, 0);
    let threw = false;
    try {
        store.saveState({});
    } catch {
        threw = true;
    }
    ok(threw, 'write refused');
});
````

- [ ] **Step 3: Register the stats tests in `tests/run.js`**

Add this line after `import './day.test.js';`:

````js
import './stats.test.js';
````

- [ ] **Step 4: Run the tests and confirm they fail**

Run: `gjs -m tests/run.js`
Expected: FAIL with `Failed to resolve imports for module: '…/tests/run.js'` (`lib/stats.js` is missing).

- [ ] **Step 5: Create `time-tracker@anjrakot/lib/stats.js`**

````js
// Period statistics over Days (see day.js). Pure: no gi:// imports.
import {computeDay} from './day.js';
import {dateKey} from './timecalc.js';

const minuteOfDay = date => date.getHours() * 60 + date.getMinutes();
const average = values => (values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : null);

/** First and last date of the week (Monday-Sunday) or month containing `anchor`. */
export function periodRange(kind, anchor) {
    const y = anchor.getFullYear();
    const m = anchor.getMonth();
    if (kind === 'month')
        return {start: new Date(y, m, 1), end: new Date(y, m + 1, 0)};
    const offset = (anchor.getDay() + 6) % 7; // Monday = 0
    const start = new Date(y, m, anchor.getDate() - offset);
    return {start, end: new Date(y, m, anchor.getDate() - offset + 6)};
}

/** The period before (step -1) or after (step 1) the one containing `anchor`. */
export function shiftPeriod(kind, anchor, step) {
    if (kind === 'month')
        return new Date(anchor.getFullYear(), anchor.getMonth() + step, 1);
    return new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() + 7 * step);
}

/** Every date key of a range, in order. */
export function datesIn({start, end}) {
    const keys = [];
    for (let d = new Date(start); d <= end; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1))
        keys.push(dateKey(d));
    return keys;
}

/** Month keys ("YYYY-MM") a range touches. */
export function monthsIn(range) {
    return [...new Set(datesIn(range).map(key => key.slice(0, 7)))];
}

function record(list, better) {
    return list.reduce((best, item) => (best === null || better(item.value, best.value) ? item : best), null);
}

/**
 * Statistics of the Days inside `range`. Totals, averages and records use finished
 * days only (before today, with a departure); the chart has one entry per date,
 * today included (flagged, computed up to `now`).
 */
export function summarize(days, range, now) {
    const todayKey = dateKey(now);
    const keys = datesIn(range);
    const byDate = new Map(days.map(day => [day.date, day]));
    const finished = keys
        .filter(key => key < todayKey && byDate.get(key)?.departure)
        .map(key => ({day: byDate.get(key), ...computeDay(byDate.get(key))}));

    const workedMin = finished.reduce((sum, f) => sum + f.workedMin, 0);
    const overtimeMin = finished.reduce((sum, f) => sum + f.overtimeMin, 0);
    const worked = finished.map(f => ({date: f.day.date, value: f.workedMin}));
    const arrivals = finished.map(f => ({date: f.day.date, value: minuteOfDay(f.day.arrival)}));
    const departures = finished.map(f => ({date: f.day.date, value: minuteOfDay(f.day.departure)}));

    const chart = keys.map(key => {
        const day = byDate.get(key);
        if (!day || key > todayKey)
            return {date: key, empty: true};
        const until = key === todayKey ? now : day.departure ?? day.arrival;
        const {workedMin: w, overtimeMin: o} = computeDay(day, until);
        return {date: key, workedMin: w, targetMin: day.targetMin, overtimeMin: o, today: key === todayKey};
    });

    return {
        days: finished.length,
        workedMin,
        overtimeMin,
        avgWorkedMin: average(worked.map(w => w.value)),
        avgArrival: average(arrivals.map(a => a.value)),
        avgDeparture: average(departures.map(d => d.value)),
        avgBreakMin: average(finished.map(f => f.breakMin)),
        records: {
            earliestArrival: record(arrivals, (a, b) => a < b),
            latestDeparture: record(departures, (a, b) => a > b),
            longestDay: record(worked, (a, b) => a > b),
            shortestDay: record(worked, (a, b) => a < b),
        },
        chart,
    };
}
````

- [ ] **Step 6: Run the tests and confirm only the read-only test fails**

Run: `gjs -m tests/run.js 2>/dev/null | grep -E "FAIL|passed"`
Expected: `FAIL store: a read-only store never moves invalid files and refuses writes`, then `95/96 passed`.

- [ ] **Step 7: Replace `time-tracker@anjrakot/lib/store.js`**

````js
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
    /** `readOnly` (the app): never writes, and leaves invalid files where they are. */
    constructor(dir, {readOnly = false} = {}) {
        this.dir = dir;
        this.readOnly = readOnly;
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

    /**
     * Missing file -> {}. Invalid or non-object JSON -> moved to a new
     * <name>.<timestamp>.bak (never overwriting an older backup), then {}.
     * Any other read error is thrown and the file is left untouched.
     */
    _read(name) {
        const path = GLib.build_filenamev([this.dir, name]);
        const file = Gio.File.new_for_path(path);
        let bytes;
        try {
            [, bytes] = file.load_contents(null);
        } catch (e) {
            if (e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                return {};
            throw e;
        }
        try {
            const data = JSON.parse(new TextDecoder().decode(bytes));
            if (typeof data !== 'object' || data === null || Array.isArray(data))
                throw new Error('not a JSON object');
            return data;
        } catch (e) {
            if (this.readOnly) {
                console.error(`[time-tracker] invalid ${path}: ${e}`);
                return {};
            }
            const backup = this._backupPath(path);
            console.error(`[time-tracker] invalid ${path}, moving it to ${backup}: ${e}`);
            // Throws if the backup cannot be made, so the invalid file is never overwritten.
            file.move(Gio.File.new_for_path(backup), Gio.FileCopyFlags.NONE, null, null);
            return {};
        }
    }

    _backupPath(path) {
        const stamp = GLib.DateTime.new_now_local().format('%Y%m%d-%H%M%S');
        let backup = `${path}.${stamp}.bak`;
        for (let n = 1; GLib.file_test(backup, GLib.FileTest.EXISTS); n++)
            backup = `${path}.${stamp}-${n}.bak`;
        return backup;
    }

    /** Atomic: replace_contents writes a temporary file and renames it over the target. */
    _write(name, data) {
        if (this.readOnly)
            throw new Error('read-only store');
        GLib.mkdir_with_parents(this.dir, 0o755);
        const file = Gio.File.new_for_path(GLib.build_filenamev([this.dir, name]));
        const bytes = new TextEncoder().encode(`${JSON.stringify(data, null, 2)}\n`);
        file.replace_contents(bytes, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
    }
}
````

- [ ] **Step 8: Run the tests and confirm they pass**

Run: `gjs -m tests/run.js 2>/dev/null | tail -1`
Expected: `96/96 passed`.

- [ ] **Step 9: Commit**

```bash
git add "tests/stats.test.js" "tests/store.test.js" "tests/run.js" "time-tracker@anjrakot/lib/stats.js" "time-tracker@anjrakot/lib/store.js"
git commit -m "feat: week/month stats and a read-only store for the app

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The D-Bus service

**Files:**
- Create: `time-tracker@anjrakot/lib/dbus-api.js`, `time-tracker@anjrakot/lib/dbus.js`, `tests/dbus.test.js`
- Modify: `tests/run.js` (add one import)

**Interfaces:**
- **Consumes:** `Tracker`, `UserError` (Task 1).
- **Produces from `dbus-api.js`:** `BUS_NAME`, `OBJECT_PATH`, `INTERFACE_XML`, `INVALID_ARGS`, `FAILED`.
- **Produces from `dbus.js`:**
  - `new TrackerService({tracker: () => Tracker, onChanged: () => void})` with `export(connection = Gio.DBus.session)`, `unexport()`, `emitChanged(date)`
  - the handlers `GetTodayAsync`, `StartBreakAsync`, `FinishBreakAsync`, `SetArrivalAsync`, `ResetArrivalAsync`, `SaveDayAsync`, `DeleteDayAsync`, each taking `(params, invocation)`
  - `GetToday` returns `(s)` with the JSON of `view()`. Actions return nothing.
  - `onChanged` runs after every successful action, never after `GetToday`.

- [ ] **Step 1: Create `tests/dbus.test.js`**

````js
import {eq, ok, test} from './harness.js';
import {FAILED, INVALID_ARGS} from '../time-tracker@anjrakot/lib/dbus-api.js';
import {TrackerService} from '../time-tracker@anjrakot/lib/dbus.js';
import {configFrom} from '../time-tracker@anjrakot/lib/timecalc.js';
import {Tracker} from '../time-tracker@anjrakot/lib/tracker.js';

const at = (h, m, s = 0) => new Date(2026, 8, 30, h, m, s);
const CFG = configFrom({thresholds: ['4:00', '8:00'], fixedBreak: true, breakStart: '12:30', breakEnd: '13:30', breakAlerts: true});

// Records what a handler answered, like a Gio.DBusMethodInvocation.
class FakeInvocation {
    return_value(variant) {
        this.value = variant === null ? null : variant.deepUnpack();
    }

    return_dbus_error(name, message) {
        this.error = {name, message};
    }
}

class MemoryStore {
    constructor() {
        this.files = {};
    }

    loadMonth(m) {
        return JSON.parse(this.files[m] ?? '{}');
    }

    saveMonth(m, d) {
        this.files[m] = JSON.stringify(d);
    }

    loadState() {
        return JSON.parse(this.files.state ?? '{}');
    }

    saveState(s) {
        this.files.state = JSON.stringify(s);
    }
}

function setup() {
    const clock = {now: at(10, 0)};
    const store = new MemoryStore();
    const tracker = new Tracker({store, config: () => CFG, now: () => clock.now, bootTime: () => at(8, 0)});
    let changes = 0;
    const service = new TrackerService({tracker: () => tracker, onChanged: () => changes++});
    const call = (method, ...args) => {
        const invocation = new FakeInvocation();
        service[`${method}Async`](args, invocation);
        return invocation;
    };
    return {clock, store, tracker, call, changes: () => changes};
}

test('dbus: GetToday returns today as JSON and is not a change', () => {
    const {call, changes} = setup();
    const inv = call('GetToday');
    const today = JSON.parse(inv.value[0]);
    eq([today.date, today.arrival, today.workedMin, today.onBreak], ['2026-09-30', '08:00:00', 120, false]);
    eq(changes(), 0);
});

test('dbus: actions answer with no value and signal a change', () => {
    const {call, changes, clock} = setup();
    eq(call('StartBreak').value, null);
    clock.now = at(10, 20);
    eq(call('FinishBreak').value, null);
    eq(call('SetArrival', '7:45').value, null);
    eq(call('ResetArrival').value, null);
    eq(changes(), 4);
});

test('dbus: refused actions return InvalidArgs with the readable message', () => {
    const {call, changes} = setup();
    eq(call('FinishBreak').error, {name: INVALID_ARGS, message: 'No break in progress'});
    eq(call('SaveDay', '2026-09-29', 'not json').error, {name: INVALID_ARGS, message: 'Invalid day data'});
    eq(call('SaveDay', '2026-09-29', JSON.stringify({arrival: '9:00', departure: '8:00', breaks: []})).error.message,
        'Departure must be after arrival');
    eq(call('DeleteDay', '2026-09-30').error.name, INVALID_ARGS);
    eq(changes(), 0);
});

test('dbus: SaveDay and DeleteDay change past days', () => {
    const {call, store} = setup();
    const day = {arrival: '8:00', departure: '16:30', breaks: [], fixedBreak: ['12:30', '13:30']};
    eq(call('SaveDay', '2026-09-29', JSON.stringify(day)).value, null);
    eq(store.loadMonth('2026-09')['2026-09-29'].workedMin, 450);
    eq(call('DeleteDay', '2026-09-29').value, null);
    ok(!('2026-09-29' in store.loadMonth('2026-09')));
});

test('dbus: unexpected errors return Failed', () => {
    const {call, store} = setup();
    store.saveMonth = () => {
        throw new Error('disk full');
    };
    eq(call('SaveDay', '2026-09-29', JSON.stringify({arrival: '8:00', departure: '9:00', breaks: []})).error,
        {name: FAILED, message: 'disk full'});
});
````

- [ ] **Step 2: Register it in `tests/run.js`**

Add this line after `import './stats.test.js';`:

````js
import './dbus.test.js';
````

- [ ] **Step 3: Run the tests and confirm they fail**

Run: `gjs -m tests/run.js`
Expected: FAIL with `Failed to resolve imports for module: '…/tests/run.js'` (`lib/dbus-api.js` and `lib/dbus.js` are missing).

- [ ] **Step 4: Create `time-tracker@anjrakot/lib/dbus-api.js`**

````js
// The D-Bus contract between the extension (service) and the app (client).
// The service name differs from the app id (io.github.fafafa12.TimeTracker),
// which GApplication already owns on the session bus.

export const BUS_NAME = 'io.github.fafafa12.TimeTrackerService';
export const OBJECT_PATH = '/io/github/fafafa12/TimeTrackerService';

export const INTERFACE_XML = `
<node>
  <interface name="io.github.fafafa12.TimeTrackerService">
    <method name="GetToday"><arg type="s" direction="out" name="json"/></method>
    <method name="StartBreak"/>
    <method name="FinishBreak"/>
    <method name="SetArrival"><arg type="s" direction="in" name="time"/></method>
    <method name="ResetArrival"/>
    <method name="SaveDay"><arg type="s" direction="in" name="date"/><arg type="s" direction="in" name="day"/></method>
    <method name="DeleteDay"><arg type="s" direction="in" name="date"/></method>
    <signal name="Changed"><arg type="s" name="date"/></signal>
  </interface>
</node>`;

export const INVALID_ARGS = 'org.freedesktop.DBus.Error.InvalidArgs';
export const FAILED = 'org.freedesktop.DBus.Error.Failed';
````

- [ ] **Step 5: Create `time-tracker@anjrakot/lib/dbus.js`**

````js
// The extension's D-Bus service: thin wrappers around Tracker actions.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {BUS_NAME, FAILED, INTERFACE_XML, INVALID_ARGS, OBJECT_PATH} from './dbus-api.js';
import {UserError} from './tracker.js';

export class TrackerService {
    /**
     * @param {object} deps
     * @param {() => import('./tracker.js').Tracker} deps.tracker  the current tracker
     * @param {() => void} deps.onChanged  called after every successful change
     */
    constructor({tracker, onChanged}) {
        this._tracker = tracker;
        this._onChanged = onChanged;
        this._impl = null;
        this._nameId = 0;
    }

    export(connection = Gio.DBus.session) {
        this._impl = Gio.DBusExportedObject.wrapJSObject(INTERFACE_XML, this);
        this._impl.export(connection, OBJECT_PATH);
        this._nameId = Gio.bus_own_name_on_connection(connection, BUS_NAME, Gio.BusNameOwnerFlags.NONE, null, null);
    }

    unexport() {
        if (this._nameId) {
            Gio.bus_unown_name(this._nameId);
            this._nameId = 0;
        }
        this._impl?.unexport();
        this._impl = null;
    }

    emitChanged(date) {
        this._impl?.emit_signal('Changed', new GLib.Variant('(s)', [date]));
    }

    GetTodayAsync(_params, invocation) {
        this._reply(invocation, () => JSON.stringify(this._tracker().view()), false);
    }

    StartBreakAsync(_params, invocation) {
        this._reply(invocation, () => this._tracker().startBreak());
    }

    FinishBreakAsync(_params, invocation) {
        this._reply(invocation, () => this._tracker().finishBreak());
    }

    SetArrivalAsync([time], invocation) {
        this._reply(invocation, () => this._tracker().setArrival(time));
    }

    ResetArrivalAsync(_params, invocation) {
        this._reply(invocation, () => this._tracker().resetArrival());
    }

    SaveDayAsync([date, day], invocation) {
        this._reply(invocation, () => {
            let input;
            try {
                input = JSON.parse(day);
            } catch {
                throw new UserError('Invalid day data');
            }
            this._tracker().saveDay(date, input);
        });
    }

    DeleteDayAsync([date], invocation) {
        this._reply(invocation, () => this._tracker().deleteDay(date));
    }

    /** Run an action; answer with its string result (or nothing) or a D-Bus error. */
    _reply(invocation, action, changes = true) {
        let result;
        try {
            result = action();
        } catch (e) {
            if (e instanceof UserError) {
                invocation.return_dbus_error(INVALID_ARGS, e.message);
            } else {
                console.error(`[time-tracker] D-Bus call failed: ${e}\n${e?.stack ?? ''}`);
                invocation.return_dbus_error(FAILED, String(e?.message ?? e));
            }
            return;
        }
        invocation.return_value(typeof result === 'string' ? new GLib.Variant('(s)', [result]) : null);
        if (changes)
            this._onChanged();
    }
}
````

- [ ] **Step 6: Run the tests and confirm they pass**

Run: `gjs -m tests/run.js 2>/dev/null | tail -1`
Expected: `101/101 passed`.

- [ ] **Step 7: Commit**

```bash
git add "tests/dbus.test.js" "tests/run.js" "time-tracker@anjrakot/lib/dbus-api.js" "time-tracker@anjrakot/lib/dbus.js"
git commit -m "feat: TrackerService D-Bus interface for the app

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Extension wiring (fixed-break setting, top-bar menu, D-Bus export)

These files only run inside GNOME Shell. Verification here is static; the user checks them in the real session in Task 8.

**Files:**
- Modify (replace whole file): `time-tracker@anjrakot/schemas/org.gnome.shell.extensions.time-tracker.gschema.xml`, `time-tracker@anjrakot/prefs.js`, `time-tracker@anjrakot/lib/indicator.js`, `time-tracker@anjrakot/extension.js`

**Interfaces:**
- **Consumes:** `configFrom` (with `fixedBreak`), `formatDuration`, `formatSigned`, `Tracker.view()`, `startBreak`, `finishBreak`, `resetArrival`, `TrackerService`.
- **Produces:**
  - the GSettings key `fixed-break`
  - top-bar items: ☕ Start break / ▶ Finish break, and Open Time Tracker (launches `io.github.fafafa12.TimeTracker.desktop`)
  - D-Bus exported on enable and unexported on disable; `Changed(date)` on every tick and after every action

- [ ] **Step 1: Replace the settings schema**

````xml
<?xml version="1.0" encoding="UTF-8"?>
<schemalist>
  <schema id="org.gnome.shell.extensions.time-tracker" path="/org/gnome/shell/extensions/time-tracker/">
    <key name="alert-thresholds" type="as">
      <default>['4:00', '7:00', '7:45', '8:00']</default>
      <summary>Work alerts</summary>
      <description>Time worked (H:MM) at which to notify. The largest is the end of the day.</description>
    </key>
    <key name="fixed-break" type="b">
      <default>true</default>
      <summary>Fixed daily break</summary>
      <description>When on, break-start to break-end is never counted as work.</description>
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
````

- [ ] **Step 2: Replace `time-tracker@anjrakot/prefs.js`**

````js
// Settings window (runs in its own process, not in GNOME Shell).
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {formatHM, parseHM, thresholdsToSave} from './lib/timecalc.js';

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

        // Nothing is written while any filled row is invalid (it stays red).
        const save = () => {
            const values = thresholdsToSave(rows.map(r => r.text));
            if (values)
                settings.set_strv('alert-thresholds', values);
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
        const group = new Adw.PreferencesGroup({
            title: 'Fixed break',
            description: 'A daily break never counted as work. Manual breaks can be started any time from the top bar or the app. Press ✓ to save.',
        });
        const fixed = new Adw.SwitchRow({title: 'Fixed daily break'});
        settings.bind('fixed-break', fixed, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(fixed);
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
        const alerts = new Adw.SwitchRow({title: 'Break alerts', subtitle: 'Notify at break start and end'});
        settings.bind('break-alerts', alerts, 'active', Gio.SettingsBindFlags.DEFAULT);
        for (const row of [start, end]) {
            row.connect('changed', validate);
            row.connect('apply', apply);
        }
        for (const row of [start, end, alerts]) {
            settings.bind('fixed-break', row, 'sensitive', Gio.SettingsBindFlags.GET);
            group.add(row);
        }
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
````

- [ ] **Step 3: Replace `time-tracker@anjrakot/lib/indicator.js`**

````js
// Top-bar button: "⏱ 5h12" (or "☕ 5h12" on a break) plus a menu with today's details and actions.
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {formatDuration, formatSigned} from './timecalc.js';

export const TrackerIndicator = GObject.registerClass(
class TrackerIndicator extends PanelMenu.Button {
    /**
     * @param {object} actions
     * @param {() => void} actions.onToggleBreak
     * @param {() => void} actions.onOpenApp
     * @param {() => void} actions.onReset
     * @param {() => void} actions.onOpenFolder
     * @param {() => void} actions.onSettings
     */
    _init({onToggleBreak, onOpenApp, onReset, onOpenFolder, onSettings}) {
        super._init(0.5, 'Time Tracker');

        this._label = new St.Label({text: '⏱ …', y_align: Clutter.ActorAlign.CENTER});
        this.add_child(this._label);

        this._arrival = this._addInfo();
        this._worked = this._addInfo();
        this._balance = this._addInfo();
        this._next = this._addInfo();
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._breakItem = this.menu.addAction('☕ Start break', onToggleBreak);
        this.menu.addAction('Open Time Tracker', onOpenApp);
        this.menu.addAction('Reset arrival to now', onReset);
        this.menu.addAction('Open history folder', onOpenFolder);
        this.menu.addAction('Settings', onSettings);
    }

    _addInfo() {
        const item = new PopupMenu.PopupMenuItem('', {reactive: false});
        this.menu.addMenuItem(item);
        return item.label;
    }

    /** @param {object} view  Tracker.view() */
    update(view) {
        this._label.text = `${view.onBreak ? '☕' : '⏱'} ${formatDuration(view.workedMin)}`;
        this._arrival.text = `Arrival: ${view.arrival.slice(0, 5)}`;
        this._worked.text = `Worked: ${formatDuration(view.workedMin)}`;
        this._balance.text = view.targetMin > 0 && view.workedMin >= view.targetMin
            ? `Overtime: ${formatSigned(view.overtimeMin)}`
            : `Remaining: ${formatDuration(view.remainingMin)}`;
        this._next.text = `Next alert: ${nextText(view)}`;
        this._breakItem.label.text = view.onBreak
            ? `▶ Finish break (since ${view.openBreak.slice(0, 5)})`
            : '☕ Start break';
    }
});

function nextText({next, targetMin, workedMin}) {
    if (next?.paused)
        return `${next.label} · paused (on a break)`;
    if (next)
        return `${next.label} at ${next.time}`;
    return targetMin > 0 && workedMin >= targetMin ? 'none, day complete' : 'none';
}
````

- [ ] **Step 4: Replace `time-tracker@anjrakot/extension.js`**

````js
// Entry point: wires settings, the tracker, the top-bar indicator, notifications and D-Bus.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {TrackerService} from './lib/dbus.js';
import {TrackerIndicator} from './lib/indicator.js';
import {readBootTime, resolveHistoryDir, Store} from './lib/store.js';
import {configFrom} from './lib/timecalc.js';
import {Tracker} from './lib/tracker.js';

const TICK_SECONDS = 60;
const ICON = 'preferences-system-time-symbolic';
const APP_DESKTOP_ID = 'io.github.fafafa12.TimeTracker.desktop';

export default class TimeTrackerExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._config = this._readConfig();
        this._historyDir = resolveHistoryDir(this._settings.get_string('history-dir'));
        this._tracker = new Tracker({
            store: new Store(this._historyDir),
            config: () => this._config,
            now: () => new Date(),
            bootTime: readBootTime,
        });

        this._indicator = new TrackerIndicator({
            onToggleBreak: () => this._action(() => {
                if (this._tracker.view().onBreak)
                    this._tracker.finishBreak();
                else
                    this._tracker.startBreak();
            }),
            onOpenApp: () => this._safe(() => this._openApp()),
            onReset: () => this._action(() => this._tracker.resetArrival()),
            onOpenFolder: () => this._safe(() => this._openFolder()),
            onSettings: () => this._safe(() => this.openPreferences()),
        });
        Main.panel.addToStatusArea(this.uuid, this._indicator);

        this._service = new TrackerService({tracker: () => this._tracker, onChanged: () => this._refresh()});
        this._safe(() => this._service.export());

        this._settingsId = this._settings.connect('changed', (_s, key) => this._safe(() => this._onSettingChanged(key)));
        // Logout and power-off end the Shell without calling disable().
        this._shutdownId = global.connect('shutdown', () => this._safe(() => this._tracker.stop()));

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
        if (this._shutdownId) {
            global.disconnect(this._shutdownId);
            this._shutdownId = 0;
        }
        this._safe(() => this._service?.unexport());
        this._safe(() => this._tracker?.stop());
        this._indicator?.destroy();
        this._source?.destroy();
        this._service = null;
        this._indicator = null;
        this._source = null;
        this._tracker = null;
        this._settings = null;
    }

    _readConfig() {
        return configFrom({
            thresholds: this._settings.get_strv('alert-thresholds'),
            fixedBreak: this._settings.get_boolean('fixed-break'),
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
            this._historyDir = resolveHistoryDir(this._settings.get_string('history-dir'));
            this._tracker.moveTo(new Store(this._historyDir));
        }
        this._config = this._readConfig();
        this._refresh();
    }

    /** A menu action; refused actions (e.g. no break in progress) are shown as a notification. */
    _action(fn) {
        try {
            fn();
        } catch (e) {
            this._notify({title: '⏱ Time Tracker', body: String(e?.message ?? e), urgent: false});
        }
        this._refresh();
    }

    /** One tick: send due notifications, update the label, tell the app. Never throws. */
    _refresh() {
        this._safe(() => {
            for (const message of this._tracker.tick())
                this._notify(message);
        });
        this._safe(() => {
            const view = this._tracker.view();
            this._indicator.update(view);
            this._service?.emitChanged(view.date);
        });
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

    _openApp() {
        const app = Gio.DesktopAppInfo.new(APP_DESKTOP_ID);
        if (!app) {
            this._notify({title: '⏱ Time Tracker', body: 'The Time Tracker app is not installed: run install.sh', urgent: false});
            return;
        }
        app.launch([], global.create_app_launch_context(0, -1));
    }

    _openFolder() {
        GLib.mkdir_with_parents(this._historyDir, 0o755);
        Gio.AppInfo.launch_default_for_uri(GLib.filename_to_uri(this._historyDir, null), global.create_app_launch_context(0, -1));
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
````

- [ ] **Step 5: Static checks and the test suite**

Run:
```bash
glib-compile-schemas --strict --dry-run "time-tracker@anjrakot/schemas" && echo schema-ok
for f in "time-tracker@anjrakot/extension.js" "time-tracker@anjrakot/prefs.js" "time-tracker@anjrakot/lib/indicator.js" "time-tracker@anjrakot/lib/dbus.js"; do cp "$f" /tmp/tt-check.mjs && node --check /tmp/tt-check.mjs && echo "$f ok"; done
gjs -m tests/run.js 2>/dev/null | tail -1
```
Expected: `schema-ok`, four `… ok` lines, and `101/101 passed`.

- [ ] **Step 6: Commit**

```bash
git add "time-tracker@anjrakot/schemas/org.gnome.shell.extensions.time-tracker.gschema.xml" "time-tracker@anjrakot/prefs.js" "time-tracker@anjrakot/lib/indicator.js" "time-tracker@anjrakot/extension.js"
git commit -m "feat: extension exports TrackerService, break toggle and overtime in the top bar

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The app: shell, Today page, widgets and the dev preview

**Files:**
- Create:
  - `dev/fake-service.js`, `dev/preview.sh`
  - `app/data.js`, `app/client.js`, `app/style.css`, `app/window.js`, `app/main.js`, `app/time-tracker`
  - `app/pages/today.js`
  - `app/widgets/anim.js`, `app/widgets/ring.js`, `app/widgets/timeline.js`, `app/widgets/confetti.js`
  - `app/icons/hicolor/scalable/actions/tt-stats-symbolic.svg`, `app/icons/hicolor/scalable/apps/io.github.fafafa12.TimeTracker.svg`

**Interfaces:**
- **Consumes:** `readDay`, `monthsIn`, `Store({readOnly})`, `resolveHistoryDir`, `BUS_NAME`, `OBJECT_PATH`, `INTERFACE_XML`, `TrackerService`, `Tracker`, `configFrom`, and the timecalc formatters.
- **Produces:**
  - `History(settings)` with `dir`, `month("YYYY-MM") → Day[]` (oldest first), `range(range) → Day[]`
  - `openExtensionSettings() → Gio.Settings|null`, `APP_DIR`, `EXTENSION_UUID`
  - `TrackerClient` with `online`, `onChange(fn)`, `today() → Promise<view>`, `call(method, ...args) → Promise` (rejects with the extension's message)
  - `animate(widget, from, to, ms, apply, easing?)`
  - widgets: `Ring.setFraction(f)`, `Timeline.setData({arrival, now, breaks})` (all in minutes of the day), `Confetti.burst()`
  - `TodayPage(ctx).update(view|null)`
  - `TrackerWindow({application, client, history})` with `refresh()`, `showPage(name)`
  - the shared window context `ctx = {client, history, window, toast(text), run(method, ...args) → Promise<boolean>, openToday(), celebrate()}`
  - dev only: `TT_SCREENSHOT=<png> [TT_PAGE=today|history|stats]` renders the window and quits

- [ ] **Step 1: Create `dev/fake-service.js`**

````js
// Dev only: run the extension's Tracker + D-Bus service outside GNOME Shell, so the app
// can be tried without re-logging in. Use it inside `dbus-run-session` (see preview.sh),
// never on your real session bus while the extension is enabled.
//   gjs -m dev/fake-service.js [--sample] [--break]
import GLib from 'gi://GLib';
import System from 'system';

import {TrackerService} from '../time-tracker@anjrakot/lib/dbus.js';
import {readBootTime, resolveHistoryDir, Store} from '../time-tracker@anjrakot/lib/store.js';
import {configFrom, dateKey, monthKey} from '../time-tracker@anjrakot/lib/timecalc.js';
import {Tracker} from '../time-tracker@anjrakot/lib/tracker.js';

const args = ARGV;
const store = new Store(resolveHistoryDir(''));
const cfg = configFrom({thresholds: ['4:00', '7:00', '7:45', '8:00'], fixedBreak: true, breakStart: '12:30', breakEnd: '13:30', breakAlerts: true});
const now = new Date();

if (args.includes('--sample')) {
    // Weekdays of this month and the previous one, before today.
    for (const offset of [-1, 0]) {
        const first = new Date(now.getFullYear(), now.getMonth() + offset, 1);
        const month = {};
        for (let d = new Date(first); d.getMonth() === first.getMonth() && dateKey(d) < dateKey(now); d.setDate(d.getDate() + 1)) {
            if (d.getDay() === 0 || d.getDay() === 6)
                continue;
            const n = d.getDate();
            const arrive = 7 * 60 + 40 + ((n * 37) % 60);
            const leave = arrive + 8 * 60 + 60 + (((n * 53) % 90) - 45);
            const hm = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00`;
            month[dateKey(d)] = {
                arrival: hm(arrive), departure: hm(leave),
                breaks: n % 3 === 0 ? [[hm(15 * 60), hm(15 * 60 + 15)]] : [],
                openBreak: null, fixedBreak: ['12:30', '13:30'], targetMin: 480,
            };
        }
        store.saveMonth(monthKey(first), month);
    }
}

const tracker = new Tracker({store, config: () => cfg, now: () => new Date(), bootTime: readBootTime});
let service = null;
const refresh = () => {
    tracker.tick();
    service?.emitChanged(tracker.view().date);
};
service = new TrackerService({tracker: () => tracker, onChanged: refresh});
service.export();
tracker.tick();
if (args.includes('--break'))
    tracker.startBreak();
GLib.timeout_add_seconds(GLib.PRIORITY_LOW, 60, () => {
    refresh();
    return GLib.SOURCE_CONTINUE;
});
printerr(`[fake-service] running; history in ${store.dir}`);
new GLib.MainLoop(null, false).run();
System.exit(0);
````

- [ ] **Step 2: Create `dev/preview.sh` and make it executable (`chmod +x dev/preview.sh`)**

````bash
#!/usr/bin/env bash
# Dev only: render the app's pages to PNGs without touching your desktop.
# Broadway (no window on screen) + a private D-Bus + in-memory GSettings + temp data dir.
#   dev/preview.sh [out-dir] [--break] [--offline]
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${1:-${TMPDIR:-/tmp}/tt-preview}"
shift || true
FLAGS=("$@")
mkdir -p "$OUT"
TMP="$(mktemp -d)"
glib-compile-schemas "$ROOT/time-tracker@anjrakot/schemas"

export XDG_DATA_HOME="$TMP/data" GSETTINGS_BACKEND=memory GIO_USE_VFS=local NO_AT_BRIDGE=1 GTK_A11Y=none GTK_USE_PORTAL=0 ADW_DISABLE_PORTAL=1
export GDK_BACKEND=broadway BROADWAY_DISPLAY=:9 ROOT OUT
gtk4-broadwayd --address 127.0.0.1 :9 >/dev/null 2>&1 &
BROADWAY=$!
trap 'kill $BROADWAY 2>/dev/null || true; rm -rf "$TMP"' EXIT

OFFLINE=0
SERVICE_FLAGS=(--sample)
for f in "${FLAGS[@]}"; do
    case "$f" in
        --break) SERVICE_FLAGS+=(--break) ;;
        --offline) OFFLINE=1 ;;
    esac
done
export OFFLINE SERVICE_FLAGS_STR="${SERVICE_FLAGS[*]}"

dbus-run-session -- bash -c '
    gjs -m "$ROOT/dev/fake-service.js" $SERVICE_FLAGS_STR &
    SERVICE=$!
    for _ in $(seq 1 50); do
        gdbus introspect --session --dest io.github.fafafa12.TimeTrackerService \
            --object-path /io/github/fafafa12/TimeTrackerService >/dev/null 2>&1 && break
        sleep 0.1
    done
    [ "$OFFLINE" = 1 ] && kill $SERVICE
    for page in ${PAGES:-today history stats}; do
        TT_SCREENSHOT="$OUT/$page.png" TT_PAGE=$page timeout 20 gjs -m "$ROOT/app/main.js"
    done
    for dialog in ${DIALOGS-add}; do
        TT_SCREENSHOT="$OUT/dialog-$dialog.png" TT_PAGE=history TT_DIALOG=$dialog timeout 20 gjs -m "$ROOT/app/main.js"
    done
    kill $SERVICE 2>/dev/null || true
'
echo "Screenshots in $OUT"
````

- [ ] **Step 3: Create `app/data.js`**

````js
// App-side data access: the extension's settings (read-only) and the history files.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {readDay} from '../time-tracker@anjrakot/lib/day.js';
import {monthsIn} from '../time-tracker@anjrakot/lib/stats.js';
import {resolveHistoryDir, Store} from '../time-tracker@anjrakot/lib/store.js';

export const APP_DIR = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
export const EXTENSION_UUID = 'time-tracker@anjrakot';
const SCHEMA_ID = 'org.gnome.shell.extensions.time-tracker';

/** The extension's GSettings (from its own compiled schema), or null if unavailable. */
export function openExtensionSettings() {
    const dir = GLib.build_filenamev([APP_DIR, '..', EXTENSION_UUID, 'schemas']);
    try {
        const source = Gio.SettingsSchemaSource.new_from_directory(dir, Gio.SettingsSchemaSource.get_default(), false);
        const schema = source.lookup(SCHEMA_ID, false);
        return schema ? new Gio.Settings({settings_schema: schema}) : null;
    } catch (e) {
        console.error(`[time-tracker] cannot read settings: ${e}`);
        return null;
    }
}

/** Read-only access to the month files; the extension is the only writer. */
export class History {
    constructor(settings) {
        this._settings = settings;
    }

    get dir() {
        return resolveHistoryDir(this._settings?.get_string('history-dir') ?? '');
    }

    /** Days of one month ("YYYY-MM"), oldest first. */
    month(key) {
        let data = {};
        try {
            data = new Store(this.dir, {readOnly: true}).loadMonth(key);
        } catch (e) {
            console.error(`[time-tracker] cannot read ${key}: ${e}`);
        }
        return Object.keys(data).sort().map(date => readDay(date, data[date])).filter(Boolean);
    }

    /** Days of every month a range touches. */
    range(range) {
        return monthsIn(range).flatMap(key => this.month(key));
    }
}
````

- [ ] **Step 4: Create `app/client.js`**

````js
// D-Bus client for the extension's TrackerService.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {BUS_NAME, INTERFACE_XML, OBJECT_PATH} from '../time-tracker@anjrakot/lib/dbus-api.js';

const TrackerProxy = Gio.DBusProxy.makeProxyWrapper(INTERFACE_XML);

export class TrackerClient {
    constructor() {
        this._listeners = new Set();
        this._proxy = new TrackerProxy(Gio.DBus.session, BUS_NAME, OBJECT_PATH, null, null,
            Gio.DBusProxyFlags.DO_NOT_AUTO_START | Gio.DBusProxyFlags.DO_NOT_LOAD_PROPERTIES);
        this._proxy.connect('notify::g-name-owner', () => this._emit());
        this._proxy.connectSignal('Changed', () => this._emit());
    }

    /** True while the extension is running and owns the service name. */
    get online() {
        return this._proxy.g_name_owner !== null;
    }

    /** `fn()` runs when the extension appears, disappears or reports a change. */
    onChange(fn) {
        this._listeners.add(fn);
    }

    _emit() {
        for (const fn of this._listeners)
            fn();
    }

    /** Tracker.view() of the running extension. */
    async today() {
        const [json] = await this._proxy.GetTodayAsync();
        return JSON.parse(json);
    }

    /** Call an action; a refusal rejects with an Error carrying the extension's message. */
    async call(method, ...args) {
        try {
            await this._proxy[`${method}Async`](...args);
        } catch (e) {
            if (e instanceof GLib.Error)
                Gio.DBusError.strip_remote_error(e);
            throw new Error(e.message);
        }
    }
}
````

- [ ] **Step 5: Create `app/widgets/anim.js`**

````js
// Small helper: animate a number on a widget with Adw.TimedAnimation.
// libadwaita skips animations when GNOME's animations are turned off.
import Adw from 'gi://Adw?version=1';

/**
 * Animate from `from` to `to` over `ms`, calling `apply(value)` on each frame.
 * Returns the animation (already playing); call `.skip()` to jump to the end.
 */
export function animate(widget, from, to, ms, apply, easing = Adw.Easing.EASE_OUT_CUBIC) {
    const animation = new Adw.TimedAnimation({
        widget,
        value_from: from,
        value_to: to,
        duration: ms,
        easing,
        target: Adw.CallbackAnimationTarget.new(apply),
    });
    animation.play();
    return animation;
}
````

- [ ] **Step 6: Create `app/widgets/ring.js`**

````js
// Progress ring (worked / target), drawn in white on the colored hero card.
import Cairo from 'cairo';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';

import {animate} from './anim.js';

const WIDTH = 11;

export const Ring = GObject.registerClass(
class Ring extends Gtk.DrawingArea {
    _init() {
        super._init({content_width: 124, content_height: 124});
        this._shown = 0;
        this._target = 0;
        this._animation = null;
        this.set_draw_func((_area, cr, w, h) => this._draw(cr, w, h));
    }

    /** 0..1 (values above 1 show a full ring). Animated from the current value. */
    setFraction(fraction) {
        const to = Math.max(0, Math.min(1, fraction));
        if (Math.abs(to - this._target) < 0.001)
            return;
        this._target = to;
        this._animation?.skip();
        this._animation = animate(this, this._shown, to, 900, v => {
            this._shown = v;
            this.queue_draw();
        });
    }

    _draw(cr, w, h) {
        const r = Math.min(w, h) / 2 - WIDTH;
        cr.setLineWidth(WIDTH);
        cr.setLineCap(Cairo.LineCap.ROUND);
        cr.setSourceRGBA(1, 1, 1, 0.28);
        cr.arc(w / 2, h / 2, r, 0, 2 * Math.PI);
        cr.stroke();
        if (this._shown > 0.001) {
            cr.setSourceRGBA(1, 1, 1, 1);
            cr.arc(w / 2, h / 2, r, -Math.PI / 2, -Math.PI / 2 + 2 * Math.PI * this._shown);
            cr.stroke();
        }
        cr.$dispose();
    }
});
````

- [ ] **Step 7: Create `app/widgets/timeline.js`**

````js
// The day at a glance: worked time as a blue bar, breaks striped orange, a red "now" marker.
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import PangoCairo from 'gi://PangoCairo';

import {animate} from './anim.js';

const BAR = 14;
const BLUE = [0.21, 0.52, 0.89];
const ORANGE = [0.9, 0.65, 0.04];
const RED = [0.88, 0.11, 0.14];

function roundedRect(cr, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    cr.newSubPath();
    cr.arc(x + w - rr, y + rr, rr, -Math.PI / 2, 0);
    cr.arc(x + w - rr, y + h - rr, rr, 0, Math.PI / 2);
    cr.arc(x + rr, y + h - rr, rr, Math.PI / 2, Math.PI);
    cr.arc(x + rr, y + rr, rr, Math.PI, 1.5 * Math.PI);
    cr.closePath();
}

export const Timeline = GObject.registerClass(
class Timeline extends Gtk.DrawingArea {
    _init() {
        super._init({content_height: 44, hexpand: true});
        this._data = null;
        this._grow = 1;
        this.set_draw_func((_area, cr, w) => this._draw(cr, w));
    }

    /**
     * @param {{arrival: number, now: number, breaks: Array<[number, number]>}|null} data
     *   minutes since midnight; breaks are clipped to [arrival, now].
     */
    setData(data) {
        const first = this._data === null;
        this._data = data;
        if (first && data)
            animate(this, 0, 1, 900, v => {
                this._grow = v;
                this.queue_draw();
            });
        this.queue_draw();
    }

    _draw(cr, w) {
        const d = this._data;
        if (!d) {
            cr.$dispose();
            return;
        }
        const fg = this.get_color();
        const startH = Math.min(7, Math.floor(d.arrival / 60));
        const endH = Math.max(20, Math.ceil(d.now / 60));
        const span = (endH - startH) * 60;
        const x = m => ((m - startH * 60) / span) * w;

        cr.setSourceRGBA(fg.red, fg.green, fg.blue, 0.1);
        roundedRect(cr, 0, 0, w, BAR, BAR / 2);
        cr.fill();

        const workEnd = d.arrival + (d.now - d.arrival) * this._grow;
        cr.setSourceRGBA(...BLUE, 1);
        roundedRect(cr, x(d.arrival), 0, Math.max(BAR, x(workEnd) - x(d.arrival)), BAR, BAR / 2);
        cr.fill();

        for (const [s, e] of d.breaks) {
            const bs = Math.max(s, d.arrival);
            const be = Math.min(e, workEnd);
            if (be <= bs)
                continue;
            cr.save();
            cr.rectangle(x(bs), 0, x(be) - x(bs), BAR);
            cr.clip();
            cr.setSourceRGBA(...ORANGE, 1);
            cr.paint();
            cr.setSourceRGBA(0.96, 0.83, 0.18, 1);
            cr.setLineWidth(3);
            for (let sx = x(bs) - BAR; sx < x(be) + BAR; sx += 8) {
                cr.moveTo(sx, BAR);
                cr.lineTo(sx + BAR, 0);
            }
            cr.stroke();
            cr.restore();
        }

        if (this._grow >= 1) {
            cr.setSourceRGBA(...RED, 1);
            cr.rectangle(x(d.now) - 1, -2, 2, BAR + 4);
            cr.fill();
        }

        cr.setSourceRGBA(fg.red, fg.green, fg.blue, 0.6);
        for (let hour = startH; hour <= endH; hour += 2) {
            const layout = this.create_pango_layout(`${hour}`);
            const [, extents] = layout.get_pixel_extents();
            const lx = Math.max(0, Math.min(w - extents.width, x(hour * 60) - extents.width / 2));
            cr.moveTo(lx, BAR + 6);
            PangoCairo.show_layout(cr, layout);
        }
        cr.$dispose();
    }
});
````

- [ ] **Step 8: Create `app/widgets/confetti.js`**

````js
// A short confetti burst drawn over the whole window (does not take clicks).
import Adw from 'gi://Adw?version=1';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';

import {animate} from './anim.js';

const COLORS = [[0.21, 0.52, 0.89], [0.18, 0.76, 0.49], [0.9, 0.65, 0.04], [0.88, 0.11, 0.14], [0.57, 0.25, 0.67], [0.96, 0.83, 0.18]];
const COUNT = 140;
const SECONDS = 2.6;
const GRAVITY = 900;

export const Confetti = GObject.registerClass(
class Confetti extends Gtk.DrawingArea {
    _init() {
        super._init({can_target: false, hexpand: true, vexpand: true});
        this._particles = [];
        this._t = 0;
        this.set_draw_func((_area, cr, w, h) => this._draw(cr, w, h));
    }

    burst() {
        this._particles = Array.from({length: COUNT}, () => ({
            x: 0.3 + Math.random() * 0.4,
            vx: (Math.random() - 0.5) * 700,
            vy: -300 - Math.random() * 600,
            spin: (Math.random() - 0.5) * 12,
            size: 5 + Math.random() * 6,
            color: COLORS[Math.floor(Math.random() * COLORS.length)],
        }));
        animate(this, 0, 1, SECONDS * 1000, v => {
            this._t = v;
            if (v >= 1)
                this._particles = [];
            this.queue_draw();
        }, Adw.Easing.LINEAR);
    }

    _draw(cr, w, h) {
        const t = this._t * SECONDS;
        const alpha = this._t < 0.7 ? 1 : (1 - this._t) / 0.3;
        for (const p of this._particles) {
            const px = p.x * w + p.vx * t;
            const py = h * 0.35 + p.vy * t + (GRAVITY * t * t) / 2;
            cr.save();
            cr.translate(px, py);
            cr.rotate(p.spin * t);
            cr.setSourceRGBA(...p.color, alpha);
            cr.rectangle(-p.size / 2, -p.size / 4, p.size, p.size / 2);
            cr.fill();
            cr.restore();
        }
        cr.$dispose();
    }
});
````

- [ ] **Step 9: Create `app/style.css`**

````css
/* Time Tracker app styles (GTK 4 CSS, on top of libadwaita). */

/* Today: the hero card changes color with the state of the day. */
.hero {
  border-radius: 18px;
  padding: 18px;
  color: white;
  transition: background-image 600ms ease-in-out;
}
.hero.working { background-image: linear-gradient(135deg, #1c71d8, #3584e4 55%, #62a0ea); }
.hero.break { background-image: linear-gradient(135deg, #c64600, #e5a50a 60%, #f6d32d); }
.hero.done { background-image: linear-gradient(135deg, #1f8a5a, #2ec27e 55%, #57e389); }
.hero-big { font-size: 26px; font-weight: 800; }
.hero-small { font-size: 11px; font-weight: 700; opacity: 0.85; }
.hero-title { font-size: 22px; font-weight: 800; }
.hero-dim { font-weight: 600; opacity: 0.9; }

.chip {
  background-color: alpha(white, 0.22);
  border-radius: 99px;
  padding: 4px 10px;
  font-size: 12px;
  font-weight: 700;
}
.pulse-dot {
  min-width: 8px;
  min-height: 8px;
  border-radius: 99px;
  background-color: white;
  animation: pulse 1.4s ease-in-out infinite;
}
@keyframes pulse { 50% { opacity: 0.25; } }

.card-box {
  background-color: var(--card-bg-color);
  border-radius: 12px;
  padding: 12px;
  box-shadow: 0 0 0 1px var(--card-shade-color), 0 1px 3px 1px var(--card-shade-color);
}

/* Main buttons. */
.big-button { padding: 10px 16px; font-weight: 800; border-radius: 12px; }
.break-action {
  background-image: linear-gradient(135deg, #e5a50a, #f6d32d);
  color: #4a3000;
}
.break-action:hover { background-image: linear-gradient(135deg, #f0b31c, #f8e45c); }

/* History. */
.summary-chip {
  background-color: var(--card-bg-color);
  border-radius: 10px;
  padding: 8px;
  box-shadow: 0 0 0 1px var(--card-shade-color);
}
.summary-value { font-size: 16px; font-weight: 800; }
.pill {
  border-radius: 99px;
  padding: 2px 8px;
  font-size: 11.5px;
  font-weight: 800;
}
.pill.plus { background-color: alpha(#2ec27e, 0.2); color: #1a7f4f; }
.pill.minus { background-color: alpha(#e66100, 0.18); color: #a3470b; }
.pill.today { background-color: alpha(#3584e4, 0.18); color: #1c5fb0; }
.today-row { background-color: alpha(#3584e4, 0.08); }
progressbar.mini trough { min-height: 6px; min-width: 64px; border-radius: 3px; }
progressbar.mini progress { min-height: 6px; border-radius: 3px; background-color: #3584e4; }
progressbar.mini.ot progress { background-color: #2ec27e; }

.fade-in { animation: fade-in 450ms ease-out both; }
@keyframes fade-in { from { opacity: 0; } }
.d1 { animation-delay: 40ms; }
.d2 { animation-delay: 80ms; }
.d3 { animation-delay: 120ms; }
.d4 { animation-delay: 160ms; }
.d5 { animation-delay: 200ms; }
.d6 { animation-delay: 240ms; }
.d7 { animation-delay: 280ms; }
.d8 { animation-delay: 320ms; }

/* Stats cards. */
.stat-card {
  border-radius: 12px;
  padding: 10px 12px;
  color: white;
  font-size: 11px;
  font-weight: 700;
}
.stat-value { font-size: 21px; font-weight: 800; }
.stat-card.c1 { background-image: linear-gradient(135deg, #1c71d8, #62a0ea); }
.stat-card.c2 { background-image: linear-gradient(135deg, #26a269, #57e389); }
.stat-card.c3 { background-image: linear-gradient(135deg, #813d9c, #c061cb); }
.stat-card.c4 { background-image: linear-gradient(135deg, #c64600, #f8a13f); }

.error-text { color: var(--error-color); font-weight: 600; }
````

- [ ] **Step 10: Create `app/pages/today.js`**

````js
// Today: hero card (ring, arrival, left/overtime, break chip), timeline, details, actions.
import Adw from 'gi://Adw?version=1';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';

import {formatDuration, formatSigned, parseHM} from '../../time-tracker@anjrakot/lib/timecalc.js';
import {Ring} from '../widgets/ring.js';
import {Timeline} from '../widgets/timeline.js';

const minutesOf = text => parseHM(text.slice(0, 5));
const label = (text, css = []) => new Gtk.Label({label: text, css_classes: css, xalign: 0});

function valueRow(group, title) {
    const row = new Adw.ActionRow({title});
    const value = new Gtk.Label({css_classes: ['dim-label'], xalign: 1, justify: Gtk.Justification.RIGHT});
    row.add_suffix(value);
    group.add(row);
    return value;
}

export const TodayPage = GObject.registerClass(
class TodayPage extends Gtk.Stack {
    /** @param {object} ctx  shared window context (see window.js) */
    _init(ctx) {
        super._init({transition_type: Gtk.StackTransitionType.CROSSFADE});
        this._ctx = ctx;
        this._celebrated = null;

        this.add_named(new Adw.StatusPage({
            icon_name: 'preferences-system-time-symbolic',
            title: 'The tracker is off',
            description: 'Enable the Time Tracker extension to see today.\nHistory and Stats still work.',
        }), 'off');

        const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 14,
            margin_top: 16, margin_bottom: 24, margin_start: 16, margin_end: 16});
        this.add_named(new Gtk.ScrolledWindow({
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            child: new Adw.Clamp({maximum_size: 560, child: box}),
        }), 'live');

        // Hero card.
        this._hero = new Gtk.Box({spacing: 16, css_classes: ['hero', 'working']});
        this._ring = new Ring();
        const ringOverlay = new Gtk.Overlay({child: this._ring});
        const ringText = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER});
        this._worked = new Gtk.Label({css_classes: ['hero-big']});
        this._of = new Gtk.Label({css_classes: ['hero-small']});
        ringText.append(this._worked);
        ringText.append(this._of);
        ringOverlay.add_overlay(ringText);
        this._hero.append(ringOverlay);

        const heroText = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 4, valign: Gtk.Align.CENTER});
        this._arrived = label('', ['hero-dim']);
        this._left = label('', ['hero-title']);
        this._chip = new Gtk.Box({spacing: 6, css_classes: ['chip'], halign: Gtk.Align.START});
        this._chip.append(new Gtk.Box({css_classes: ['pulse-dot'], valign: Gtk.Align.CENTER}));
        this._chipLabel = new Gtk.Label();
        this._chip.append(this._chipLabel);
        heroText.append(this._arrived);
        heroText.append(this._left);
        heroText.append(this._chip);
        this._hero.append(heroText);
        box.append(this._hero);

        // Timeline.
        this._timeline = new Timeline();
        const timelineCard = new Gtk.Box({css_classes: ['card-box']});
        timelineCard.append(this._timeline);
        box.append(timelineCard);

        // Details.
        const details = new Adw.PreferencesGroup();
        this._breaks = valueRow(details, 'Breaks');
        this._next = valueRow(details, 'Next alert');
        this._leave = valueRow(details, 'Leave at');
        box.append(details);

        // Actions.
        this._breakButton = new Gtk.Button({css_classes: ['big-button']});
        this._breakButton.connect('clicked', () => ctx.run(this._view?.onBreak ? 'FinishBreak' : 'StartBreak'));
        box.append(this._breakButton);
        const row = new Gtk.Box({spacing: 8, homogeneous: true});
        const setArrival = new Gtk.Button({label: '✎ Set arrival…', css_classes: ['big-button']});
        setArrival.connect('clicked', () => this._askArrival());
        const reset = new Gtk.Button({label: '↺ Reset arrival', css_classes: ['big-button']});
        reset.connect('clicked', () => this._confirmReset());
        row.append(setArrival);
        row.append(reset);
        box.append(row);

        this.set_visible_child_name('off');
    }

    /** @param {object|null} view  Tracker.view() from the extension, or null when it is off */
    update(view) {
        this._view = view;
        if (!view) {
            this.set_visible_child_name('off');
            return;
        }
        this.set_visible_child_name('live');
        const done = view.targetMin > 0 && view.workedMin >= view.targetMin;

        for (const css of ['working', 'break', 'done'])
            this._hero.remove_css_class(css);
        this._hero.add_css_class(view.onBreak ? 'break' : done ? 'done' : 'working');
        this._ring.setFraction(view.targetMin > 0 ? view.workedMin / view.targetMin : 1);
        this._worked.label = formatDuration(view.workedMin);
        this._of.label = view.targetMin > 0 ? `of ${formatDuration(view.targetMin)}` : 'worked';
        this._arrived.label = `Arrived ${view.arrival.slice(0, 5)}`;
        this._left.label = done ? `${formatSigned(view.overtimeMin)} overtime` : `${formatDuration(view.remainingMin)} left`;
        this._chip.visible = view.onBreak || done;
        this._chipLabel.label = view.onBreak ? `☕ Break since ${view.openBreak.slice(0, 5)}` : '🎉 Day complete';

        const breaks = [...(view.fixedBreak ? [[...view.fixedBreak, 'fixed']] : []), ...view.breaks];
        this._breaks.label = [
            ...breaks.map(([s, e, tag]) => `${s.slice(0, 5)}–${e.slice(0, 5)}${tag ? ' (fixed)' : ''}`),
            ...(view.onBreak ? [`${view.openBreak.slice(0, 5)}–…`] : []),
        ].join('\n') || 'none';
        this._next.label = view.next?.paused ? `${view.next.label} · paused`
            : view.next ? `${view.next.label} at ${view.next.time}` : 'none';
        this._leave.label = view.leaveAt ?? (view.onBreak ? 'after the break' : '—');

        const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
        this._timeline.setData({
            arrival: minutesOf(view.arrival),
            now: Math.max(nowMin, minutesOf(view.arrival)),
            breaks: [
                ...breaks.map(([s, e]) => [minutesOf(s), minutesOf(e)]),
                ...(view.onBreak ? [[minutesOf(view.openBreak), nowMin]] : []),
            ],
        });

        this._breakButton.label = view.onBreak ? '▶ Finish break' : '☕ Start break';
        this._breakButton.css_classes = ['big-button', view.onBreak ? 'break-action' : 'suggested-action'];

        if (done && this._celebrated !== view.date) {
            this._celebrated = view.date;
            this._ctx.celebrate();
        }
    }

    _askArrival() {
        const entry = new Gtk.Entry({text: this._view?.arrival.slice(0, 5) ?? '', input_purpose: Gtk.InputPurpose.DIGITS});
        const dialog = new Adw.AlertDialog({heading: 'Set arrival', body: 'Today\'s arrival time (H:MM).', extra_child: entry});
        dialog.add_response('cancel', 'Cancel');
        dialog.add_response('set', 'Set');
        dialog.set_response_appearance('set', Adw.ResponseAppearance.SUGGESTED);
        dialog.set_default_response('set');
        entry.connect('activate', () => dialog.response('set'));
        dialog.connect('response', (_d, id) => {
            if (id === 'set')
                this._ctx.run('SetArrival', entry.text.trim());
        });
        dialog.present(this._ctx.window);
    }

    _confirmReset() {
        const dialog = new Adw.AlertDialog({
            heading: 'Reset arrival to now?',
            body: 'Today\'s arrival becomes the current time and today\'s alerts start again.',
        });
        dialog.add_response('cancel', 'Cancel');
        dialog.add_response('reset', 'Reset');
        dialog.set_response_appearance('reset', Adw.ResponseAppearance.DESTRUCTIVE);
        dialog.connect('response', (_d, id) => {
            if (id === 'reset')
                this._ctx.run('ResetArrival');
        });
        dialog.present(this._ctx.window);
    }
});
````

- [ ] **Step 11: Create `app/window.js`** (Today tab only; Tasks 6 and 7 add History and Stats)

````js
// Main window: header-bar tabs (Today · History · Stats), off banner, toasts, confetti.
import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';

import {TodayPage} from './pages/today.js';
import {Confetti} from './widgets/confetti.js';

export const TrackerWindow = GObject.registerClass(
class TrackerWindow extends Adw.ApplicationWindow {
    /**
     * @param {object} params
     * @param {Adw.Application} params.application
     * @param {import('./client.js').TrackerClient} params.client
     * @param {import('./data.js').History} params.history
     */
    _init({application, client, history}) {
        super._init({application, title: 'Time Tracker', default_width: 460, default_height: 780,
            width_request: 360, height_request: 480});
        this._client = client;
        this._pending = 0;

        // Shared by all pages and dialogs.
        const ctx = {
            client,
            history,
            window: this,
            toast: text => this._toasts.add_toast(new Adw.Toast({title: text, timeout: 4})),
            run: (method, ...args) => this._run(method, ...args),
            openToday: () => this._stack.set_visible_child_name('today'),
            celebrate: () => this._confetti.burst(),
        };

        this._stack = new Adw.ViewStack();
        this._todayPage = new TodayPage(ctx);
        this._stack.add_titled_with_icon(this._todayPage, 'today', 'Today', 'preferences-system-time-symbolic');

        const header = new Adw.HeaderBar({title_widget: new Adw.ViewSwitcher({stack: this._stack, policy: Adw.ViewSwitcherPolicy.WIDE})});
        const menu = new Gio.Menu();
        menu.append('Settings', 'app.settings');
        menu.append('About Time Tracker', 'app.about');
        header.pack_end(new Gtk.MenuButton({icon_name: 'open-menu-symbolic', menu_model: menu, primary: true, tooltip_text: 'Main menu'}));
        const switcherBar = new Adw.ViewSwitcherBar({stack: this._stack});

        this._banner = new Adw.Banner({title: 'The tracker is off — view only'});
        this._toasts = new Adw.ToastOverlay({child: this._stack});
        const overlay = new Gtk.Overlay({child: this._toasts});
        this._confetti = new Confetti();
        overlay.add_overlay(this._confetti);

        const toolbar = new Adw.ToolbarView({content: overlay});
        toolbar.add_top_bar(header);
        toolbar.add_top_bar(this._banner);
        toolbar.add_bottom_bar(switcherBar);
        this.set_content(toolbar);

        // Narrow window: tabs move to a bar at the bottom.
        const narrow = new Adw.Breakpoint({condition: Adw.BreakpointCondition.parse('max-width: 420sp')});
        narrow.add_setter(switcherBar, 'reveal', true);
        narrow.add_setter(header, 'show-title', false);
        this.add_breakpoint(narrow);

        client.onChange(() => this.refresh());
        this.refresh();
    }

    /** Re-read everything (coalesced: several change signals in a row cause one refresh). */
    refresh() {
        if (this._pending)
            return;
        this._pending = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._pending = 0;
            this._reload().catch(e => console.error(`[time-tracker] refresh failed: ${e}`));
            return GLib.SOURCE_REMOVE;
        });
    }

    async _reload() {
        const online = this._client.online;
        this._banner.revealed = !online;
        let today = null;
        if (online) {
            try {
                today = await this._client.today();
            } catch (e) {
                console.error(`[time-tracker] GetToday failed: ${e}`);
            }
        }
        this._todayPage.update(today);
    }

    /** Call an extension action; shows the refusal as a toast. Resolves to true on success. */
    async _run(method, ...args) {
        try {
            await this._client.call(method, ...args);
            this.refresh();
            return true;
        } catch (e) {
            this._toasts.add_toast(new Adw.Toast({title: e.message, timeout: 5}));
            return false;
        }
    }

    showPage(name) {
        this._stack.set_visible_child_name(name);
    }
});
````

- [ ] **Step 12: Create `app/main.js`**

````js
// Time Tracker app entry point: `gjs -m app/main.js` (installed as `time-tracker`).
import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import System from 'system';

import {TrackerClient} from './client.js';
import {APP_DIR, EXTENSION_UUID, History, openExtensionSettings} from './data.js';
import {TrackerWindow} from './window.js';

const APP_ID = 'io.github.fafafa12.TimeTracker';

const app = new Adw.Application({application_id: APP_ID});
let client = null;
let history = null;

function addAction(name, callback, accels = []) {
    const action = new Gio.SimpleAction({name});
    action.connect('activate', callback);
    app.add_action(action);
    if (accels.length)
        app.set_accels_for_action(`app.${name}`, accels);
}

app.connect('startup', () => {
    const css = new Gtk.CssProvider();
    css.load_from_path(GLib.build_filenamev([APP_DIR, 'style.css']));
    Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(), css, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
    Gtk.IconTheme.get_for_display(Gdk.Display.get_default()).add_search_path(GLib.build_filenamev([APP_DIR, 'icons']));

    client = new TrackerClient();
    history = new History(openExtensionSettings());

    addAction('settings', () => {
        try {
            Gio.Subprocess.new(['gnome-extensions', 'prefs', EXTENSION_UUID], Gio.SubprocessFlags.NONE);
        } catch (e) {
            console.error(`[time-tracker] cannot open settings: ${e}`);
        }
    });
    addAction('about', () => new Adw.AboutDialog({
        application_name: 'Time Tracker',
        application_icon: APP_ID,
        developer_name: 'anjrakot',
        version: '2.0',
        website: 'https://github.com/Fafafa12/time_tracker',
        comments: 'Counts office time, breaks and overtime.',
        license_type: Gtk.License.MIT_X11,
    }).present(app.active_window));
    addAction('quit', () => app.quit(), ['<Control>q']);
    app.set_accels_for_action('window.close', ['<Control>w']);
});

app.connect('activate', () => {
    // Screenshot mode (dev/preview.sh): Broadway has no frame clock without a browser, so
    // animations would never finish; turn them off like GNOME's "reduce animation" setting.
    if (GLib.getenv('TT_SCREENSHOT'))
        Gtk.Settings.get_default().gtk_enable_animations = false;
    const win = app.active_window ?? new TrackerWindow({application: app, client, history});
    win.present();
    maybeScreenshot(win);
});

/** Dev only (dev/preview.sh): TT_SCREENSHOT=out.png [TT_PAGE=history] renders the window and quits. */
function maybeScreenshot(win) {
    const out = GLib.getenv('TT_SCREENSHOT');
    if (!out)
        return;
    const page = GLib.getenv('TT_PAGE');
    if (page)
        win.showPage(page);
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, Number(GLib.getenv('TT_DELAY_MS') ?? 2500), () => {
        const paintable = new Gtk.WidgetPaintable({widget: win});
        const snapshot = new Gtk.Snapshot();
        paintable.snapshot(snapshot, win.get_width(), win.get_height());
        const node = snapshot.to_node();
        if (node)
            win.get_renderer().render_texture(node, null).save_to_png(out);
        app.quit();
        return GLib.SOURCE_REMOVE;
    });
}

app.run([System.programInvocationName, ...ARGV]);
````

- [ ] **Step 13: Create the launcher `app/time-tracker` and make it executable (`chmod +x app/time-tracker`)**

````sh
#!/bin/sh
# Launcher for the Time Tracker app (install.sh links it as ~/.local/bin/time-tracker).
exec gjs -m "$(dirname "$(readlink -f "$0")")/main.js" "$@"
````

- [ ] **Step 14: Create the two icons**

`app/icons/hicolor/scalable/actions/tt-stats-symbolic.svg`:

````xml
<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><g fill="#2e3436"><rect x="1" y="9" width="3" height="6" rx="1"/><rect x="6.5" y="5" width="3" height="10" rx="1"/><rect x="12" y="1" width="3" height="14" rx="1"/></g></svg>
````

`app/icons/hicolor/scalable/apps/io.github.fafafa12.TimeTracker.svg`:

````xml
<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1c71d8"/><stop offset="1" stop-color="#62a0ea"/></linearGradient>
  </defs>
  <rect x="8" y="8" width="112" height="112" rx="28" fill="url(#bg)"/>
  <circle cx="64" cy="66" r="36" fill="none" stroke="#ffffff" stroke-opacity="0.3" stroke-width="10"/>
  <path d="M64 30 A36 36 0 1 1 30.3 78.7" fill="none" stroke="#ffffff" stroke-width="10" stroke-linecap="round"/>
  <path d="M64 66 L64 46 M64 66 L78 74" stroke="#ffffff" stroke-width="7" stroke-linecap="round"/>
  <circle cx="64" cy="66" r="5" fill="#f6d32d"/>
</svg>
````

- [ ] **Step 15: Syntax check**

Run:
```bash
for f in app/main.js app/window.js app/client.js app/data.js app/pages/today.js app/widgets/anim.js app/widgets/ring.js app/widgets/timeline.js app/widgets/confetti.js dev/fake-service.js; do cp "$f" /tmp/tt-check.mjs && node --check /tmp/tt-check.mjs && echo "$f ok"; done
```
Expected: 10 `… ok` lines. Then run `bash -n dev/preview.sh && echo ok` and expect `ok`.

- [ ] **Step 16: Render Today off-screen and look at it**

Run:
```bash
rm -rf /tmp/tt-t5 && PAGES=today DIALOGS= dev/preview.sh /tmp/tt-t5 2>&1 | grep -E "CRITICAL|JS ERROR|Screenshots"
PAGES=today DIALOGS= dev/preview.sh /tmp/tt-t5-break --break 2>&1 | grep -E "CRITICAL|JS ERROR|Screenshots"
PAGES=today DIALOGS= dev/preview.sh /tmp/tt-t5-off --offline 2>&1 | grep -E "CRITICAL|JS ERROR|Screenshots"
```
Expected: only `Screenshots in …` lines, with no `CRITICAL` or `JS ERROR`. Open the three `today.png` files (the Read tool shows images). Check that:
- `/tmp/tt-t5/today.png` has a blue card with the ring, "Arrived HH:MM" (today's boot time) and "…left", the timeline, the Breaks / Next alert / Leave at rows, a blue "☕ Start break" button, and Set arrival… / Reset arrival.
- `/tmp/tt-t5-break/today.png` has an orange card, a "☕ Break since …" chip, "▶ Finish break" in orange, and Leave at "after the break".
- `/tmp/tt-t5-off/today.png` shows the banner "The tracker is off — view only" and the "The tracker is off" status page.

- [ ] **Step 17: Commit**

```bash
git add "dev/fake-service.js" "dev/preview.sh" "app/data.js" "app/client.js" "app/style.css" "app/window.js" "app/main.js" "app/time-tracker" "app/pages/today.js" "app/widgets/anim.js" "app/widgets/ring.js" "app/widgets/timeline.js" "app/widgets/confetti.js" "app/icons"
git commit -m "feat: Time Tracker app with the Today page, drawn widgets and an off-screen preview tool

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: History page and the day dialog (edit / ＋ Add day)

**Files:**
- Create: `app/dayDialog.js`, `app/pages/history.js`
- Modify: `app/window.js` (5 edits), `app/main.js` (1 edit)

**Interfaces:**
- **Consumes:** `computeDay`, `dayFromInput`, `inputFromDay`, `validateDay(…, {adding, exists})`, `DEFAULT_TARGET_MIN`, `ctx`, `History.month`.
- **Produces:**
  - `DayDialog(ctx, day|null, defaultDate)`, `yesterdayKey(now?)`
  - `HistoryPage(ctx)` with `reload()`, `openAddDay()`
  - `TrackerWindow.openAddDay()`
  - dev only: `TT_DIALOG=add`

- [ ] **Step 1: Create `app/dayDialog.js`**

````js
// Edit a past day, or add a missing one. Checks with day.validateDay as you type;
// Save sends SaveDay to the extension (the only writer).
import Adw from 'gi://Adw?version=1';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';

import {
    DEFAULT_TARGET_MIN, computeDay, dayFromInput, inputFromDay, validateDay,
} from '../time-tracker@anjrakot/lib/day.js';
import {dateFromKey, dateKey, formatDuration, formatSigned} from '../time-tracker@anjrakot/lib/timecalc.js';

const LONG_DATE = {weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'};

function timeEntry(text) {
    return new Gtk.Entry({text, max_width_chars: 5, width_chars: 5, valign: Gtk.Align.CENTER, xalign: 0.5});
}

function markError(widget, bad) {
    if (bad)
        widget.add_css_class('error');
    else
        widget.remove_css_class('error');
}

export const DayDialog = GObject.registerClass(
class DayDialog extends Adw.Dialog {
    /**
     * @param {object} ctx  window context
     * @param {object|null} day  the Day to edit, or null to add one
     * @param {string} defaultDate  "YYYY-MM-DD" proposed when adding
     */
    _init(ctx, day, defaultDate) {
        const adding = day === null;
        super._init({title: adding ? 'Add a day' : 'Edit day', content_width: 400});
        this._ctx = ctx;
        this._adding = adding;
        this._key = adding ? defaultDate : day.date;
        this._target = day?.targetMin ?? DEFAULT_TARGET_MIN;
        const input = adding
            ? {arrival: '8:00', departure: '16:30', breaks: [], fixedBreak: ['12:30', '13:30']}
            : inputFromDay(day);

        const header = new Adw.HeaderBar({show_end_title_buttons: false, show_start_title_buttons: false});
        const cancel = new Gtk.Button({label: 'Cancel'});
        cancel.connect('clicked', () => this.close());
        this._save = new Gtk.Button({label: 'Save', css_classes: ['suggested-action']});
        this._save.connect('clicked', () => this._onSave());
        header.pack_start(cancel);
        header.pack_end(this._save);

        const page = new Adw.PreferencesPage();
        this._summary = new Gtk.Label({wrap: true, css_classes: ['title-4'], margin_bottom: 4});
        const top = new Adw.PreferencesGroup({
            title: adding ? 'New day' : dateFromKey(this._key).toLocaleDateString(undefined, LONG_DATE),
        });
        top.set_header_suffix(this._summary);
        if (adding) {
            this._date = new Adw.EntryRow({title: 'Date (YYYY-MM-DD)', text: this._key});
            this._date.connect('changed', () => this._check());
            top.add(this._date);
        }
        this._arrival = new Adw.EntryRow({title: 'Arrival (H:MM)', text: input.arrival});
        this._departure = new Adw.EntryRow({title: 'Departure (H:MM)', text: input.departure});
        for (const row of [this._arrival, this._departure]) {
            row.connect('changed', () => this._check());
            top.add(row);
        }
        page.add(top);

        const fixed = new Adw.PreferencesGroup({title: 'Fixed break'});
        this._fixedOn = new Adw.SwitchRow({title: 'Fixed break this day', active: input.fixedBreak !== null});
        this._fixedStart = new Adw.EntryRow({title: 'Start (H:MM)', text: input.fixedBreak?.[0] ?? '12:30'});
        this._fixedEnd = new Adw.EntryRow({title: 'End (H:MM)', text: input.fixedBreak?.[1] ?? '13:30'});
        this._fixedOn.connect('notify::active', () => this._check());
        fixed.add(this._fixedOn);
        for (const row of [this._fixedStart, this._fixedEnd]) {
            this._fixedOn.bind_property('active', row, 'sensitive', GObject.BindingFlags.SYNC_CREATE);
            row.connect('changed', () => this._check());
            fixed.add(row);
        }
        page.add(fixed);

        this._breaksGroup = new Adw.PreferencesGroup({title: 'Breaks'});
        const add = new Gtk.Button({icon_name: 'list-add-symbolic', css_classes: ['flat'], tooltip_text: 'Add break'});
        add.connect('clicked', () => {
            this._addBreak('15:00', '15:15');
            this._check();
        });
        this._breaksGroup.set_header_suffix(add);
        this._breakRows = [];
        input.breaks.forEach(([s, e]) => this._addBreak(s, e));
        page.add(this._breaksGroup);

        if (!adding) {
            const danger = new Adw.PreferencesGroup();
            const del = new Gtk.Button({label: 'Delete day', css_classes: ['destructive-action', 'pill'], halign: Gtk.Align.CENTER});
            del.connect('clicked', () => this._confirmDelete());
            danger.add(del);
            page.add(danger);
        }

        const view = new Adw.ToolbarView({content: page});
        view.add_top_bar(header);
        this.set_child(view);
        this._check();
    }

    _addBreak(start, end) {
        const row = new Adw.ActionRow({title: `Break ${this._breakRows.length + 1}`});
        const s = timeEntry(start);
        const e = timeEntry(end);
        const remove = new Gtk.Button({icon_name: 'user-trash-symbolic', css_classes: ['flat'], valign: Gtk.Align.CENTER});
        row.add_suffix(s);
        row.add_suffix(new Gtk.Label({label: '–'}));
        row.add_suffix(e);
        row.add_suffix(remove);
        const item = {row, s, e};
        remove.connect('clicked', () => {
            this._breakRows.splice(this._breakRows.indexOf(item), 1);
            this._breaksGroup.remove(row);
            this._breakRows.forEach((b, i) => (b.row.title = `Break ${i + 1}`));
            this._check();
        });
        s.connect('changed', () => this._check());
        e.connect('changed', () => this._check());
        this._breakRows.push(item);
        this._breaksGroup.add(row);
    }

    _input() {
        return {
            arrival: this._arrival.text.trim(),
            departure: this._departure.text.trim(),
            breaks: this._breakRows.map(b => [b.s.text.trim(), b.e.text.trim()]),
            fixedBreak: this._fixedOn.active ? [this._fixedStart.text.trim(), this._fixedEnd.text.trim()] : null,
        };
    }

    _currentKey() {
        return this._adding ? this._date.text.trim() : this._key;
    }

    /** Validate, mark fields, update the live summary and the Save button. */
    _check() {
        const input = this._input();
        const key = this._currentKey();
        const exists = this._adding && this._ctx.history.month(key.slice(0, 7)).some(d => d.date === key);
        const errors = validateDay(input, key, new Date(), {adding: this._adding, exists});
        const fields = new Set(errors.map(e => e.field));
        if (this._adding)
            markError(this._date, fields.has('date'));
        markError(this._arrival, fields.has('arrival'));
        markError(this._departure, fields.has('departure'));
        markError(this._fixedStart, fields.has('fixedBreak'));
        markError(this._fixedEnd, fields.has('fixedBreak'));
        this._breakRows.forEach((b, i) => {
            markError(b.s, fields.has(`breaks.${i}`));
            markError(b.e, fields.has(`breaks.${i}`));
        });
        this._save.sensitive = errors.length === 0 && this._ctx.client.online;
        if (errors.length) {
            this._summary.label = errors[0].message;
            this._summary.css_classes = ['error-text'];
            return;
        }
        const {workedMin, overtimeMin} = computeDay(dayFromInput(key, input, this._target));
        this._summary.label = `${formatDuration(workedMin)} · ${formatSigned(overtimeMin)}`;
        this._summary.css_classes = ['title-4'];
    }

    async _onSave() {
        this._save.sensitive = false;
        if (await this._ctx.run('SaveDay', this._currentKey(), JSON.stringify(this._input())))
            this.close();
        else
            this._check();
    }

    _confirmDelete() {
        const dialog = new Adw.AlertDialog({heading: 'Delete this day?', body: 'Its arrival, departure and breaks are removed from the history.'});
        dialog.add_response('cancel', 'Cancel');
        dialog.add_response('delete', 'Delete');
        dialog.set_response_appearance('delete', Adw.ResponseAppearance.DESTRUCTIVE);
        dialog.connect('response', async (_d, id) => {
            if (id === 'delete' && await this._ctx.run('DeleteDay', this._key))
                this.close();
        });
        dialog.present(this);
    }
});

/** Yesterday's date key: the default when adding a day. */
export function yesterdayKey(now = new Date()) {
    return dateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
}
````

- [ ] **Step 2: Create `app/pages/history.js`**

````js
// History: one month at a time, one row per day (newest first); click to edit, "＋ Add day".
import Adw from 'gi://Adw?version=1';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';

import {computeDay} from '../../time-tracker@anjrakot/lib/day.js';
import {dateKey, formatClock, formatDuration, formatSigned, monthKey} from '../../time-tracker@anjrakot/lib/timecalc.js';
import {DayDialog, yesterdayKey} from '../dayDialog.js';

const MONTH_TITLE = {month: 'long', year: 'numeric'};
const WEEKDAY = {weekday: 'short'};

function summaryChip(title) {
    const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, css_classes: ['summary-chip'], hexpand: true});
    box.append(new Gtk.Label({label: title, css_classes: ['caption', 'dim-label']}));
    const value = new Gtk.Label({css_classes: ['summary-value']});
    box.append(value);
    return {box, value};
}

export const HistoryPage = GObject.registerClass(
class HistoryPage extends Gtk.ScrolledWindow {
    _init(ctx) {
        super._init({hscrollbar_policy: Gtk.PolicyType.NEVER});
        this._ctx = ctx;
        const now = new Date();
        this._month = new Date(now.getFullYear(), now.getMonth(), 1);

        const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 12,
            margin_top: 16, margin_bottom: 24, margin_start: 16, margin_end: 16});
        this.set_child(new Adw.Clamp({maximum_size: 560, child: box}));

        const nav = new Gtk.CenterBox();
        const prev = new Gtk.Button({icon_name: 'go-previous-symbolic', css_classes: ['circular']});
        this._next = new Gtk.Button({icon_name: 'go-next-symbolic', css_classes: ['circular']});
        this._title = new Gtk.Label({css_classes: ['title-3']});
        prev.connect('clicked', () => this._shift(-1));
        this._next.connect('clicked', () => this._shift(1));
        nav.set_start_widget(prev);
        nav.set_center_widget(this._title);
        nav.set_end_widget(this._next);
        box.append(nav);

        const chips = new Gtk.Box({spacing: 8, homogeneous: true});
        this._days = summaryChip('Days');
        this._worked = summaryChip('Worked');
        this._overtime = summaryChip('Overtime');
        for (const chip of [this._days, this._worked, this._overtime])
            chips.append(chip.box);
        box.append(chips);

        this._add = new Gtk.Button({label: '＋ Add day', css_classes: ['pill'], halign: Gtk.Align.CENTER});
        this._add.connect('clicked', () => this.openAddDay());
        box.append(this._add);

        this._list = new Gtk.ListBox({css_classes: ['boxed-list'], selection_mode: Gtk.SelectionMode.NONE});
        this._list.set_placeholder(new Gtk.Label({label: 'No days recorded this month', margin_top: 24, margin_bottom: 24, css_classes: ['dim-label']}));
        box.append(this._list);
    }

    openAddDay() {
        new DayDialog(this._ctx, null, yesterdayKey()).present(this._ctx.window);
    }

    _shift(step) {
        this._month = new Date(this._month.getFullYear(), this._month.getMonth() + step, 1);
        this.reload();
    }

    /** Re-read the shown month from disk. */
    reload() {
        const now = new Date();
        const todayKey = dateKey(now);
        this._title.label = this._month.toLocaleDateString(undefined, MONTH_TITLE);
        this._next.sensitive = monthKey(this._month) < monthKey(now);
        this._add.sensitive = this._ctx.client.online;

        const days = this._ctx.history.month(monthKey(this._month)).reverse();
        const past = days.filter(d => d.date < todayKey);
        const totals = past.map(d => computeDay(d));
        this._days.value.label = String(past.length);
        this._worked.value.label = formatDuration(totals.reduce((s, t) => s + t.workedMin, 0));
        const overtime = totals.reduce((s, t) => s + t.overtimeMin, 0);
        this._overtime.value.label = formatSigned(overtime);

        this._list.remove_all();
        days.forEach((day, i) => this._list.append(this._row(day, day.date === todayKey, i, now)));
    }

    _row(day, isToday, index, now) {
        const until = isToday ? now : day.departure ?? day.arrival;
        const {workedMin, overtimeMin} = computeDay(day, until);
        const date = new Date(day.arrival);
        const row = new Adw.ActionRow({
            title: `${date.getDate()} · ${date.toLocaleDateString(undefined, WEEKDAY)}`,
            subtitle: `${formatClock(day.arrival)} → ${isToday ? 'now' : formatClock(day.departure ?? day.arrival)} · ${formatDuration(workedMin)}`,
            activatable: true,
            css_classes: ['fade-in', `d${Math.min(index + 1, 8)}`, ...(isToday ? ['today-row'] : [])],
        });
        const bar = new Gtk.ProgressBar({
            fraction: Math.min(1, day.targetMin ? workedMin / day.targetMin : 1),
            valign: Gtk.Align.CENTER,
            css_classes: ['mini', ...(overtimeMin >= 0 ? ['ot'] : [])],
        });
        const pill = new Gtk.Label({
            label: isToday ? 'today' : formatSigned(overtimeMin),
            valign: Gtk.Align.CENTER,
            css_classes: ['pill', isToday ? 'today' : overtimeMin >= 0 ? 'plus' : 'minus'],
        });
        row.add_suffix(bar);
        row.add_suffix(pill);
        row.connect('activated', () => {
            if (isToday)
                this._ctx.openToday();
            else
                new DayDialog(this._ctx, day, day.date).present(this._ctx.window);
        });
        return row;
    }
});
````

- [ ] **Step 3: Wire it into the window and the screenshot hook**

In `app/window.js`, replace this block (it appears exactly once):

````js
import {TodayPage} from './pages/today.js';
````

with:

````js
import {HistoryPage} from './pages/history.js';
import {TodayPage} from './pages/today.js';
````

In `app/window.js`, replace this block (it appears exactly once):

````js
        this._todayPage = new TodayPage(ctx);
````

with:

````js
        this._todayPage = new TodayPage(ctx);
        this._historyPage = new HistoryPage(ctx);
````

In `app/window.js`, replace this block (it appears exactly once):

````js
        this._stack.add_titled_with_icon(this._todayPage, 'today', 'Today', 'preferences-system-time-symbolic');
````

with:

````js
        this._stack.add_titled_with_icon(this._todayPage, 'today', 'Today', 'preferences-system-time-symbolic');
        this._stack.add_titled_with_icon(this._historyPage, 'history', 'History', 'x-office-calendar-symbolic');
````

In `app/window.js`, replace this block (it appears exactly once):

````js
        this._todayPage.update(today);
````

with:

````js
        this._todayPage.update(today);
        this._historyPage.reload();
````

In `app/window.js`, replace this block (it appears exactly once):

````js
    showPage(name) {
        this._stack.set_visible_child_name(name);
    }
````

with:

````js
    showPage(name) {
        this._stack.set_visible_child_name(name);
    }

    openAddDay() {
        this._historyPage.openAddDay();
    }
````

In `app/main.js`, replace this block (it appears exactly once):

````js
    if (page)
        win.showPage(page);
````

with:

````js
    if (page)
        win.showPage(page);
    if (GLib.getenv('TT_DIALOG') === 'add')
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 800, () => {
            win.openAddDay();
            return GLib.SOURCE_REMOVE;
        });
````


- [ ] **Step 4: Syntax check and render**

Run:
```bash
for f in app/dayDialog.js app/pages/history.js app/window.js app/main.js; do cp "$f" /tmp/tt-check.mjs && node --check /tmp/tt-check.mjs && echo "$f ok"; done
```
```bash
rm -rf /tmp/tt-t6 && PAGES="today history" DIALOGS=add dev/preview.sh /tmp/tt-t6 2>&1 | grep -E "CRITICAL|JS ERROR|Screenshots"
```
Expected: 4 `… ok` lines and only `Screenshots in /tmp/tt-t6`. Check the images:
- `history.png` has the "‹ <this month> ›" navigation (› greyed out), the Days / Worked / Overtime chips, "＋ Add day", and rows newest first. Today's row is highlighted with a "today" pill; other rows have a mini bar (green when over target) and a green `+` or orange `−` pill.
- `dialog-add.png` has the "Add a day" dialog with yesterday's date. Because the sample data already has yesterday (if it was a weekday), the header shows in red "This day already exists: edit it in the list" and Save is greyed out. Otherwise it shows "7h30 · −0h30".

- [ ] **Step 5: Commit**

```bash
git add "app/dayDialog.js" "app/pages/history.js" "app/window.js" "app/main.js"
git commit -m "feat: editable history with an add-day dialog

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Stats page and bar chart

**Files:**
- Create: `app/widgets/barChart.js`, `app/pages/stats.js`
- Modify: `app/window.js` (4 edits)

**Interfaces:**
- **Consumes:** `periodRange`, `shiftPeriod`, `summarize`, `History.range`, `formatDuration`, `formatSigned`, `dateFromKey`.
- **Produces:** `BarChart.setChart(chart)`, `StatsPage(ctx).reload()`.

- [ ] **Step 1: Create `app/widgets/barChart.js`**

````js
// One bar per day: blue up to the target, green overtime on top, orange for days under
// target, a dashed red target line; today faded. Bars grow in when the data changes.
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import PangoCairo from 'gi://PangoCairo';

import {animate} from './anim.js';

const BLUE = [0.21, 0.52, 0.89];
const GREEN = [0.18, 0.76, 0.49];
const ORANGE = [0.9, 0.38, 0.0];
const RED = [0.88, 0.11, 0.14];
const LABELS = 18;

export const BarChart = GObject.registerClass(
class BarChart extends Gtk.DrawingArea {
    _init() {
        super._init({content_height: 170, hexpand: true});
        this._chart = [];
        this._grow = 1;
        this.set_draw_func((_area, cr, w, h) => this._draw(cr, w, h));
    }

    /** @param {Array} chart  stats.summarize(...).chart */
    setChart(chart) {
        const changed = JSON.stringify(chart) !== JSON.stringify(this._chart);
        this._chart = chart;
        if (changed)
            animate(this, 0, 1, 1000, v => {
                this._grow = v;
                this.queue_draw();
            });
        this.queue_draw();
    }

    _draw(cr, w, h) {
        const bars = this._chart;
        if (!bars.length) {
            cr.$dispose();
            return;
        }
        const fg = this.get_color();
        const top = 14;
        const plot = h - LABELS - top;
        const target = Math.max(...bars.map(b => b.targetMin ?? 0), 1);
        const max = Math.max(target * 1.2, ...bars.map(b => b.workedMin ?? 0));
        const y = minutes => top + plot - (minutes / max) * plot;
        const slot = w / bars.length;
        const bw = Math.max(3, Math.min(28, slot * 0.62));

        bars.forEach((b, i) => {
            const cx = slot * i + slot / 2;
            if (!b.empty) {
                const worked = b.workedMin * this._grow;
                const alpha = b.today ? 0.45 : 1;
                const base = Math.min(worked, b.targetMin);
                cr.setSourceRGBA(...(b.workedMin < b.targetMin ? ORANGE : BLUE), alpha);
                cr.rectangle(cx - bw / 2, y(base), bw, y(0) - y(base));
                cr.fill();
                if (worked > b.targetMin) {
                    cr.setSourceRGBA(...GREEN, alpha);
                    cr.rectangle(cx - bw / 2, y(worked), bw, y(b.targetMin) - y(worked));
                    cr.fill();
                }
            }
            if (bars.length <= 16 || i % 2 === 0) {
                const layout = this.create_pango_layout(String(Number(b.date.slice(8))));
                const [, extents] = layout.get_pixel_extents();
                cr.setSourceRGBA(fg.red, fg.green, fg.blue, 0.6);
                cr.moveTo(cx - extents.width / 2, h - LABELS + 2);
                PangoCairo.show_layout(cr, layout);
            }
        });

        cr.setSourceRGBA(...RED, 0.75);
        cr.setLineWidth(1.5);
        cr.setDash([6, 4], 0);
        cr.moveTo(0, y(target));
        cr.lineTo(w, y(target));
        cr.stroke();
        cr.setDash([], 0);
        const layout = this.create_pango_layout(`${Math.round(target / 60 * 10) / 10}h`);
        const [, extents] = layout.get_pixel_extents();
        cr.moveTo(w - extents.width, y(target) - extents.height - 1);
        PangoCairo.show_layout(cr, layout);
        cr.$dispose();
    }
});
````

- [ ] **Step 2: Create `app/pages/stats.js`**

````js
// Stats: week/month totals, bar chart, averages and records.
import Adw from 'gi://Adw?version=1';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';

import {periodRange, shiftPeriod, summarize} from '../../time-tracker@anjrakot/lib/stats.js';
import {dateFromKey, formatDuration, formatSigned} from '../../time-tracker@anjrakot/lib/timecalc.js';
import {BarChart} from '../widgets/barChart.js';

const pad = n => String(n).padStart(2, '0');
const clock = minutes => (minutes === null ? '—' : `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`);
const shortDate = key => dateFromKey(key).toLocaleDateString(undefined, {day: 'numeric', month: 'short'});

function statCard(title, css) {
    const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, css_classes: ['stat-card', css], hexpand: true});
    box.append(new Gtk.Label({label: title, xalign: 0}));
    const value = new Gtk.Label({css_classes: ['stat-value'], xalign: 0});
    box.append(value);
    return {box, value};
}

function valueRow(group, title) {
    const row = new Adw.ActionRow({title});
    const value = new Gtk.Label({css_classes: ['dim-label']});
    row.add_suffix(value);
    group.add(row);
    return value;
}

export const StatsPage = GObject.registerClass(
class StatsPage extends Gtk.ScrolledWindow {
    _init(ctx) {
        super._init({hscrollbar_policy: Gtk.PolicyType.NEVER});
        this._ctx = ctx;
        this._kind = 'month';
        this._anchor = new Date();

        const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 12,
            margin_top: 16, margin_bottom: 24, margin_start: 16, margin_end: 16});
        this.set_child(new Adw.Clamp({maximum_size: 560, child: box}));

        const toggle = new Gtk.Box({css_classes: ['linked'], halign: Gtk.Align.CENTER});
        const week = new Gtk.ToggleButton({label: 'Week'});
        const month = new Gtk.ToggleButton({label: 'Month', group: week, active: true});
        week.connect('toggled', () => {
            if (week.active)
                this._setKind('week');
        });
        month.connect('toggled', () => {
            if (month.active)
                this._setKind('month');
        });
        toggle.append(week);
        toggle.append(month);
        box.append(toggle);

        const nav = new Gtk.CenterBox();
        const prev = new Gtk.Button({icon_name: 'go-previous-symbolic', css_classes: ['circular']});
        this._nextButton = new Gtk.Button({icon_name: 'go-next-symbolic', css_classes: ['circular']});
        this._title = new Gtk.Label({css_classes: ['title-3']});
        prev.connect('clicked', () => this._shift(-1));
        this._nextButton.connect('clicked', () => this._shift(1));
        nav.set_start_widget(prev);
        nav.set_center_widget(this._title);
        nav.set_end_widget(this._nextButton);
        box.append(nav);

        const grid = new Gtk.Grid({column_spacing: 8, row_spacing: 8, column_homogeneous: true});
        this._cards = {
            worked: statCard('Worked', 'c1'),
            overtime: statCard('Overtime', 'c2'),
            days: statCard('Days', 'c3'),
            avg: statCard('Avg / day', 'c4'),
        };
        grid.attach(this._cards.worked.box, 0, 0, 1, 1);
        grid.attach(this._cards.overtime.box, 1, 0, 1, 1);
        grid.attach(this._cards.days.box, 0, 1, 1, 1);
        grid.attach(this._cards.avg.box, 1, 1, 1, 1);
        box.append(grid);

        this._chart = new BarChart();
        const chartCard = new Gtk.Box({css_classes: ['card-box']});
        chartCard.append(this._chart);
        box.append(chartCard);

        const averages = new Adw.PreferencesGroup({title: 'Averages'});
        this._avgArrival = valueRow(averages, 'Arrival · departure');
        this._avgBreak = valueRow(averages, 'Break');
        box.append(averages);

        const records = new Adw.PreferencesGroup({title: 'Records'});
        this._earliest = valueRow(records, '🌅 Earliest arrival');
        this._latest = valueRow(records, '🌙 Latest departure');
        this._longest = valueRow(records, '🏔 Longest day');
        this._shortest = valueRow(records, '🐣 Shortest day');
        box.append(records);
    }

    _setKind(kind) {
        this._kind = kind;
        this._anchor = new Date();
        this.reload();
    }

    _shift(step) {
        this._anchor = shiftPeriod(this._kind, this._anchor, step);
        this.reload();
    }

    reload() {
        const now = new Date();
        const range = periodRange(this._kind, this._anchor);
        this._nextButton.sensitive = range.end < new Date(now.getFullYear(), now.getMonth(), now.getDate());
        this._title.label = this._kind === 'month'
            ? range.start.toLocaleDateString(undefined, {month: 'long', year: 'numeric'})
            : `${range.start.toLocaleDateString(undefined, {day: 'numeric', month: 'short'})} – ${range.end.toLocaleDateString(undefined, {day: 'numeric', month: 'short', year: 'numeric'})}`;

        const s = summarize(this._ctx.history.range(range), range, now);
        this._cards.worked.value.label = formatDuration(s.workedMin);
        this._cards.overtime.value.label = formatSigned(s.overtimeMin);
        this._cards.days.value.label = String(s.days);
        this._cards.avg.value.label = s.avgWorkedMin === null ? '—' : formatDuration(s.avgWorkedMin);
        this._chart.setChart(s.chart);
        this._avgArrival.label = `${clock(s.avgArrival)} · ${clock(s.avgDeparture)}`;
        this._avgBreak.label = s.avgBreakMin === null ? '—' : formatDuration(s.avgBreakMin);
        const rec = (r, fmt) => (r ? `${fmt(r.value)} · ${shortDate(r.date)}` : '—');
        this._earliest.label = rec(s.records.earliestArrival, clock);
        this._latest.label = rec(s.records.latestDeparture, clock);
        this._longest.label = rec(s.records.longestDay, formatDuration);
        this._shortest.label = rec(s.records.shortestDay, formatDuration);
    }
});
````

- [ ] **Step 3: Add the Stats tab to the window**

In `app/window.js`, replace this block (it appears exactly once):

````js
import {HistoryPage} from './pages/history.js';
````

with:

````js
import {HistoryPage} from './pages/history.js';
import {StatsPage} from './pages/stats.js';
````

In `app/window.js`, replace this block (it appears exactly once):

````js
        this._historyPage = new HistoryPage(ctx);
````

with:

````js
        this._historyPage = new HistoryPage(ctx);
        this._statsPage = new StatsPage(ctx);
````

In `app/window.js`, replace this block (it appears exactly once):

````js
        this._stack.add_titled_with_icon(this._historyPage, 'history', 'History', 'x-office-calendar-symbolic');
````

with:

````js
        this._stack.add_titled_with_icon(this._historyPage, 'history', 'History', 'x-office-calendar-symbolic');
        this._stack.add_titled_with_icon(this._statsPage, 'stats', 'Stats', 'tt-stats-symbolic');
````

In `app/window.js`, replace this block (it appears exactly once):

````js
        this._historyPage.reload();
````

with:

````js
        this._historyPage.reload();
        this._statsPage.reload();
````


- [ ] **Step 4: Syntax check and render all pages**

Run:
```bash
for f in app/widgets/barChart.js app/pages/stats.js app/window.js; do cp "$f" /tmp/tt-check.mjs && node --check /tmp/tt-check.mjs && echo "$f ok"; done
```
```bash
rm -rf /tmp/tt-t7 && dev/preview.sh /tmp/tt-t7 2>&1 | grep -E "CRITICAL|JS ERROR|Screenshots"
```
Expected: 3 `… ok` lines and only `Screenshots in /tmp/tt-t7`. `stats.png` shows:
- the Week/Month toggle (Month selected) and "‹ <Month Year> ›"
- 4 gradient cards: Worked (blue), Overtime (green), Days (purple), Avg / day (orange)
- a bar chart with the dashed red 8h line: blue bars, green tops for overtime, orange bars under target, today faded
- the Averages rows (Arrival · departure, Break) and the Records rows (🌅 🌙 🏔 🐣, each with a date)

The tabs now read "Today · History · Stats".

- [ ] **Step 5: Commit**

```bash
git add "app/widgets/barChart.js" "app/pages/stats.js" "app/window.js"
git commit -m "feat: stats page with week/month totals, bar chart, averages and records

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Install, README, and the real-session check

**Files:**
- Modify (replace whole file): `install.sh`, `README.md`
- Create: `app/io.github.fafafa12.TimeTracker.desktop.in`

**Interfaces:**
- **Consumes:** everything above.
- **Produces:** `~/.local/bin/time-tracker`, `~/.local/share/applications/io.github.fafafa12.TimeTracker.desktop`, `~/.local/share/icons/hicolor/scalable/apps/io.github.fafafa12.TimeTracker.svg`, and the extension symlink. All are symlinks or generated files; no GNOME settings change.

- [ ] **Step 1: Create `app/io.github.fafafa12.TimeTracker.desktop.in`**

````ini
[Desktop Entry]
Type=Application
Name=Time Tracker
Comment=Office time, breaks and overtime
Exec=@BIN@
Icon=io.github.fafafa12.TimeTracker
Terminal=false
Categories=Utility;GTK;
Keywords=time;work;office;overtime;break;
StartupNotify=true
````

- [ ] **Step 2: Replace `install.sh`**

````bash
#!/usr/bin/env bash
# Links the extension into GNOME Shell, compiles its settings schema and installs the
# Time Tracker app (launcher command, app-grid entry, icon). Changes no GNOME settings.
set -euo pipefail

UUID="time-tracker@anjrakot"
APP_ID="io.github.fafafa12.TimeTracker"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$ROOT/$UUID"
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"
BIN="$HOME/.local/bin/time-tracker"
APPS="$HOME/.local/share/applications"
ICONS="$HOME/.local/share/icons/hicolor/scalable/apps"

link() { # link <target> <link-path>: refuses to replace a real file
    if [ -e "$2" ] && [ ! -L "$2" ]; then
        echo "error: $2 exists and is not a symlink; remove it first" >&2
        exit 1
    fi
    ln -sfn "$1" "$2"
}

glib-compile-schemas "$SRC/schemas"
mkdir -p "$(dirname "$DEST")" "$(dirname "$BIN")" "$APPS" "$ICONS"
link "$SRC" "$DEST"
link "$ROOT/app/time-tracker" "$BIN"
link "$ROOT/app/icons/hicolor/scalable/apps/$APP_ID.svg" "$ICONS/$APP_ID.svg"
sed "s|@BIN@|$ROOT/app/time-tracker|" "$ROOT/app/$APP_ID.desktop.in" > "$APPS/$APP_ID.desktop"
if command -v update-desktop-database >/dev/null; then
    update-desktop-database -q "$APPS" || true
fi

echo "Linked $DEST -> $SRC"
echo "App: run 'time-tracker' or open 'Time Tracker' from the app grid"
echo "Wayland: after changing extension code, log out and back in, then run: gnome-extensions enable $UUID"
````

- [ ] **Step 3: Replace `README.md`**

````markdown
# Time Tracker (GNOME Shell extension + app)

Counts time at the office from the first computer start of the day, excluding breaks,
shows it in the top bar (`⏱ 5h12`, or `☕ 5h12` during a break) and in the
**Time Tracker** app (Today · History · Stats).

- Arrival = boot time if the computer was started today, otherwise the first time the
  extension runs that day. Saved, so reboots on the same day don't change it.
- Breaks: an optional fixed daily break (12:30–13:30 by default) plus manual breaks —
  **Start break / Finish break** in the top-bar menu or the app, as often as you like.
  An open break survives a reboot; work alerts pause during a break.
- Alerts at 4h, 7h, 7h45 and 8h worked (8h stays on screen), plus fixed-break start/end.
  An alert never repeats; after being away you get only the latest one you missed.
- Overtime = worked − target (the largest alert, 8h by default), shown for today and
  every past day. There is no running balance.
- History: one file per month in `~/.local/share/time_tracker/` (e.g. `2026-09.json`) with
  arrival, departure (last time the computer was on, saved every 5 minutes and at lock,
  logout and shutdown), breaks, and the fixed break and target used that day.
- The app edits past days and adds missing ones (**＋ Add day**); today is changed from the
  Today page (Set arrival…, Reset arrival, breaks). Only the extension writes the files;
  the app sends its changes over D-Bus and shows history read-only when the extension is off.
- Wrong arrival? Use **Set arrival…**, or edit today's `"arrival"` in the month file
  (`"08:05"` or `"08:05:00"`); it is picked up within 5 minutes.
- A month file that is not valid JSON is kept as `<name>.<timestamp>.bak` and a fresh file
  is started; older backups are never overwritten.
- Settings (alerts, fixed break, history folder, test notification):
  `gnome-extensions prefs time-tracker@anjrakot`, the top-bar menu, or the app's ☰ menu.

Requires GNOME Shell 48 and libadwaita 1.7.

## Install

```bash
./install.sh
# Wayland: log out and back in once, then
gnome-extensions enable time-tracker@anjrakot
```

`install.sh` also adds the `time-tracker` command (`~/.local/bin`) and a **Time Tracker**
entry in the app grid. After changing `extension.js` or `lib/*.js`, log out and back in to
reload the extension; the app and the settings window reload each time they are opened.

## Tests

```bash
gjs -m tests/run.js
```

## Previewing the app without the extension

```bash
dev/preview.sh /tmp/tt-preview            # today.png, history.png, stats.png, dialog-add.png
dev/preview.sh /tmp/tt-preview --break    # Today while on a break
dev/preview.sh /tmp/tt-preview --offline  # the "tracker is off" state
```

It runs a fake tracker on a private D-Bus with sample data and renders the app off-screen
(GTK Broadway). It uses in-memory settings and a temporary data folder, so it never touches
your desktop, your settings or your real history.

## Logs

```bash
journalctl --user -f -o cat /usr/bin/gnome-shell | grep time-tracker
```
````

- [ ] **Step 4: Install and verify the files**

Run:
```bash
bash -n install.sh && ./install.sh
ls -l ~/.local/bin/time-tracker ~/.local/share/icons/hicolor/scalable/apps/io.github.fafafa12.TimeTracker.svg
grep -E "^(Exec|Icon)=" ~/.local/share/applications/io.github.fafafa12.TimeTracker.desktop
command -v desktop-file-validate >/dev/null && desktop-file-validate ~/.local/share/applications/io.github.fafafa12.TimeTracker.desktop && echo desktop-ok
gjs -m tests/run.js 2>/dev/null | tail -1
```
Expected:
- the three `Linked`/`App:`/`Wayland:` lines
- two symlinks pointing into the repo
- `Exec=<repo>/app/time-tracker` and `Icon=io.github.fafafa12.TimeTracker`
- `desktop-ok` (if the validator is installed)
- `101/101 passed`

- [ ] **Step 5: Commit**

```bash
git add "app/io.github.fafafa12.TimeTracker.desktop.in" "install.sh" "README.md"
git commit -m "feat: install the Time Tracker app (launcher, app grid entry, icon); README for v2

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 6: Real-session check (the USER does this, after logging out and back in once)**

1. Run `gnome-extensions enable time-tracker@anjrakot` if needed, then `gnome-extensions info time-tracker@anjrakot`. Expected: `State: ACTIVE`.
2. Read-only D-Bus smoke test:
   ```
   gdbus call --session --dest io.github.fafafa12.TimeTrackerService --object-path /io/github/fafafa12/TimeTrackerService --method io.github.fafafa12.TimeTrackerService.GetToday
   ```
   Expected: `('{"date":"…","arrival":"…",…}',)`.
3. Top-bar menu:
   - "☕ Start break" turns the label into `☕ …`, and "Next alert" says "paused".
   - "▶ Finish break (since …)" brings back `⏱`.
   - After the target, the menu shows "Overtime: +…".
4. "Open Time Tracker" opens the app. So do the app grid entry and the `time-tracker` command.
5. In the app:
   - start and finish a break
   - Set arrival… (a time in the future is refused with a toast)
   - Reset arrival asks for confirmation
   - History: edit a past day, then add a missing day (an existing date is refused)
   - Stats: switch between Week and Month
   - confetti plays once the target is reached
6. Turn the extension off, then on again with `gnome-extensions disable/enable`, while the app is open. Expected: the banner appears, then disappears on its own (Review Focus 5).
7. Settings: turning off "Fixed daily break" greys out its fields, and today's worked time then includes the lunch hour.
8. `journalctl --user -b -o cat /usr/bin/gnome-shell | grep time-tracker` prints no errors.

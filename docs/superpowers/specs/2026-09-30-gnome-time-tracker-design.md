# GNOME Time Tracker — Design

Date: 2026-09-30
Status: approved in conversation, pending written-spec review

## Goal

Track time spent at the office from the first computer start of the day, excluding the
lunch break, show it in the GNOME top bar, alert at key milestones, and keep a monthly
history. Must be very light on resources and never destabilise GNOME Shell.

## Decisions

- **Form:** a GNOME Shell extension only (no separate daemon). Target: GNOME Shell 48, ESM
  modules, JavaScript (GJS). UUID `time-tracker@anjrakot`.
- **Counting model:** wall-clock. Worked time counts from arrival regardless of whether the
  computer is on or off, minus the break.
- **Arrival (first run of a day):** the system boot time (`btime` from `/proc/stat`) if the
  boot happened today (local date) and is not in the future; otherwise the current time
  (e.g. woke from overnight suspend, or unlocked after being locked overnight). Once written,
  arrival is never changed automatically for that day.
- **Departure:** the last time the extension was running that day ("last seen"), saved every
  5 minutes and on `disable()` (logout, screen lock). Accuracy is therefore within 5 minutes
  if the machine is powered off abruptly.
- **Break:** default 12:30–13:30 (configurable). Arrival inside the break counts from break end.

## Time rules (pure functions, `lib/timecalc.js`)

All times are local. `bs`/`be` = break start/end on the day of `arrival`.

- `worked(arrival, t) = max(0, (t − arrival) − overlap([arrival, t], [bs, be]))`
- `alertTime(arrival, T)` — the instant when `worked` reaches `T` minutes:
  - `start = arrival` if `arrival < bs` or `arrival ≥ be`; `start = be` if `bs ≤ arrival < be`
  - `t = start + T`; if `start < bs` and `t > bs`, then `t += (be − bs)`
- `remaining(arrival, now) = max(0, lastThreshold − worked(arrival, now))`
- Example: arrival 08:30, threshold 8h → 17:30.

## Alerts

- **Work alerts:** one per configured threshold (default 4:00, 7:00, 7:45, 8:00). ID =
  `w<minutes>` (e.g. `w465`) so editing the list does not confuse already-fired IDs. The last
  (largest) threshold is the "end of day" and uses critical urgency (stays until dismissed).
  Body example: `7h45 done — 15 min left (since 08:30)`.
- **Break alerts** (if enabled): `break-start` at `bs` ("Break time 🍽"), `break-end` at `be`
  ("Back to work"). Each is only scheduled if `arrival` is before its time.
- **Catch-up rule** (evaluated every tick): collect alerts that are due (`time ≤ now`) and not
  yet fired.
  - Work alerts: show only the largest due one; mark all due ones fired.
  - Break alerts: if both are due, only `break-end` is considered. A break alert more than
    10 minutes late is marked fired silently (no stale "Back to work" at 16:00).
- Fired IDs are persisted so no alert repeats after reboot, re-login or unlock.

## Persistence (`lib/store.js`)

Directory: settings key `history-dir`, empty = `~/.local/share/time_tracker/`.

- `YYYY-MM.json` — monthly history, keyed by date:
  ```json
  {"2026-09-30": {"arrival": "09:49:48", "departure": "18:02:10", "workedMin": 432}}
  ```
  Today's entry is created at arrival and updated on each last-seen save.
  `workedMin = worked(arrival, departure)` using the break settings at save time.
- `state.json` — `{"date": "2026-09-30", "fired": ["w240", "break-start"]}`. Replaced when
  the date changes.
- Writes are atomic (`Gio.File.replace_contents`, which writes a temp file then renames).
- Unreadable/invalid JSON: rename to `<name>.bak`, log, start with an empty object.

## Runtime (`lib/tracker.js`, `extension.js`)

- `enable()`: load settings and files, determine today's arrival, create the indicator, run one
  tick immediately, then start `GLib.timeout_add_seconds(PRIORITY_LOW, 60, tick)`.
- `tick()`: if the local date changed since the last tick, start a new day (arrival = now per
  the rule above, fresh `state.json`). Then evaluate alerts, update the label, and every 5th
  tick save last seen. Each tick recomputes from the wall clock, so suspend/resume and lock/unlock
  self-correct on the next tick (≤ 60 s late).
- `disable()`: save last seen, remove the timeout, destroy the indicator and notification source,
  drop all references. Session mode is `user` only (GNOME disables it on the lock screen).
- Settings changes (`changed` signal) trigger an immediate tick.
- Every timer callback and file operation is wrapped in try/catch and logs via `console.error`;
  the tick always returns `GLib.SOURCE_CONTINUE`.

## UI

- **Top bar (`lib/indicator.js`):** `PanelMenu.Button` with label `⏱ 5h12` (updated each tick).
  Menu:
  - Arrival `09:49`
  - Worked `5h12`
  - Remaining `2h48`
  - Next alert `7h at 17:49`
  - separator
  - Reset arrival to now (sets arrival = now, clears today's fired alerts)
  - Open history folder (`Gio.AppInfo.launch_default_for_uri`)
  - Settings (`extension.openPreferences()`)
- **Notifications:** one `MessageTray.Source` titled "Time Tracker", created lazily.
- **Preferences (`prefs.js`, Adw):**
  - Alert thresholds: one `Adw.EntryRow` per threshold (`H:MM`) with a remove button, plus an
    "Add" row. Invalid entries are shown with the `error` style and not saved; the list is
    stored sorted and de-duplicated.
  - Break start / end: entry rows (`HH:MM`), validated, end must be after start.
  - Break alerts: switch.
  - History folder: entry row (empty = default).
  - "Send test notification" button (sets a settings key the extension watches, e.g.
    `test-notification` counter).

## Settings schema

`org.gnome.shell.extensions.time-tracker`:

| Key | Type | Default |
|---|---|---|
| `alert-thresholds` | `as` | `['4:00','7:00','7:45','8:00']` |
| `break-start` | `s` | `'12:30'` |
| `break-end` | `s` | `'13:30'` |
| `break-alerts` | `b` | `true` |
| `history-dir` | `s` | `''` |
| `test-notification` | `u` | `0` |

## Files

```
time-tracker@anjrakot/
  metadata.json
  extension.js
  prefs.js
  lib/timecalc.js     pure time math + alert selection (no gi imports)
  lib/store.js        JSON files, atomic writes, recovery
  lib/tracker.js      day/arrival/last-seen/tick logic
  lib/indicator.js    panel button + menu
  schemas/org.gnome.shell.extensions.time-tracker.gschema.xml
tests/
  run.js              tiny assert harness, `gjs -m tests/run.js`
  timecalc.test.js
install.sh            symlink into ~/.local/share/gnome-shell/extensions, compile schemas
```

## Testing

- Unit (`gjs -m tests/run.js`) for `timecalc.js`:
  - `worked` for arrival before / inside / after the break, `t` before / inside / after the break
  - `alertTime` for the same cases, including the 08:30 → 17:30 example
  - alert selection: nothing due, one due, several missed (only the largest shown), stale
    break alert suppressed, break alerts skipped when arrival is after them
  - arrival rule: boot today → boot time; boot yesterday → now
- Manual:
  - install and enable, then check today's arrival shows 09:49:48 (from `uptime -s`)
  - "Send test notification" shows a popup
  - `2026-09.json` and `state.json` appear
  - `journalctl --user -f /usr/bin/gnome-shell` is clean
  - lock/unlock keeps the arrival

## Known limitations

- If the machine stays on and unlocked through midnight, the next day's arrival is 00:00.
- Departure can be up to 5 minutes early after an abrupt power-off.
- Break settings apply to the day being computed; history entries already written keep their
  stored `workedMin`.

## Out of scope

Charts, weekly/monthly totals in the UI, export, publishing to extensions.gnome.org,
support for GNOME versions other than 48.

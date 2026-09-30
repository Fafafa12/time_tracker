# Time Tracker: how it works

Time Tracker counts the time you spend at the office. It starts from the first time the computer is switched on each day, leaves out breaks, and gives you alerts, a monthly history and statistics.

It has two parts:

| Part | Where | Runs |
|---|---|---|
| **Extension** (`time-tracker@anjrakot/`) | inside GNOME Shell 48 | always, while you are logged in |
| **App** (`app/`, GTK 4 + libadwaita 1.7) | its own window | only while the window is open |

For install and everyday use, see the [README](../README.md).

---

## Architecture

```
            GNOME Shell (extension)                       Time Tracker app
 ┌──────────────────────────────────────────┐       ┌────────────────────────────┐
 │ extension.js  60 s tick, settings, alerts │       │ window: Today · History ·  │
 │   ├─ Tracker (lib/tracker.js)  today     │ D-Bus │         Stats               │
 │   ├─ TrackerService (lib/dbus.js) ◄──────┼───────┤ client.js (actions, today) │
 │   ├─ TrackerIndicator (top bar)          │Changed│                            │
 │   └─ Store (lib/store.js) ── writes ──┐  ├──────►│ data.js ── reads only ──┐  │
 └───────────────────────────────────────┼──┘       └─────────────────────────┼──┘
                                         ▼                                     ▼
                         ~/.local/share/time_tracker/  YYYY-MM.json, state.json
```

- **The extension is the only program that writes the data files.** The app reads the month files through a read-only `Store`, and sends every change (breaks, arrival, editing past days) to the extension over D-Bus. Because only one program writes, an edit can never be lost when both save at the same moment.
- **The logic has no GNOME dependencies.** These modules import nothing from `gi://` and are unit-tested with plain `gjs -m`:
  - `lib/timecalc.js`
  - `lib/day.js`
  - `lib/stats.js`
  - `lib/tracker.js`

  The GNOME-specific files (`extension.js`, `lib/indicator.js`, `lib/store.js`, `lib/dbus.js`, `prefs.js`, `app/`) only connect that logic to GNOME.
- **It is very light.** The extension adds one timer (every 60 s, low priority) and no extra process. It writes about 2 KB every 5 minutes. The app uses nothing while its window is closed.
- **Nothing it does can crash GNOME Shell.** Every timer, signal handler and D-Bus call is wrapped in `try/catch` and logs `[time-tracker] …`. Failed saves are logged, and alerts are still delivered.

---

## Time rules

### Arrival

- On the first run of a day, the arrival is the **boot time** (`btime` in `/proc/stat`), provided the computer was started today and not in the future. Otherwise the arrival is the current time, for example after waking from an overnight suspend or unlocking after an overnight lock.
- The arrival is saved in the month file, so reboots on the same day do not change it.
- Ways to change today's arrival:
  - **Set arrival…** (today, `H:MM`, not in the future)
  - **Reset arrival to now**
  - editing `"arrival"` in the month file by hand, which the extension picks up within 5 minutes

  Setting or resetting the arrival clears today's sent alerts.

### Breaks and worked time

- **Fixed break:** an optional daily break (setting `fixed-break`, 12:30–13:30 by default).
- **Manual breaks:** **Start break** and **Finish break**, as often as you like. A break that is still running is stored as `openBreak`, so it survives a reboot.
- **Worked time** = time since arrival minus all breaks merged together. Overlapping breaks are counted once, and a running break counts up to now. Worked time is always rounded down to whole minutes, and is never negative (for example when the clock is set back).
- **Target** = the largest alert threshold (8h by default). **Overtime** = worked − target, which is negative before the target is reached. There is no running balance across days.

### Alerts

- **Work alerts** go off at each threshold (default 4:00, 7:00, 7:45, 8:00), with the ids `w240`, `w420`, … The last one stays on screen until you dismiss it.
- **Break alerts** (`break-start`, `break-end`) exist only for the fixed break, when `break-alerts` is on, and only if you arrived before that time. Manual breaks send no alerts.
- **During a break**, work alerts are *paused* and "Leave at" is unknown. When the break finishes, they move later by the length of the break.
- **Catch-up after a shutdown, lock or suspend:**
  - Of the missed work alerts, only the largest is shown.
  - A break alert more than 10 minutes late is dropped silently.
  - All the others are marked as sent.
- Sent alert ids are stored in `state.json`, so no alert ever repeats after a reboot, a lock or a settings change. A threshold added during the day that has already passed fires once.

### Departure and the end of the day

- **Departure** = the last time the extension was running that day. It is saved:
  - on the first tick of a day
  - every 5 ticks after that
  - on `disable()` (screen lock, turning the extension off)
  - on GNOME Shell's `shutdown` signal (logout, power off)

  So after a sudden power loss, the departure can be up to 5 minutes early.
- **When the date changes**, the previous day is closed at its last tick, and any break still running is finished there.
- **Changing settings** applies to today straight away. Past days keep the target and fixed break they were saved with.

---

## Data files

Default folder: `~/.local/share/time_tracker/` (setting `history-dir`; `~` is expanded).

### `YYYY-MM.json`: one entry per day

```json
{
  "2026-09-30": {
    "arrival": "09:49:48",
    "departure": "18:02:10",
    "breaks": [["15:10:00", "15:25:00"]],
    "openBreak": null,
    "fixedBreak": ["12:30", "13:30"],
    "targetMin": 480,
    "workedMin": 492,
    "overtimeMin": 12
  }
}
```

| Field | Meaning |
|---|---|
| `arrival`, `departure` | `HH:MM:SS`. Hand-edited values may also use `H:MM` |
| `breaks` | finished manual breaks |
| `openBreak` | start of a break still running, or `null` |
| `fixedBreak` | the fixed break used that day, or `null` if it was off |
| `targetMin` | the target used that day |
| `workedMin`, `overtimeMin` | recomputed on every save |

Entries from the first version, which have no `breaks`, `fixedBreak` or `targetMin`, are read as: no manual breaks, fixed break 12:30–13:30, and an 8h target. They gain the new fields the next time they are saved.

### `state.json`

```json
{"date": "2026-09-30", "fired": ["w240", "break-start"]}
```

The file is replaced when the date changes.

### How the files are kept safe

- Every write is atomic: the data is written to a temporary file, which is then renamed over the old one.
- If a file is not valid JSON, the extension moves it to `<name>.<timestamp>.bak` (never overwriting an older backup) and starts a fresh file.
- If a file cannot be read for another reason (permissions, input/output error), it is left alone and the error is logged.
- The app never moves or writes any file.

---

## Settings

Schema `org.gnome.shell.extensions.time-tracker`, edited in the settings window (`prefs.js`):

| Key | Type | Default | Meaning |
|---|---|---|---|
| `alert-thresholds` | `as` | `['4:00','7:00','7:45','8:00']` | work alerts (`H:MM`); the largest is the target |
| `fixed-break` | `b` | `true` | daily fixed break on or off |
| `break-start` / `break-end` | `s` | `'12:30'` / `'13:30'` | fixed break; an invalid pair falls back to the defaults |
| `break-alerts` | `b` | `true` | notify at fixed-break start and end |
| `history-dir` | `s` | `''` | data folder (empty = default). Changing it moves today's state to the new folder |
| `test-notification` | `u` | `0` | the settings window increments it to send a test popup |

The settings window saves nothing while an alert row holds an invalid time, and a fixed break is only saved when its end is after its start.

---

## D-Bus interface

The extension owns a name on the session bus (so only your own user can reach it):

- **Name:** `io.github.fafafa12.TimeTrackerService`
- **Object path:** `/io/github/fafafa12/TimeTrackerService`
- **Interface:** `io.github.fafafa12.TimeTrackerService`

The name is different from the app id `io.github.fafafa12.TimeTracker`, because GTK already registers the app id on the bus.

| Method | Arguments | Does |
|---|---|---|
| `GetToday` | → `s` JSON | today: `date`, `arrival`, `workedMin`, `targetMin`, `overtimeMin`, `remainingMin`, `onBreak`, `openBreak`, `breaks`, `fixedBreak`, `next` (`{label, time}`, `{label, paused}` or `null`), `leaveAt` |
| `StartBreak` / `FinishBreak` | — | start or finish a manual break |
| `SetArrival` | `s` `"H:MM"` | today's arrival |
| `ResetArrival` | — | arrival = now |
| `SaveDay` | `s` date, `s` JSON `{arrival, departure, breaks, fixedBreak}` | edit or add a **past** day |
| `DeleteDay` | `s` date | remove a **past** day |

- The **`Changed(s date)`** signal is sent every 60 s and after every successful action.
- **Errors:**
  - A refused action (wrong state, invalid input, today or a future date) returns `org.freedesktop.DBus.Error.InvalidArgs` with a readable message.
  - Any other failure returns `org.freedesktop.DBus.Error.Failed` and is logged.

Try it from a terminal:

```bash
gdbus call --session --dest io.github.fafafa12.TimeTrackerService \
  --object-path /io/github/fafafa12/TimeTrackerService \
  --method io.github.fafafa12.TimeTrackerService.GetToday
```

---

## The app

- **Today:** a hero card that is blue while working, orange during a break and green once the target is reached. It contains:
  - a ring showing worked time against the target, with "Arrived HH:MM" and the time left or overtime
  - a timeline of the day
  - the breaks, the next alert and "Leave at"
  - the buttons ☕ Start / ▶ Finish break, Set arrival… and Reset arrival (which asks for confirmation)

  A confetti burst plays when the target is reached.
- **History:** one month at a time, with the number of days, total worked time and total overtime for the month.
  - One row per day, newest first, each with a mini progress bar and a ± pill. Clicking a past day opens the day dialog; clicking today opens the Today page.
  - **＋ Add day** opens the same dialog for a missing day. A date that already exists is refused.
  - The day dialog checks every field as you type (arrival before departure, breaks inside the day, no future dates or today). Save stays disabled until the day is valid, and **Delete day** asks for confirmation.
- **Stats:** a week (Monday to Sunday) or a month, with totals, averages, records and a bar chart.
  - The bar chart is blue up to the target and green for overtime, with orange bars for days under the target and a dashed target line.
  - Today appears only in the chart, faded, and is left out of totals, averages and records until the day is over.
- **Updates:** the app reloads on every `Changed` signal. Only today's numbers change each minute: the History list and the chart are rebuilt, and animate, only when past days or the period change.
- **When the extension is off**, the banner "The tracker is off — view only" appears and Today shows a status page. History and Stats still work, and saving is disabled. When the extension comes back, the window recovers by itself.
- **Animations** use libadwaita, so they are skipped when animations are turned off in GNOME.

---

## Code map

```
time-tracker@anjrakot/
  extension.js        enable/disable, 60 s tick, settings, notifications, D-Bus export, open app
  prefs.js            settings window
  lib/timecalc.js     parse/format, break intervals, worked time, alert times, catch-up rule
  lib/day.js          day entry ⇄ Day, recalculation, validation, dialog input
  lib/stats.js        periods, totals, averages, records, chart data
  lib/tracker.js      today's state and actions, last seen, day rollover, past-day edits
  lib/store.js        JSON files (atomic, .bak recovery, read-only mode), boot time
  lib/dbus-api.js     bus name, path, interface XML, error names
  lib/dbus.js         TrackerService (thin wrappers over Tracker)
  lib/indicator.js    top-bar button and menu
  schemas/            GSettings schema
app/
  main.js, window.js  application and window (tabs, banner, toasts, confetti)
  client.js, data.js  D-Bus client; read-only history and settings
  signatures.js       "did the data really change?" keys for the minute refresh
  pages/              today.js, history.js, stats.js
  dayDialog.js        edit / add a day
  widgets/            ring, timeline, bar chart, confetti (Cairo), animation helper
  style.css, icons/, time-tracker (launcher), *.desktop.in
dev/                  fake-service.js, preview.sh
tests/                gjs unit tests (run.js, harness.js, *.test.js)
install.sh            links the extension, app launcher, desktop entry and icon
```

---

## Development

- **Tests:** run `gjs -m tests/run.js`. It covers the time maths, day model, stats, tracker, store, D-Bus handlers and app signatures.
- **Preview the app without GNOME Shell:** run `dev/preview.sh <out-dir> [--break|--offline]`. It starts a fake tracker on a private D-Bus with sample data and renders every page to PNG through GTK Broadway, bound to 127.0.0.1. Settings are kept in memory and the data folder is temporary, so nothing on the desktop changes. You can choose which pages and dialogs to render with `PAGES="today history"` and `DIALOGS=add` (empty for none).
- **Reloading:** after changing `extension.js` or `lib/*.js`, log out and back in (on Wayland, GNOME Shell only loads extensions at login). The app and the settings window load fresh each time they are opened.
- **Logs:** `journalctl --user -f -o cat /usr/bin/gnome-shell | grep time-tracker`
- **Never** write GNOME settings (`gsettings set`, `dconf`, `gnome-extensions enable/disable`) from a test run, and never start a headless or nested `gnome-shell` for testing. Their settings go to your real configuration, and this once turned off every other extension. Use `dev/preview.sh` instead.

---

## Known limitations and follow-ups

- If the computer stays on **and unlocked** through midnight, the next day's arrival is 00:00. Locking or suspending at night avoids this.
- Departure can be up to 5 minutes early after a sudden power loss.
- Time while the screen is locked counts as work, and the extension (and its D-Bus name) is off during the lock.
- Old v1 days always count the fixed break as 12:30–13:30.
- Small follow-ups:
  - `SaveDay` with malformed JSON returns `Failed` instead of `InvalidArgs`.
  - The add-day duplicate check lives only in the dialog, not in the extension.
  - When the extension is off, past days can still be opened for editing and "Delete day" stays enabled. The error message is raw D-Bus text.
  - The add-day preview assumes an 8h target and 12:30–13:30 instead of reading the settings.
  - The confetti replays each time the window is reopened after the target.
  - A brief `GetToday` failure shows the "tracker is off" page without the banner.
  - The desktop file's `Exec` path is not quoted, so it breaks for a checkout path containing spaces.
  - History rows fade in but do not slide in.

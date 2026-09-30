# Time Tracker v2: breaks, overtime and the Time Tracker window

Date: 2026-09-30
Status: approved in conversation, pending written-spec review
Builds on: `2026-09-30-gnome-time-tracker-design.md` (v1). Everything there still holds unless changed here.

## Goal

1. Show **overtime** (worked − target) for today and for every past day. There is no running balance.
2. **Breaks:** the fixed daily break can be switched off, and manual breaks can be started and finished at any time.
3. A real **Time Tracker window** with three pages:
   - **Today:** live view plus actions
   - **History:** editable, including adding a day
   - **Stats:** totals, averages, a bar chart and records, per week and per month

   The look is polished and animated.

## Decisions

- The window is a **separate GJS + libadwaita app** (`app/`). It runs only while open, never inside GNOME Shell.
- The **extension is the only writer** of the data files. The app reads the month files directly and sends every change over **D-Bus** to the extension.
- Navigation uses **tabs in the header bar** (`Adw.ViewSwitcher`, with `Adw.ViewSwitcherBar` on narrow windows).
- **Today's row in History is not editable.** Clicking it opens the Today page, which is live.
- **Overtime target:** the largest alert threshold (8h by default), copied into each day.

## Data model

Month file entry (`YYYY-MM.json`, keyed by `YYYY-MM-DD`):

```json
{
  "arrival": "09:49:48",
  "departure": "18:02:10",
  "breaks": [["15:10:00", "15:25:00"]],
  "openBreak": null,
  "fixedBreak": ["12:30", "13:30"],
  "targetMin": 480,
  "workedMin": 492,
  "overtimeMin": 12
}
```

- `breaks`: manual breaks that are finished, as `HH:MM:SS` pairs.
- `openBreak`: the start time of the break in progress (today only), or `null`. It survives reboots.
- `fixedBreak`: a copy of the fixed break used for that day (`["HH:MM","HH:MM"]`), or `null` if it was off.
- `targetMin`: a copy of the target used for that day.
- `workedMin` and `overtimeMin` are derived values, recomputed on every save.
- **Today follows the current settings:** `fixedBreak` and `targetMin` are re-copied on every save. Once the day is over, its copy is frozen.
- **Old v1 entries:** a missing `breaks` field reads as `[]`, a missing `openBreak` as `null`, a missing `fixedBreak` as `["12:30","13:30"]`, and a missing `targetMin` as `480`. Missing values are only filled in when that day is next saved.
- **Day closed with a break still open** (day rollover, or `stop()` on a later date): the break is finished at the departure time.
- `state.json` is unchanged.

## Time rules (`lib/timecalc.js`)

- **Break intervals of a day:**
  - the fixed break (if not `null`)
  - the manual breaks
  - the open break, as `[openBreak, +∞)`

  They are merged, so overlaps count once.
- `workedMinutes(arrival, t, intervals)`: `(t − arrival)` minus the part of the merged intervals that falls within `[arrival, t]`, rounded down to whole minutes, and never below 0.
- `alertTime(arrival, minutes, intervals)`: the earliest `t` at which worked time reaches `minutes`. Returns `null` when that point falls after the start of an open break ("paused").
- **Alerts:**
  - Work alerts are unchanged, except that a paused alert (`time === null`) is never due.
  - `break-start` and `break-end` alerts exist only while the fixed break is on (and `break-alerts` is on).
  - Manual breaks send no alerts.
- `leaveAt`: the `alertTime` of the target, or `null` while on a break.
- `overtimeMin = workedMin − targetMin`, which can be negative.
- **Config shape:** `{thresholds, fixedBreak: {start, end} | null, breakAlerts}`. This replaces v1's `breakStart` and `breakEnd`. An invalid fixed break falls back to 12:30–13:30, as before.

## Day logic (`lib/day.js`, pure, shared by the extension and the app)

- `readDay(dateKey, entry)` turns a JSON entry into a Day with Dates, applying the defaults for old v1 entries.
- `computeDay(day, until)` returns `{workedMin, overtimeMin, breakMin}`.
- `validateDay(input, dateKey, now)` returns a list of `{field, message}` errors; an empty list means valid.
  - Times must be `H:MM` or `HH:MM`.
  - `arrival < departure`.
  - Each break has `start < end` and lies within `[arrival, departure]`.
  - The date must not be in the future, and must not be today (today is edited on the Today page).
  - When adding a day (`{adding: true, exists}`), a date that already has an entry is refused ("This day already exists: edit it in the list"), so "＋ Add day" never overwrites a day.
- `writeDay(day)` turns a Day back into a JSON entry, with the derived fields recomputed.

## Tracker additions (`lib/tracker.js`)

The in-memory state for today gains `breaks` and `openBreak`, restored in `_ensureDay`. New actions, each saving right away:

- `startBreak()`: throws `"Already on a break"` if a break is open.
- `finishBreak()`: throws `"No break in progress"` if none is open. It moves `[openBreak, now]` into `breaks`.
- `setArrival("HH:MM")`: must be today and `≤ now`. It sets the arrival and clears today's sent alerts. The catch-up rule then shows only the latest threshold already passed, and any open break is kept.
- `resetArrival()`: unchanged.
- `saveDay(dateKey, input)`: validates with `validateDay` and throws the messages if invalid; otherwise writes the entry. Past days only; this also covers "Add day".
- `deleteDay(dateKey)`: past days only. It removes the entry.
- `today()`: the data behind `GetToday` (see below).

## D-Bus interface (`lib/dbus.js`, exported by the extension)

- It owns the bus name `io.github.fafafa12.TimeTrackerService` on the session bus, at object path `/io/github/fafafa12/TimeTrackerService`, with interface `io.github.fafafa12.TimeTrackerService`. (Amended while planning: the app's own id `io.github.fafafa12.TimeTracker` is already registered on the session bus by GTK, so the service needs a different name.)
- The name is released and the object is unexported in `disable()`.

```xml
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
</node>
```

- `GetToday` returns JSON:
  - `date`, `arrival`
  - `workedMin`, `targetMin`, `overtimeMin`, `remainingMin`
  - `onBreak`, `openBreak`, `breaks`, `fixedBreak`
  - `next`: `{label, time}`, or `null`, or `{label, paused: true}` while on a break
  - `leaveAt`
- `SaveDay`'s `day` argument is JSON: `{arrival, departure, breaks, fixedBreak}` in `HH:MM` form.
- A validation or action error returns the D-Bus error `org.freedesktop.DBus.Error.InvalidArgs` with a readable message. Any other failure is logged and returns `org.freedesktop.DBus.Error.Failed`.
- `Changed(date)` is emitted after every successful action and on every 60-second tick (with today's date).

## Extension changes

- **Top-bar menu:**
  - a new item **Start break** / **Finish break**, whose label follows the break state
  - a new item **Open Time Tracker**, which launches the app's desktop file (`Gio.DesktopAppInfo`)
  - a **Remaining** line before the target, replaced by an **Overtime +0h25** line after it
- **Label:** `⏱ 5h12`, or `☕ 5h12` during a break.
- **New setting** `fixed-break` (`b`, default `true`). In the settings window it's a switch in the Break group, and "Break alerts" is only active while it's on.

## The app (`app/`)

- **App setup:**
  - `Adw.Application`, id `io.github.fafafa12.TimeTracker`, single instance (a second launch presents the existing window)
  - entry point `app/main.js`
  - libadwaita 1.7 / GTK 4, with styles in `app/style.css`
- **Window:**
  - `Adw.ApplicationWindow` with a header bar holding the view switcher and a ☰ menu (Settings, which opens the extension's settings window; About)
  - `Adw.ToastOverlay` for short error messages
  - `Adw.Banner` saying "The tracker is off, view only" when the bus name has no owner. All edit actions are disabled while it shows.
- **Client (`app/client.js`):** a D-Bus proxy that watches the name owner (online/offline) and re-reads today's data on `Changed`. History and Stats re-read the month files on `Changed` for dates they show.
- **Today page:**
  - **Hero card:**
    - the ring (worked/target)
    - "Arrived HH:MM"
    - "Xh left", or "+Xh overtime"
    - a break chip with a pulsing dot while a break is open

    The card color is blue while working, orange during a break, and green once the target is reached.
  - **Timeline** of the day from 07:00 to 20:00 (widened to include arrival and now): worked time as a bar, breaks striped, a "now" marker.
  - **Rows:** Breaks, Next alert (or "paused"), Leave at.
  - **Buttons:**
    - the main button is **☕ Start break** or **▶ Finish break**
    - **✎ Set arrival…** opens a small time-entry dialog
    - **↺ Reset arrival** asks for confirmation first
- **History page:**
  - month navigation ‹ ›
  - summary chips for the month: days, worked, overtime
  - one row per day, newest first, each with day/weekday, arrival → departure, worked, a mini progress bar (green when over target) and a ± pill
  - today's row is highlighted
  - a **＋ Add day** button
- **Day dialog** (`Adw.Dialog`), for editing a past day or adding one:
  - fields: date (add only), arrival, departure, fixed break on/off with its times, a list of breaks with ✕ and "＋ Add break"
  - worked time and overtime are recomputed live
  - errors from `validateDay` are shown on the fields they concern, and Save stays disabled until the day is valid
  - **Delete day** asks for confirmation first
- **Stats page:**
  - a Week/Month toggle and ‹ › navigation. A week runs Monday to Sunday and may span two month files.
  - 4 colored cards: Worked, Overtime (sum of the daily ±), Days, Avg/day
  - bar chart: one bar per day, the target part blue, the overtime part green, under-target days orange, a dashed target line, and today faded
  - Averages: arrival, departure, break
  - Records, each with its date: 🌅 earliest arrival, 🌙 latest departure, 🏔 longest day, 🐣 shortest day
  - **Today is left out** of totals, averages and records until the day is over. It appears only in the chart, faded.
- **Stats code (`lib/stats.js`, pure):** `summarize(days, today)` returns `{days, workedMin, overtimeMin, avgWorkedMin, avgArrival, avgDeparture, avgBreakMin, records, chart}`, and `periodRange(kind, anchorDate)` returns the first and last date of a period.
- **Animations:**
  - the ring and the bars grow in when a page opens or a value changes (`Adw.TimedAnimation`)
  - card color changes use CSS transitions
  - history rows slide in
  - a **confetti** burst of about 2.5 s plays when the target is crossed while the window is open, and the first time the window opens after the target that day
  - libadwaita turns animations off automatically when GNOME's animations are off
- **Drawing:** the ring, timeline, bar chart and confetti are drawn with `Gtk.DrawingArea` and Cairo (`app/widgets/*.js`).
- **Install:** `install.sh` also creates `~/.local/bin/time-tracker`, a symlink to `app/time-tracker`, which is a `gjs -m` launcher script. It also creates `~/.local/share/applications/io.github.fafafa12.TimeTracker.desktop`, using the icon `preferences-system-time-symbolic`.

## Resource use

- The extension adds one D-Bus object and one signal per minute. There are no new timers.
- The app does nothing while closed. While open, it redraws only on `Changed` and during animations.

## Testing

`gjs -m` unit tests cover:
- **Time maths:** merging intervals, worked time with fixed, manual and open breaks, alert times shifted and paused, and `leaveAt`.
- **`lib/day.js`:**
  - defaults for old v1 entries
  - validation errors for each rule
  - recalculation
  - a break still open being closed at departure
- **`lib/stats.js`:**
  - totals, averages and records
  - today left out
  - a week spanning two months
  - empty periods
- **Tracker:**
  - start/finish break, including errors
  - an open break surviving a restart
  - alerts paused during a break and shifted after it
  - `setArrival`
  - `saveDay`/`deleteDay` (past days only, validation)
  - day rollover with an open break
- **D-Bus:** the method handlers are thin, with their logic in `Tracker`. They are checked by a real-session smoke test with `gdbus call` against the running extension (read-only calls first).

The app UI is checked by hand in the real session, and before that with `dev/preview.sh`. This dev tool runs the tracker and D-Bus service outside GNOME Shell on a private bus, with sample data, in-memory settings and a temporary data folder. It renders the app's pages to PNG through GTK Broadway (bound to 127.0.0.1), so nothing appears on the desktop and no real settings or history are touched. There are no headless gnome-shell runs, because they write the real dconf.

## Build stages (each one usable on its own)

1. The time maths and tracker for breaks and overtime, `fixed-break`, and the top-bar menu and label changes.
2. The D-Bus interface.
3. The app: window and Today page.
4. History with the day dialog and "＋ Add day".
5. Stats and the animations/confetti.

## Out of scope

A running overtime balance, per-weekday targets, CSV export, phone notifications, translations, and editing today from the History page.

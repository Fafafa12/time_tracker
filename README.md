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

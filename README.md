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

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

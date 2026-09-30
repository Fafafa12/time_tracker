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
        const {show, markFired} = selectDue(buildAlerts(this._arrival, cfg), this._fired, now);
        const messages = show.map(alert => this._message(alert, now, cfg));
        if (markFired.length) {
            this._fired.push(...markFired);
            this._trySave('state', () => this._saveState());
        }
        if (this._ticks++ % SAVE_EVERY_TICKS === 0)
            this._trySave('history', () => this._saveLastSeen(now));
        return messages;
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
        this._trySave('state', () => this._saveState());
        this._trySave('history', () => this._saveLastSeen(now, {adopt: false}));
    }

    /** Called from disable() and on session shutdown: record departure. */
    stop() {
        if (this._day === null)
            return;
        const now = this._now();
        this._trySave('history', () => this._saveLastSeen(dateKey(now) === this._day ? now : this._lastTick));
    }

    /** History folder changed: close today in the old store, carry arrival and fired alerts into the new one. */
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
            this._trySave('history', () => this._saveLastSeen(this._lastTick)); // close the previous day
        this._day = key;
        this._ticks = 0;

        // Read everything first so a failing write cannot leave the day half-loaded.
        const month = this._store.loadMonth(monthKey(now));
        const state = this._store.loadState();
        const saved = month[key] && parseClock(now, month[key].arrival);
        this._arrival = saved || wholeSeconds(chooseArrival(now, this._bootTime()));
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

    _entry(departure) {
        const end = departure < this._arrival ? this._arrival : departure;
        return {
            arrival: formatClockSec(this._arrival),
            departure: formatClockSec(end),
            workedMin: workedMinutes(this._arrival, end, this._config()),
        };
    }

    /**
     * Rewrite today's entry. With `adopt`, an arrival hand-edited in the file since
     * our last write wins over the one in memory.
     */
    _saveLastSeen(t, {adopt = true} = {}) {
        const month = monthKey(this._arrival);
        const data = this._store.loadMonth(month);
        const onDisk = data[this._day]?.arrival;
        if (adopt && onDisk !== undefined && onDisk !== this._writtenArrival) {
            const edited = parseClock(this._arrival, onDisk);
            if (edited)
                this._arrival = edited;
        }
        data[this._day] = this._entry(t);
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

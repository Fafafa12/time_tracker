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

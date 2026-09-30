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

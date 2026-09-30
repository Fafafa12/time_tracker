// Pure time maths for the tracker. No gi:// imports so it runs under plain `gjs -m`.
// All Dates are local time; durations are whole minutes.

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

function atMinutes(day, minutes) {
    return new Date(day.getFullYear(), day.getMonth(), day.getDate(),
        Math.floor(minutes / 60), minutes % 60);
}

/** Break start/end as Dates on the day of `arrival`. */
export function breakWindow(arrival, cfg) {
    return {bs: atMinutes(arrival, cfg.breakStart), be: atMinutes(arrival, cfg.breakEnd)};
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

/** Raw settings values -> validated config. Invalid break falls back to 12:30-13:30. */
export function configFrom({thresholds, breakStart, breakEnd, breakAlerts}) {
    let bs = parseHM(breakStart);
    let be = parseHM(breakEnd);
    if (bs === null || be === null || be <= bs) {
        bs = DEFAULT_BREAK_START;
        be = DEFAULT_BREAK_END;
    }
    return {
        thresholds: parseThresholds(thresholds),
        breakStart: bs,
        breakEnd: be,
        breakAlerts: Boolean(breakAlerts),
    };
}

/** Whole minutes worked between `arrival` and `t`, excluding the break. */
export function workedMinutes(arrival, t, cfg) {
    if (t <= arrival)
        return 0;
    const {bs, be} = breakWindow(arrival, cfg);
    const overlap = Math.max(0, Math.min(t, be) - Math.max(arrival, bs));
    return Math.floor((t - arrival - overlap) / MINUTE_MS);
}

/** The instant at which workedMinutes reaches `minutes`. */
export function alertTime(arrival, minutes, cfg) {
    const {bs, be} = breakWindow(arrival, cfg);
    const start = arrival >= bs && arrival < be ? be : arrival;
    let t = start.getTime() + minutes * MINUTE_MS;
    if (start < bs && t > bs.getTime())
        t += be - bs;
    return new Date(t);
}

/** Minutes left until the largest threshold (0 when there are none). */
export function remainingMinutes(arrival, now, cfg) {
    const last = cfg.thresholds.length ? cfg.thresholds[cfg.thresholds.length - 1] : 0;
    return Math.max(0, last - workedMinutes(arrival, now, cfg));
}

/**
 * All alerts for a day, as {id, kind: 'work'|'break', time, minutes?, final?}.
 * Break alerts are only included when enabled and when arrival is before them.
 */
export function buildAlerts(arrival, cfg) {
    const last = cfg.thresholds[cfg.thresholds.length - 1];
    const alerts = cfg.thresholds.map(minutes => ({
        id: `w${minutes}`,
        kind: 'work',
        minutes,
        final: minutes === last,
        time: alertTime(arrival, minutes, cfg),
    }));
    if (cfg.breakAlerts) {
        const {bs, be} = breakWindow(arrival, cfg);
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
    const due = alerts.filter(a => a.time <= now && !fired.includes(a.id));
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

/** The earliest alert still to come, or null. */
export function nextAlert(alerts, fired, now) {
    const upcoming = alerts.filter(a => a.time > now && !fired.includes(a.id));
    return upcoming.reduce((a, b) => (a === null || b.time < a.time ? b : a), null);
}

/** Arrival rule: boot time when the machine was started today, otherwise now. */
export function chooseArrival(now, bootTime) {
    if (bootTime && dateKey(bootTime) === dateKey(now) && bootTime <= now)
        return bootTime;
    return now;
}

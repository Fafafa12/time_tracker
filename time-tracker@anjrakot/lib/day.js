// One day of history: JSON entry <-> Day, recalculation and validation.
// Pure (no gi:// imports): shared by the extension and the app.
//
// Day = {date: "YYYY-MM-DD", arrival: Date, departure: Date|null,
//        breaks: [[Date, Date]], openBreak: Date|null,
//        fixedBreak: {start, end}|null (minutes), targetMin: number}
import {
    DEFAULT_BREAK_END, DEFAULT_BREAK_START, atMinutes, breakIntervals, breakMinutes,
    dateFromKey, dateKey, formatClockSec, formatHM, parseClock, parseHM, workedMinutes,
} from './timecalc.js';

export const DEFAULT_TARGET_MIN = 480;
const DEFAULT_FIXED = {start: DEFAULT_BREAK_START, end: DEFAULT_BREAK_END};

function readFixed(value) {
    if (value === null)
        return null;
    if (!Array.isArray(value))
        return {...DEFAULT_FIXED}; // v1 entry: the default fixed break applied
    const start = parseHM(value[0]);
    const end = parseHM(value[1]);
    return start !== null && end !== null && end > start ? {start, end} : {...DEFAULT_FIXED};
}

/** JSON entry -> Day, filling v1 defaults. Null when the arrival is missing or invalid. */
export function readDay(key, entry) {
    const day = dateFromKey(key);
    const arrival = day && entry && parseClock(day, entry.arrival);
    if (!arrival)
        return null;
    const breaks = (Array.isArray(entry.breaks) ? entry.breaks : [])
        .map(pair => (Array.isArray(pair) ? [parseClock(day, pair[0]), parseClock(day, pair[1])] : []))
        .filter(([s, e]) => s && e && e > s);
    return {
        date: key,
        arrival,
        departure: parseClock(day, entry.departure),
        breaks,
        openBreak: entry.openBreak ? parseClock(day, entry.openBreak) : null,
        fixedBreak: readFixed(entry.fixedBreak),
        targetMin: Number.isInteger(entry.targetMin) && entry.targetMin >= 0 ? entry.targetMin : DEFAULT_TARGET_MIN,
    };
}

/** The day's merged break intervals. */
export function intervalsOf(day) {
    return breakIntervals(day.arrival, day);
}

/** Worked, overtime and break minutes from arrival until `until` (default: departure). */
export function computeDay(day, until = day.departure ?? day.arrival) {
    const intervals = intervalsOf(day);
    const workedMin = workedMinutes(day.arrival, until, intervals);
    return {
        workedMin,
        overtimeMin: workedMin - day.targetMin,
        breakMin: breakMinutes(day.arrival, until, intervals),
    };
}

/** A copy of the day ended at `departure`; an open break is finished there. */
export function closeDay(day, departure) {
    const breaks = [...day.breaks];
    if (day.openBreak && day.openBreak < departure)
        breaks.push([day.openBreak, departure]);
    return {...day, departure, breaks, openBreak: null};
}

/** Day -> JSON entry, with workedMin and overtimeMin recomputed. */
export function writeDay(day) {
    const departure = day.departure && day.departure > day.arrival ? day.departure : day.arrival;
    const {workedMin, overtimeMin} = computeDay(day, departure);
    return {
        arrival: formatClockSec(day.arrival),
        departure: formatClockSec(departure),
        breaks: day.breaks.map(([s, e]) => [formatClockSec(s), formatClockSec(e)]),
        openBreak: day.openBreak ? formatClockSec(day.openBreak) : null,
        fixedBreak: day.fixedBreak ? [formatHM(day.fixedBreak.start), formatHM(day.fixedBreak.end)] : null,
        targetMin: day.targetMin,
        workedMin,
        overtimeMin,
    };
}

/**
 * Check a day typed in the dialog: {arrival, departure, breaks: [[s, e]], fixedBreak: [s, e]|null},
 * all "H:MM". Returns [{field, message}]; empty when valid. Past days only. When adding a
 * day, pass `{adding: true, exists}` so an existing day is not overwritten by mistake.
 */
export function validateDay(input, key, now, {adding = false, exists = false} = {}) {
    const errors = [];
    const day = dateFromKey(key);
    if (!day)
        errors.push({field: 'date', message: 'Invalid date'});
    else if (key > dateKey(now))
        errors.push({field: 'date', message: 'The date is in the future'});
    else if (key === dateKey(now))
        errors.push({field: 'date', message: 'Today is edited on the Today page'});
    else if (adding && exists)
        errors.push({field: 'date', message: 'This day already exists: edit it in the list'});

    const arrival = parseHM(input.arrival ?? '');
    const departure = parseHM(input.departure ?? '');
    if (arrival === null)
        errors.push({field: 'arrival', message: 'Arrival: use H:MM'});
    if (departure === null)
        errors.push({field: 'departure', message: 'Departure: use H:MM'});
    if (arrival !== null && departure !== null && departure <= arrival)
        errors.push({field: 'departure', message: 'Departure must be after arrival'});

    if (input.fixedBreak) {
        const s = parseHM(input.fixedBreak[0] ?? '');
        const e = parseHM(input.fixedBreak[1] ?? '');
        if (s === null || e === null || e <= s)
            errors.push({field: 'fixedBreak', message: 'Fixed break: end must be after start (H:MM)'});
    }

    (input.breaks ?? []).forEach(([start, end], i) => {
        const s = parseHM(start ?? '');
        const e = parseHM(end ?? '');
        if (s === null || e === null || e <= s)
            errors.push({field: `breaks.${i}`, message: `Break ${i + 1}: end must be after start (H:MM)`});
        else if (arrival !== null && departure !== null && (s < arrival || e > departure))
            errors.push({field: `breaks.${i}`, message: `Break ${i + 1} must be between arrival and departure`});
    });
    return errors;
}

/** A valid dialog input (see validateDay) -> Day. */
export function dayFromInput(key, input, targetMin) {
    const day = dateFromKey(key);
    const at = text => atMinutes(day, parseHM(text));
    return {
        date: key,
        arrival: at(input.arrival),
        departure: at(input.departure),
        breaks: (input.breaks ?? []).map(([s, e]) => [at(s), at(e)]),
        openBreak: null,
        fixedBreak: input.fixedBreak ? {start: parseHM(input.fixedBreak[0]), end: parseHM(input.fixedBreak[1])} : null,
        targetMin,
    };
}

/** Day -> dialog input with "H:MM" strings (seconds dropped). */
export function inputFromDay(day) {
    const hm = date => formatHM(date.getHours() * 60 + date.getMinutes());
    return {
        arrival: hm(day.arrival),
        departure: hm(day.departure ?? day.arrival),
        breaks: day.breaks.map(([s, e]) => [hm(s), hm(e)]),
        fixedBreak: day.fixedBreak ? [formatHM(day.fixedBreak.start), formatHM(day.fixedBreak.end)] : null,
    };
}

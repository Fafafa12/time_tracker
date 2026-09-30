// Period statistics over Days (see day.js). Pure: no gi:// imports.
import {computeDay} from './day.js';
import {dateKey} from './timecalc.js';

const minuteOfDay = date => date.getHours() * 60 + date.getMinutes();
const average = values => (values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : null);

/** First and last date of the week (Monday-Sunday) or month containing `anchor`. */
export function periodRange(kind, anchor) {
    const y = anchor.getFullYear();
    const m = anchor.getMonth();
    if (kind === 'month')
        return {start: new Date(y, m, 1), end: new Date(y, m + 1, 0)};
    const offset = (anchor.getDay() + 6) % 7; // Monday = 0
    const start = new Date(y, m, anchor.getDate() - offset);
    return {start, end: new Date(y, m, anchor.getDate() - offset + 6)};
}

/** The period before (step -1) or after (step 1) the one containing `anchor`. */
export function shiftPeriod(kind, anchor, step) {
    if (kind === 'month')
        return new Date(anchor.getFullYear(), anchor.getMonth() + step, 1);
    return new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() + 7 * step);
}

/** Every date key of a range, in order. */
export function datesIn({start, end}) {
    const keys = [];
    for (let d = new Date(start); d <= end; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1))
        keys.push(dateKey(d));
    return keys;
}

/** Month keys ("YYYY-MM") a range touches. */
export function monthsIn(range) {
    return [...new Set(datesIn(range).map(key => key.slice(0, 7)))];
}

function record(list, better) {
    return list.reduce((best, item) => (best === null || better(item.value, best.value) ? item : best), null);
}

/**
 * Statistics of the Days inside `range`. Totals, averages and records use finished
 * days only (before today, with a departure); the chart has one entry per date,
 * today included (flagged, computed up to `now`).
 */
export function summarize(days, range, now) {
    const todayKey = dateKey(now);
    const keys = datesIn(range);
    const byDate = new Map(days.map(day => [day.date, day]));
    const finished = keys
        .filter(key => key < todayKey && byDate.get(key)?.departure)
        .map(key => ({day: byDate.get(key), ...computeDay(byDate.get(key))}));

    const workedMin = finished.reduce((sum, f) => sum + f.workedMin, 0);
    const overtimeMin = finished.reduce((sum, f) => sum + f.overtimeMin, 0);
    const worked = finished.map(f => ({date: f.day.date, value: f.workedMin}));
    const arrivals = finished.map(f => ({date: f.day.date, value: minuteOfDay(f.day.arrival)}));
    const departures = finished.map(f => ({date: f.day.date, value: minuteOfDay(f.day.departure)}));

    const chart = keys.map(key => {
        const day = byDate.get(key);
        if (!day || key > todayKey)
            return {date: key, empty: true};
        const until = key === todayKey ? now : day.departure ?? day.arrival;
        const {workedMin: w, overtimeMin: o} = computeDay(day, until);
        return {date: key, workedMin: w, targetMin: day.targetMin, overtimeMin: o, today: key === todayKey};
    });

    return {
        days: finished.length,
        workedMin,
        overtimeMin,
        avgWorkedMin: average(worked.map(w => w.value)),
        avgArrival: average(arrivals.map(a => a.value)),
        avgDeparture: average(departures.map(d => d.value)),
        avgBreakMin: average(finished.map(f => f.breakMin)),
        records: {
            earliestArrival: record(arrivals, (a, b) => a < b),
            latestDeparture: record(departures, (a, b) => a > b),
            longestDay: record(worked, (a, b) => a > b),
            shortestDay: record(worked, (a, b) => a < b),
        },
        chart,
    };
}

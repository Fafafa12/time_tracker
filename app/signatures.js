// Pure helpers telling the pages when data really changed, so the once-a-minute
// refresh does not replay animations or rebuild lists for today's growing numbers.
import {writeDay} from '../time-tracker@anjrakot/lib/day.js';

/** Identity of a chart: its dates and past values; today's live minutes are left out. */
export function chartKey(chart) {
    return chart.map(c => {
        if (c.empty)
            return `${c.date}:-`;
        return c.today ? `${c.date}:today:${c.targetMin}` : `${c.date}:${c.workedMin}:${c.targetMin}`;
    }).join('|');
}

/** Identity of a month's past days (today's row is updated in place instead). */
export function pastDaysKey(days, todayKey) {
    const past = days.filter(d => d.date < todayKey).map(d => [d.date, writeDay(d)]);
    return JSON.stringify([days.some(d => d.date === todayKey), past]);
}

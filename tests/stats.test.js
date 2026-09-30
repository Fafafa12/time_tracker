import {eq, test} from './harness.js';
import {readDay} from '../time-tracker@anjrakot/lib/day.js';
import {datesIn, monthsIn, periodRange, shiftPeriod, summarize} from '../time-tracker@anjrakot/lib/stats.js';
import {dateKey} from '../time-tracker@anjrakot/lib/timecalc.js';

const key = range => [dateKey(range.start), dateKey(range.end)];
// Days of September 2026 (Wed 30 = "today"); all with the default fixed break and 8h target.
const DAYS = [
    readDay('2026-09-24', {arrival: '07:58:00', departure: '17:05:00'}), // 8h07 (+7)
    readDay('2026-09-25', {arrival: '08:15:00', departure: '16:15:00'}), // 7h00 (-60)
    readDay('2026-09-28', {arrival: '08:31:00', departure: '17:12:00'}), // 7h41 (-19)
    readDay('2026-09-29', {arrival: '08:02:00', departure: '17:40:00'}), // 8h38 (+38)
    readDay('2026-09-30', {arrival: '09:49:48', departure: '10:00:00'}), // today
];
const NOW = new Date(2026, 8, 30, 15, 0);

test('periodRange: Monday-Sunday weeks and calendar months', () => {
    eq(key(periodRange('week', new Date(2026, 8, 30))), ['2026-09-28', '2026-10-04']);
    eq(key(periodRange('week', new Date(2026, 8, 28))), ['2026-09-28', '2026-10-04'], 'Monday itself');
    eq(key(periodRange('week', new Date(2026, 9, 4))), ['2026-09-28', '2026-10-04'], 'Sunday');
    eq(key(periodRange('month', new Date(2026, 8, 30))), ['2026-09-01', '2026-09-30']);
    eq(key(periodRange('month', new Date(2026, 1, 10))), ['2026-02-01', '2026-02-28']);
});

test('shiftPeriod moves by one week or month', () => {
    eq(dateKey(shiftPeriod('week', new Date(2026, 8, 30), -1)), '2026-09-23');
    eq(dateKey(shiftPeriod('month', new Date(2026, 0, 31), -1)), '2025-12-01');
    eq(dateKey(shiftPeriod('month', new Date(2026, 11, 5), 1)), '2027-01-01');
});

test('datesIn and monthsIn: a week can span two months', () => {
    const range = periodRange('week', new Date(2026, 8, 30));
    eq(datesIn(range).length, 7);
    eq(monthsIn(range), ['2026-09', '2026-10']);
});

test('summarize: totals and averages use finished days only (today left out)', () => {
    const s = summarize(DAYS, periodRange('month', NOW), NOW);
    eq([s.days, s.workedMin, s.overtimeMin], [4, 487 + 420 + 461 + 518, 7 - 60 - 19 + 38]);
    eq(s.avgWorkedMin, Math.round((487 + 420 + 461 + 518) / 4));
    eq(s.avgArrival, Math.round((478 + 495 + 511 + 482) / 4));
    eq(s.avgDeparture, Math.round((1025 + 975 + 1032 + 1060) / 4));
    eq(s.avgBreakMin, 60);
});

test('summarize: records with their dates', () => {
    const {records} = summarize(DAYS, periodRange('month', NOW), NOW);
    eq(records.earliestArrival, {date: '2026-09-24', value: 478});
    eq(records.latestDeparture, {date: '2026-09-29', value: 1060});
    eq(records.longestDay, {date: '2026-09-29', value: 518});
    eq(records.shortestDay, {date: '2026-09-25', value: 420});
});

test('summarize: chart has one entry per date, today flagged and computed until now', () => {
    const {chart} = summarize(DAYS, periodRange('week', NOW), NOW);
    eq(chart.map(c => c.date), ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04']);
    eq(chart[0], {date: '2026-09-28', workedMin: 461, targetMin: 480, overtimeMin: -19, today: false});
    eq([chart[2].today, chart[2].workedMin], [true, 250]);
    eq(chart[3], {date: '2026-10-01', empty: true});
});

test('summarize: an empty period', () => {
    const s = summarize([], periodRange('month', new Date(2026, 5, 1)), NOW);
    eq([s.days, s.workedMin, s.overtimeMin, s.avgWorkedMin, s.avgArrival], [0, 0, 0, null, null]);
    eq(s.records, {earliestArrival: null, latestDeparture: null, longestDay: null, shortestDay: null});
    eq(s.chart.every(c => c.empty), true);
});

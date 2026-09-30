import {eq, ok, test} from './harness.js';
import {readDay} from '../time-tracker@anjrakot/lib/day.js';
import {periodRange, summarize} from '../time-tracker@anjrakot/lib/stats.js';
import {chartKey, pastDaysKey} from '../app/signatures.js';

const DAYS = [
    readDay('2026-09-29', {arrival: '08:02:00', departure: '17:40:00'}),
    readDay('2026-09-30', {arrival: '09:49:48', departure: '10:00:00'}),
];

test('signatures: the chart key ignores today\'s minute-by-minute growth', () => {
    const range = periodRange('week', new Date(2026, 8, 30));
    const at14 = summarize(DAYS, range, new Date(2026, 8, 30, 14, 0)).chart;
    const at15 = summarize(DAYS, range, new Date(2026, 8, 30, 15, 0)).chart;
    ok(JSON.stringify(at14) !== JSON.stringify(at15), 'the chart data itself changes');
    eq(chartKey(at14), chartKey(at15));
    const lastWeek = summarize(DAYS, periodRange('week', new Date(2026, 8, 21)), new Date(2026, 8, 30, 15, 0)).chart;
    ok(chartKey(lastWeek) !== chartKey(at15), 'another period has another key');
});

test('signatures: the chart key changes when a past day is edited', () => {
    const range = periodRange('week', new Date(2026, 8, 30));
    const now = new Date(2026, 8, 30, 15, 0);
    const edited = [readDay('2026-09-29', {arrival: '08:02:00', departure: '18:40:00'}), DAYS[1]];
    ok(chartKey(summarize(DAYS, range, now).chart) !== chartKey(summarize(edited, range, now).chart));
});

test('signatures: the past-days key ignores today and follows past edits', () => {
    const later = [DAYS[0], readDay('2026-09-30', {arrival: '09:49:48', departure: '15:00:00'})];
    eq(pastDaysKey(DAYS, '2026-09-30'), pastDaysKey(later, '2026-09-30'));
    const edited = [readDay('2026-09-29', {arrival: '08:02:00', departure: '18:40:00'}), DAYS[1]];
    ok(pastDaysKey(DAYS, '2026-09-30') !== pastDaysKey(edited, '2026-09-30'));
});

import {eq, test} from './harness.js';
import {
    alertTime, buildAlerts, chooseArrival, configFrom, dateKey, formatClock, formatDuration,
    formatHM, monthKey, nextAlert, parseClock, parseHM, parseThresholds, remainingMinutes,
    selectDue, workedMinutes,
} from '../time-tracker@anjrakot/lib/timecalc.js';

// 2026-09-30 local time.
const at = (h, m, s = 0) => new Date(2026, 8, 30, h, m, s);
const CFG = configFrom({
    thresholds: ['4:00', '7:00', '7:45', '8:00'],
    breakStart: '12:30',
    breakEnd: '13:30',
    breakAlerts: true,
});

test('parseHM accepts H:MM and HH:MM, rejects the rest', () => {
    eq(parseHM('7:45'), 465);
    eq(parseHM('07:45'), 465);
    eq(parseHM(' 12:30 '), 750);
    eq(parseHM('0:00'), 0);
    for (const bad of ['', '7', '7:4', '7:60', '24:00', 'ab:cd', '7:45:00', '-1:00'])
        eq(parseHM(bad), null, `"${bad}"`);
});

test('formatting helpers', () => {
    eq(formatHM(465), '7:45');
    eq(formatHM(750), '12:30');
    eq(formatDuration(312), '5h12');
    eq(formatDuration(240), '4h');
    eq(formatDuration(305), '5h05');
    eq(formatDuration(48), '48min');
    eq(formatDuration(0), '0min');
    eq(formatClock(at(9, 5)), '09:05');
    eq(dateKey(at(9, 5)), '2026-09-30');
    eq(monthKey(at(9, 5)), '2026-09');
});

test('parseClock builds a Date on the given day', () => {
    eq(parseClock(at(0, 0), '09:49:48').getTime(), at(9, 49, 48).getTime());
    eq(parseClock(at(0, 0), '09:49').getTime(), at(9, 49).getTime());
    eq(parseClock(at(0, 0), 'garbage'), null);
    eq(parseClock(at(0, 0), undefined), null);
    eq(parseClock(at(0, 0), '25:00:00'), null);
});

test('parseThresholds sorts, de-duplicates and drops invalid or zero', () => {
    eq(parseThresholds(['8:00', '4:00', '7:45', '4:00', 'x', '0:00', '7:00']), [240, 420, 465, 480]);
    eq(parseThresholds([]), []);
});

test('configFrom falls back to the default break when invalid', () => {
    const bad = configFrom({thresholds: [], breakStart: '13:30', breakEnd: '12:30', breakAlerts: false});
    eq([bad.breakStart, bad.breakEnd, bad.breakAlerts], [750, 810, false]);
    const junk = configFrom({thresholds: [], breakStart: 'x', breakEnd: '13:00', breakAlerts: true});
    eq([junk.breakStart, junk.breakEnd], [750, 810]);
});

test('workedMinutes: arrival before the break', () => {
    eq(workedMinutes(at(8, 30), at(8, 30), CFG), 0);
    eq(workedMinutes(at(8, 30), at(8, 0), CFG), 0, 'before arrival');
    eq(workedMinutes(at(8, 30), at(12, 0), CFG), 210);
    eq(workedMinutes(at(8, 30), at(13, 0), CFG), 240, 'inside break is frozen');
    eq(workedMinutes(at(8, 30), at(13, 30), CFG), 240);
    eq(workedMinutes(at(8, 30), at(17, 30), CFG), 480);
});

test('workedMinutes: arrival inside and after the break', () => {
    eq(workedMinutes(at(12, 45), at(13, 15), CFG), 0);
    eq(workedMinutes(at(12, 45), at(14, 30), CFG), 60);
    eq(workedMinutes(at(14, 0), at(15, 0), CFG), 60);
});

test('workedMinutes truncates to whole minutes', () => {
    eq(workedMinutes(at(9, 49, 48), at(10, 0, 0), CFG), 10);
});

test('alertTime: before, inside and after the break', () => {
    eq(formatClock(alertTime(at(8, 30), 480, CFG)), '17:30', 'spec example');
    eq(formatClock(alertTime(at(8, 30), 240, CFG)), '12:30', 'lands exactly on break start');
    eq(formatClock(alertTime(at(8, 30), 180, CFG)), '11:30');
    eq(formatClock(alertTime(at(12, 45), 60, CFG)), '14:30', 'counts from break end');
    eq(formatClock(alertTime(at(14, 0), 240, CFG)), '18:00');
});

test('alertTime is consistent with workedMinutes', () => {
    for (const arrival of [at(7, 0), at(9, 49, 48), at(12, 30), at(13, 10), at(13, 30), at(15, 0)]) {
        for (const minutes of [1, 60, 240, 465, 480]) {
            const t = alertTime(arrival, minutes, CFG);
            eq(workedMinutes(arrival, t, CFG), minutes, `${formatClock(arrival)} +${minutes}`);
        }
    }
});

test('remainingMinutes counts down to the last threshold and stops at 0', () => {
    eq(remainingMinutes(at(8, 30), at(16, 0), CFG), 90);
    eq(remainingMinutes(at(8, 30), at(19, 0), CFG), 0);
    eq(remainingMinutes(at(8, 30), at(16, 0), {...CFG, thresholds: []}), 0);
});

test('buildAlerts: work alerts with ids, final flag and break alerts', () => {
    const alerts = buildAlerts(at(8, 30), CFG);
    eq(alerts.map(a => a.id), ['w240', 'w420', 'w465', 'w480', 'break-start', 'break-end']);
    eq(alerts.map(a => formatClock(a.time)), ['12:30', '16:30', '17:15', '17:30', '12:30', '13:30']);
    eq(alerts.filter(a => a.final).map(a => a.id), ['w480']);
});

test('buildAlerts skips break alerts after arrival or when disabled', () => {
    eq(buildAlerts(at(12, 45), CFG).filter(a => a.kind === 'break').map(a => a.id), ['break-end']);
    eq(buildAlerts(at(14, 0), CFG).filter(a => a.kind === 'break').length, 0);
    eq(buildAlerts(at(8, 30), {...CFG, breakAlerts: false}).filter(a => a.kind === 'break').length, 0);
});

test('buildAlerts with no thresholds', () => {
    eq(buildAlerts(at(8, 30), {...CFG, thresholds: [], breakAlerts: false}), []);
});

test('selectDue: nothing due, then exactly one due', () => {
    const alerts = buildAlerts(at(8, 30), CFG);
    eq(selectDue(alerts, [], at(10, 0)), {show: [], markFired: []});
    const r = selectDue(alerts, ['break-start', 'break-end'], at(12, 30));
    eq(r.show.map(a => a.id), ['w240']);
    eq(r.markFired, ['w240']);
});

test('selectDue: several missed work alerts -> only the largest is shown', () => {
    const alerts = buildAlerts(at(8, 0), CFG);
    const r = selectDue(alerts, [], at(16, 30));
    eq(r.show.map(a => a.id), ['w420']);
    eq([...r.markFired].sort(), ['break-end', 'break-start', 'w240', 'w420']);
});

test('selectDue: already fired alerts are never shown again', () => {
    const alerts = buildAlerts(at(8, 0), CFG);
    eq(selectDue(alerts, ['w240', 'w420', 'break-start', 'break-end'], at(16, 30)).show, []);
});

test('selectDue: break alerts on time, latest wins, stale ones are silent', () => {
    const alerts = buildAlerts(at(9, 0), CFG);
    eq(selectDue(alerts, [], at(12, 31)).show.map(a => a.id), ['break-start']);
    eq(selectDue(alerts, [], at(13, 35)).show.map(a => a.id), ['break-end'], 'break-start skipped');
    const stale = selectDue(alerts, [], at(13, 41));
    eq(stale.show.map(a => a.id), [], 'more than 10 min late');
    eq([...stale.markFired].sort(), ['break-end', 'break-start']);
});

test('nextAlert returns the earliest upcoming unfired alert', () => {
    const alerts = buildAlerts(at(8, 30), CFG);
    eq(nextAlert(alerts, [], at(10, 0)).id, 'w240');
    eq(nextAlert(alerts, ['w240', 'break-start'], at(12, 40)).id, 'break-end');
    eq(nextAlert(alerts, [], at(18, 0)), null);
});

test('chooseArrival: boot today -> boot time, otherwise now', () => {
    const now = at(10, 43);
    eq(chooseArrival(now, at(9, 49, 48)).getTime(), at(9, 49, 48).getTime());
    eq(chooseArrival(now, new Date(2026, 8, 29, 18, 0)).getTime(), now.getTime(), 'booted yesterday');
    eq(chooseArrival(now, at(11, 0)).getTime(), now.getTime(), 'boot in the future');
    eq(chooseArrival(now, null).getTime(), now.getTime(), 'unknown boot time');
});

import {eq, test} from './harness.js';
import {
    alertTime, breakIntervals, breakMinutes, buildAlerts, chooseArrival, configFrom, dateFromKey,
    dateKey, formatClock, formatDuration, formatHM, formatSigned, mergeIntervals, monthKey,
    nextAlert, parseClock, parseHM, parseThresholds, remainingMinutes, selectDue, targetOf,
    thresholdsToSave, workedMinutes,
} from '../time-tracker@anjrakot/lib/timecalc.js';

// 2026-09-30 local time.
const at = (h, m, s = 0) => new Date(2026, 8, 30, h, m, s);
const CFG = configFrom({
    thresholds: ['4:00', '7:00', '7:45', '8:00'],
    fixedBreak: true,
    breakStart: '12:30',
    breakEnd: '13:30',
    breakAlerts: true,
});
// Break intervals of a day with the default fixed break plus optional manual/open breaks.
const iv = (arrival, extra = {}) => breakIntervals(arrival, {fixedBreak: CFG.fixedBreak, ...extra});

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
    eq(formatSigned(25), '+0h25');
    eq(formatSigned(-70), '−1h10');
    eq(formatSigned(0), '+0h00');
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
    eq(parseClock(at(0, 0), '8:05').getTime(), at(8, 5).getTime(), 'hand-edited H:MM');
});

test('dateFromKey parses valid keys only', () => {
    eq(dateFromKey('2026-09-30').getTime(), at(0, 0).getTime());
    eq(dateFromKey('2026-02-30'), null);
    eq(dateFromKey('30/09/2026'), null);
    eq(dateFromKey(undefined), null);
});

test('parseThresholds sorts, de-duplicates and drops invalid or zero', () => {
    eq(parseThresholds(['8:00', '4:00', '7:45', '4:00', 'x', '0:00', '7:00']), [240, 420, 465, 480]);
    eq(parseThresholds([]), []);
});

test('configFrom: fixed break on/off and fallback when invalid', () => {
    eq(CFG.fixedBreak, {start: 750, end: 810});
    eq(configFrom({thresholds: [], fixedBreak: false, breakStart: '12:30', breakEnd: '13:30'}).fixedBreak, null);
    const bad = configFrom({thresholds: [], fixedBreak: true, breakStart: '13:30', breakEnd: '12:30', breakAlerts: false});
    eq([bad.fixedBreak, bad.breakAlerts], [{start: 750, end: 810}, false]);
    eq(configFrom({thresholds: [], fixedBreak: true, breakStart: 'x', breakEnd: '13:00'}).fixedBreak, {start: 750, end: 810});
});

test('targetOf is the largest threshold, 0 without thresholds', () => {
    eq(targetOf(CFG), 480);
    eq(targetOf({...CFG, thresholds: []}), 0);
});

test('mergeIntervals sorts and merges overlapping and touching pairs', () => {
    eq(mergeIntervals([[5, 8], [1, 3], [2, 4], [8, 9], [7, 7]]), [[1, 4], [5, 9]]);
    eq(mergeIntervals([[1, 2], [3, Infinity], [5, 6]]), [[1, 2], [3, Infinity]]);
    eq(mergeIntervals([]), []);
});

test('workedMinutes with the fixed break: arrival before the break', () => {
    const a = at(8, 30);
    eq(workedMinutes(a, at(8, 30), iv(a)), 0);
    eq(workedMinutes(a, at(8, 0), iv(a)), 0, 'before arrival');
    eq(workedMinutes(a, at(12, 0), iv(a)), 210);
    eq(workedMinutes(a, at(13, 0), iv(a)), 240, 'inside break is frozen');
    eq(workedMinutes(a, at(13, 30), iv(a)), 240);
    eq(workedMinutes(a, at(17, 30), iv(a)), 480);
});

test('workedMinutes: arrival inside and after the break, no fixed break', () => {
    eq(workedMinutes(at(12, 45), at(13, 15), iv(at(12, 45))), 0);
    eq(workedMinutes(at(12, 45), at(14, 30), iv(at(12, 45))), 60);
    eq(workedMinutes(at(14, 0), at(15, 0), iv(at(14, 0))), 60);
    eq(workedMinutes(at(8, 30), at(17, 30), []), 540, 'fixed break off');
});

test('workedMinutes with manual breaks, overlaps counted once, and an open break', () => {
    const a = at(8, 0);
    const manual = iv(a, {breaks: [[at(10, 0), at(10, 15)], [at(13, 0), at(14, 0)]]});
    eq(workedMinutes(a, at(16, 0), manual), 480 - 15 - 90, 'fixed 12:30-13:30 merged with 13:00-14:00');
    eq(breakMinutes(a, at(16, 0), manual), 105);
    const open = iv(a, {openBreak: at(15, 10)});
    eq(workedMinutes(a, at(15, 40), open), 370, 'open break stops the count');
    eq(workedMinutes(a, at(18, 0), open), 370);
});

test('workedMinutes truncates to whole minutes', () => {
    eq(workedMinutes(at(9, 49, 48), at(10, 0, 0), iv(at(9, 49, 48))), 10);
});

test('alertTime: before, inside and after the fixed break', () => {
    eq(formatClock(alertTime(at(8, 30), 480, iv(at(8, 30)))), '17:30', 'spec example');
    eq(formatClock(alertTime(at(8, 30), 240, iv(at(8, 30)))), '12:30', 'lands exactly on break start');
    eq(formatClock(alertTime(at(8, 30), 180, iv(at(8, 30)))), '11:30');
    eq(formatClock(alertTime(at(12, 45), 60, iv(at(12, 45)))), '14:30', 'counts from break end');
    eq(formatClock(alertTime(at(14, 0), 240, iv(at(14, 0)))), '18:00');
});

test('alertTime shifts after manual breaks and is null while an open break runs', () => {
    const a = at(8, 30);
    eq(formatClock(alertTime(a, 480, iv(a, {breaks: [[at(15, 0), at(15, 20)]]}))), '17:50');
    eq(alertTime(a, 480, iv(a, {openBreak: at(15, 10)})), null, 'paused');
    eq(formatClock(alertTime(a, 240, iv(a, {openBreak: at(15, 10)}))), '12:30', 'reached before the open break');
});

test('alertTime is consistent with workedMinutes', () => {
    const extras = [{}, {breaks: [[at(9, 0), at(9, 30)], [at(15, 0), at(16, 0)]]}];
    for (const extra of extras) {
        for (const arrival of [at(7, 0), at(9, 49, 48), at(12, 30), at(13, 10), at(13, 30), at(15, 0)]) {
            for (const minutes of [1, 60, 240, 465, 480]) {
                const intervals = iv(arrival, extra);
                const t = alertTime(arrival, minutes, intervals);
                eq(workedMinutes(arrival, t, intervals), minutes, `${formatClock(arrival)} +${minutes}`);
            }
        }
    }
});

test('remainingMinutes counts down to the target and stops at 0', () => {
    eq(remainingMinutes(at(8, 30), at(16, 0), CFG, iv(at(8, 30))), 90);
    eq(remainingMinutes(at(8, 30), at(19, 0), CFG, iv(at(8, 30))), 0);
    eq(remainingMinutes(at(8, 30), at(16, 0), {...CFG, thresholds: []}, iv(at(8, 30))), 0);
});

test('buildAlerts: work alerts with ids, final flag and fixed-break alerts', () => {
    const alerts = buildAlerts(at(8, 30), CFG, iv(at(8, 30)));
    eq(alerts.map(a => a.id), ['w240', 'w420', 'w465', 'w480', 'break-start', 'break-end']);
    eq(alerts.map(a => formatClock(a.time)), ['12:30', '16:30', '17:15', '17:30', '12:30', '13:30']);
    eq(alerts.filter(a => a.final).map(a => a.id), ['w480']);
});

test('buildAlerts skips break alerts after arrival, when disabled or without a fixed break', () => {
    const breakIds = (arrival, cfg) => buildAlerts(arrival, cfg, iv(arrival)).filter(a => a.kind === 'break').map(a => a.id);
    eq(breakIds(at(12, 45), CFG), ['break-end']);
    eq(breakIds(at(14, 0), CFG), []);
    eq(breakIds(at(8, 30), {...CFG, breakAlerts: false}), []);
    eq(breakIds(at(8, 30), {...CFG, fixedBreak: null}), []);
});

test('buildAlerts with no thresholds', () => {
    eq(buildAlerts(at(8, 30), {...CFG, thresholds: [], breakAlerts: false}, []), []);
});

test('buildAlerts marks work alerts past an open break as paused (time null)', () => {
    const a = at(8, 30);
    const alerts = buildAlerts(a, CFG, iv(a, {openBreak: at(15, 10)}));
    eq(alerts.filter(x => x.kind === 'work').map(x => x.time && formatClock(x.time)), ['12:30', null, null, null]);
});

test('selectDue: nothing due, then exactly one due', () => {
    const alerts = buildAlerts(at(8, 30), CFG, iv(at(8, 30)));
    eq(selectDue(alerts, [], at(10, 0)), {show: [], markFired: []});
    const r = selectDue(alerts, ['break-start', 'break-end'], at(12, 30));
    eq(r.show.map(a => a.id), ['w240']);
    eq(r.markFired, ['w240']);
});

test('selectDue: several missed work alerts -> only the largest is shown', () => {
    const alerts = buildAlerts(at(8, 0), CFG, iv(at(8, 0)));
    const r = selectDue(alerts, [], at(16, 30));
    eq(r.show.map(a => a.id), ['w420']);
    eq([...r.markFired].sort(), ['break-end', 'break-start', 'w240', 'w420']);
});

test('selectDue: already fired alerts are never shown again', () => {
    const alerts = buildAlerts(at(8, 0), CFG, iv(at(8, 0)));
    eq(selectDue(alerts, ['w240', 'w420', 'break-start', 'break-end'], at(16, 30)).show, []);
});

test('selectDue: break alerts on time, latest wins, stale ones are silent', () => {
    const alerts = buildAlerts(at(9, 0), CFG, iv(at(9, 0)));
    eq(selectDue(alerts, [], at(12, 31)).show.map(a => a.id), ['break-start']);
    eq(selectDue(alerts, [], at(13, 35)).show.map(a => a.id), ['break-end'], 'break-start skipped');
    const stale = selectDue(alerts, [], at(13, 41));
    eq(stale.show.map(a => a.id), [], 'more than 10 min late');
    eq([...stale.markFired].sort(), ['break-end', 'break-start']);
});

test('selectDue never fires a paused alert', () => {
    const a = at(8, 0);
    const alerts = buildAlerts(a, CFG, iv(a, {openBreak: at(15, 0)}));
    eq(selectDue(alerts, ['w240', 'break-start', 'break-end'], at(23, 0)).show, []);
});

test('nextAlert: earliest upcoming, then paused, then null', () => {
    const alerts = buildAlerts(at(8, 30), CFG, iv(at(8, 30)));
    eq(nextAlert(alerts, [], at(10, 0)).id, 'w240');
    eq(nextAlert(alerts, ['w240', 'break-start'], at(12, 40)).id, 'break-end');
    eq(nextAlert(alerts, [], at(18, 0)), null);
    const onBreak = buildAlerts(at(8, 30), CFG, iv(at(8, 30), {openBreak: at(15, 10)}));
    const next = nextAlert(onBreak, ['w240', 'break-start', 'break-end'], at(15, 20));
    eq([next.id, next.time], ['w420', null]);
});

test('chooseArrival: boot today -> boot time, otherwise now', () => {
    const now = at(10, 43);
    eq(chooseArrival(now, at(9, 49, 48)).getTime(), at(9, 49, 48).getTime());
    eq(chooseArrival(now, new Date(2026, 8, 29, 18, 0)).getTime(), now.getTime(), 'booted yesterday');
    eq(chooseArrival(now, at(11, 0)).getTime(), now.getTime(), 'boot in the future');
    eq(chooseArrival(now, null).getTime(), now.getTime(), 'unknown boot time');
});

test('thresholdsToSave: nothing is saved while a filled row is invalid', () => {
    eq(thresholdsToSave(['4:00', '7:4x']), null);
    eq(thresholdsToSave(['4:00', '0:00']), null);
    eq(thresholdsToSave(['8:00', '', ' 4:00 ', '4:00']), ['4:00', '8:00'], 'empty rows ignored');
    eq(thresholdsToSave([]), []);
});

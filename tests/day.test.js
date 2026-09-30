import {eq, ok, test} from './harness.js';
import {
    closeDay, computeDay, dayFromInput, inputFromDay, readDay, validateDay, writeDay,
} from '../time-tracker@anjrakot/lib/day.js';

const on = (d, h, m, s = 0) => new Date(2026, 8, d, h, m, s); // September 2026
const NOW = on(30, 10, 0);
const V2 = {
    arrival: '08:02:00', departure: '17:40:00', breaks: [['15:00:00', '15:20:00']],
    openBreak: null, fixedBreak: ['12:30', '13:30'], targetMin: 480, workedMin: 0, overtimeMin: 0,
};

test('day: a v1 entry reads with defaults (fixed 12:30-13:30, 8h, no breaks)', () => {
    const day = readDay('2026-09-29', {arrival: '08:02:00', departure: '17:40:00', workedMin: 518});
    eq(day.fixedBreak, {start: 750, end: 810});
    eq([day.targetMin, day.breaks, day.openBreak], [480, [], null]);
    eq(computeDay(day), {workedMin: 518, overtimeMin: 38, breakMin: 60});
});

test('day: a v2 entry reads breaks, a disabled fixed break and its own target', () => {
    const day = readDay('2026-09-29', {...V2, fixedBreak: null, targetMin: 420});
    eq(day.fixedBreak, null);
    eq(day.breaks.map(([s, e]) => [s.getHours(), s.getMinutes(), e.getMinutes()]), [[15, 0, 20]]);
    eq(computeDay(day), {workedMin: 558, overtimeMin: 138, breakMin: 20});
});

test('day: invalid arrival or key reads as null; bad breaks are dropped', () => {
    eq(readDay('2026-09-29', {arrival: 'oops'}), null);
    eq(readDay('2026-13-01', {arrival: '08:00:00'}), null);
    eq(readDay('2026-09-29', null), null);
    const day = readDay('2026-09-29', {...V2, breaks: [['15:00:00', '14:00:00'], 'x', ['16:00:00', '16:10:00']]});
    eq(day.breaks.length, 1);
});

test('day: an invalid fixedBreak falls back to the default', () => {
    eq(readDay('2026-09-29', {...V2, fixedBreak: ['13:30', '12:30']}).fixedBreak, {start: 750, end: 810});
});

test('day: writeDay recomputes derived fields and round-trips', () => {
    const day = readDay('2026-09-29', V2);
    const entry = writeDay(day);
    eq(entry, {...V2, workedMin: 498, overtimeMin: 18});
    eq(writeDay(readDay('2026-09-29', entry)), entry);
});

test('day: closeDay finishes an open break at departure', () => {
    const day = readDay('2026-09-29', {...V2, breaks: [], openBreak: '16:00:00', departure: '16:00:00'});
    const closed = closeDay(day, on(29, 17, 40));
    eq(closed.openBreak, null);
    eq(closed.breaks.map(([s, e]) => [s.getHours(), e.getHours(), e.getMinutes()]), [[16, 17, 40]]);
    eq(computeDay(closed).workedMin, 418);
    ok(day.openBreak, 'original untouched');
});

test('day: writeDay never writes a departure before arrival', () => {
    const day = readDay('2026-09-29', {...V2, departure: '07:00:00'});
    eq(writeDay(day).departure, '08:02:00');
    eq(writeDay(day).workedMin, 0);
});

test('validateDay: a valid past day has no errors', () => {
    const input = {arrival: '8:02', departure: '17:40', breaks: [['15:00', '15:20']], fixedBreak: ['12:30', '13:30']};
    eq(validateDay(input, '2026-09-29', NOW), []);
    eq(validateDay({...input, fixedBreak: null, breaks: []}, '2026-09-29', NOW), []);
});

test('validateDay: each rule reports its field', () => {
    const fields = (input, key = '2026-09-29') => validateDay(input, key, NOW).map(e => e.field);
    const base = {arrival: '8:00', departure: '17:00', breaks: [], fixedBreak: null};
    eq(fields(base, '2026-10-01'), ['date']);
    eq(fields(base, '2026-09-30'), ['date'], 'today');
    eq(fields(base, 'nope'), ['date']);
    eq(fields({...base, arrival: '8h'}), ['arrival']);
    eq(fields({...base, departure: ''}), ['departure']);
    eq(fields({...base, departure: '7:00'}), ['departure']);
    eq(fields({...base, fixedBreak: ['13:30', '12:30']}), ['fixedBreak']);
    eq(fields({...base, breaks: [['15:00', '14:00']]}), ['breaks.0']);
    eq(fields({...base, breaks: [['7:00', '8:30'], ['9:00', '9:10']]}), ['breaks.0'], 'before arrival');
    eq(fields({...base, breaks: [['16:50', '17:10']]}), ['breaks.0'], 'after departure');
});

test('validateDay messages are readable', () => {
    const [error] = validateDay({arrival: '9:00', departure: '8:00', breaks: []}, '2026-09-29', NOW);
    eq(error.message, 'Departure must be after arrival');
});

test('dayFromInput and inputFromDay are inverse (seconds dropped)', () => {
    const input = {arrival: '8:02', departure: '17:40', breaks: [['15:00', '15:20']], fixedBreak: ['12:30', '13:30']};
    const day = dayFromInput('2026-09-29', input, 480);
    eq(computeDay(day), {workedMin: 498, overtimeMin: 18, breakMin: 80});
    eq(inputFromDay(day), input);
});

test('validateDay: adding a day that already exists is refused', () => {
    const input = {arrival: '8:00', departure: '17:00', breaks: [], fixedBreak: null};
    eq(validateDay(input, '2026-09-29', NOW, {adding: true, exists: true}).map(e => e.message),
        ['This day already exists: edit it in the list']);
    eq(validateDay(input, '2026-09-29', NOW, {adding: true, exists: false}), []);
    eq(validateDay(input, '2026-09-29', NOW, {adding: false, exists: true}), [], 'editing it is fine');
});

test('day: inputFromDay shows a past day\'s unfinished break, finished at departure', () => {
    // Session ended during a break (logout at 17:45 while on a break since 16:00).
    const day = readDay('2026-09-29', {...V2, breaks: [], openBreak: '16:00:00', departure: '17:45:00'});
    const input = inputFromDay(day);
    eq(input.breaks, [['16:00', '17:45']]);
    eq(computeDay(dayFromInput('2026-09-29', input, 480)), computeDay(day), 'saving it unchanged keeps the same worked time');
});

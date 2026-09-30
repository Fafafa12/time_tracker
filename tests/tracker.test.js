import {eq, ok, test} from './harness.js';
import {configFrom} from '../time-tracker@anjrakot/lib/timecalc.js';
import {SAVE_EVERY_TICKS, Tracker, UserError} from '../time-tracker@anjrakot/lib/tracker.js';

const day = (d, h, m, s = 0) => new Date(2026, 8, d, h, m, s); // September 2026
const at = (h, m, s = 0) => day(30, h, m, s);
const CFG = configFrom({
    thresholds: ['4:00', '7:00', '7:45', '8:00'],
    fixedBreak: true,
    breakStart: '12:30',
    breakEnd: '13:30',
    breakAlerts: true,
});

// In-memory stand-in for Store; JSON copies mimic real serialisation.
class FakeStore {
    constructor() {
        this.files = {};
        this.writes = 0;
    }

    loadMonth(month) {
        return this._get(`${month}.json`);
    }

    saveMonth(month, data) {
        this._set(`${month}.json`, data);
    }

    loadState() {
        return this._get('state.json');
    }

    saveState(state) {
        this._set('state.json', state);
    }

    _get(name) {
        return name in this.files ? JSON.parse(this.files[name]) : {};
    }

    _set(name, data) {
        this.writes++;
        this.files[name] = JSON.stringify(data);
    }
}

function setup({store = new FakeStore(), now = at(10, 43), boot = at(9, 49, 48), cfg = CFG} = {}) {
    const clock = {now};
    const tracker = new Tracker({
        store,
        config: () => cfg,
        now: () => clock.now,
        bootTime: () => boot,
    });
    return {store, clock, tracker};
}

test('tracker: first run of the day uses today\'s boot time and writes history', () => {
    const {store, tracker} = setup();
    tracker.tick();
    eq(tracker.arrival.getTime(), at(9, 49, 48).getTime());
    const entry = store.loadMonth('2026-09')['2026-09-30'];
    eq(entry.arrival, '09:49:48');
    eq(entry.departure, '10:43:00');
    eq(entry.workedMin, 53);
    eq(store.loadState(), {date: '2026-09-30', fired: []});
});

test('tracker: booted yesterday -> arrival is now (whole seconds)', () => {
    const {tracker} = setup({now: at(8, 15, 20), boot: day(29, 22, 0)});
    tracker.tick();
    eq(tracker.arrival.getTime(), at(8, 15, 20).getTime());
});

test('tracker: a restart on the same day keeps the saved arrival', () => {
    const {store} = setup();
    setup({store}).tracker.tick();
    const later = setup({store, now: at(15, 0), boot: at(14, 55)});
    later.tracker.tick();
    eq(later.tracker.arrival.getTime(), at(9, 49, 48).getTime());
});

test('tracker: fired alerts survive a restart and do not repeat', () => {
    const {store, clock, tracker} = setup({now: at(9, 0), boot: at(8, 0)});
    tracker.tick();
    clock.now = at(12, 0);
    eq(tracker.tick().map(m => m.title), ['⏱ 4h done']);
    const again = setup({store, now: at(12, 5), boot: at(12, 3)});
    eq(again.tracker.tick(), []);
});

test('tracker: missed alerts after a shutdown -> one notification with the latest', () => {
    const store = new FakeStore();
    setup({store, now: at(8, 1), boot: at(8, 0)}).tracker.tick();
    const back = setup({store, now: at(16, 30), boot: at(16, 28)});
    const msgs = back.tracker.tick();
    eq(msgs.map(m => m.title), ['⏱ 7h done']);
    eq(msgs[0].body, '30min left (since 08:00)');
    eq([...store.loadState().fired].sort(), ['break-end', 'break-start', 'w240', 'w420']);
});

test('tracker: final alert is urgent, break alerts have their own text', () => {
    const {clock, tracker} = setup({now: at(8, 30), boot: at(8, 30)});
    tracker.tick();
    clock.now = at(12, 30);
    eq(tracker.tick().map(m => [m.title, m.body]), [
        ['⏱ 4h done', '4h left (since 08:30)'],
        ['Break time 🍽', 'Back at 13:30'],
    ]);
    clock.now = at(13, 30);
    eq(tracker.tick(), [{title: 'Back to work 💼', body: '4h done so far (since 08:30)', urgent: false}]);
    clock.now = at(17, 30);
    const [final] = tracker.tick();
    eq([final.title, final.urgent], ['⏱ 8h done', true]);
});

test('tracker: last seen is saved on the first tick and every SAVE_EVERY_TICKS ticks', () => {
    const {store, clock, tracker} = setup();
    tracker.tick();
    for (let i = 1; i <= SAVE_EVERY_TICKS; i++) {
        clock.now = new Date(at(10, 43).getTime() + i * 60000);
        tracker.tick();
    }
    eq(store.loadMonth('2026-09')['2026-09-30'].departure, '10:48:00');
});

test('tracker: stop() records the departure', () => {
    const {store, clock, tracker} = setup();
    tracker.tick();
    clock.now = at(17, 2, 10);
    tracker.stop();
    const entry = store.loadMonth('2026-09')['2026-09-30'];
    eq([entry.departure, entry.workedMin], ['17:02:10', 372]);
});

test('tracker: stop() before any tick writes nothing', () => {
    const {store, tracker} = setup();
    tracker.stop();
    eq(store.writes, 0);
});

test('tracker: crossing midnight closes the old day and starts a new one', () => {
    const {store, clock, tracker} = setup({now: day(30, 23, 50), boot: day(30, 9, 0)});
    tracker.tick();
    clock.now = new Date(2026, 9, 1, 0, 0, 30); // 1 October
    tracker.tick();
    eq(store.loadMonth('2026-09')['2026-09-30'].departure, '23:50:00');
    eq(store.loadMonth('2026-10')['2026-10-01'].arrival, '00:00:30');
    eq(store.loadState(), {date: '2026-10-01', fired: []});
});

test('tracker: resetArrival sets arrival to now and clears fired alerts', () => {
    const {store, clock, tracker} = setup({now: at(12, 0), boot: at(7, 0)});
    tracker.tick();
    clock.now = at(14, 10, 5);
    tracker.resetArrival();
    eq(tracker.arrival.getTime(), at(14, 10, 5).getTime());
    eq(store.loadState(), {date: '2026-09-30', fired: []});
    eq(store.loadMonth('2026-09')['2026-09-30'].arrival, '14:10:05');
});

test('tracker: view() gives worked, remaining and next alert', () => {
    const {clock, tracker} = setup({now: at(8, 30), boot: at(8, 30)});
    tracker.tick();
    clock.now = at(14, 0);
    const v = tracker.view();
    eq([v.workedMin, v.remainingMin, v.targetMin, v.overtimeMin], [270, 210, 480, -210]);
    eq(v.next, {label: '7h', time: '16:30'});
    eq([v.arrival, v.leaveAt, v.onBreak, v.fixedBreak], ['08:30:00', '17:30', false, ['12:30', '13:30']]);
    clock.now = at(18, 0);
    tracker.tick();
    eq(tracker.view().next, null);
});

test('tracker: a corrupt history arrival is replaced using the arrival rule', () => {
    const store = new FakeStore();
    store.saveMonth('2026-09', {'2026-09-30': {arrival: 'oops'}});
    const {tracker} = setup({store});
    tracker.tick();
    eq(store.loadMonth('2026-09')['2026-09-30'].arrival, '09:49:48');
    ok(tracker.arrival);
});

test('tracker: state.json from another day is ignored', () => {
    const store = new FakeStore();
    store.saveState({date: '2026-09-29', fired: ['w240', 'w420', 'w465', 'w480']});
    const {clock, tracker} = setup({store, now: at(8, 0), boot: at(8, 0)});
    tracker.tick();
    clock.now = at(12, 0);
    eq(tracker.tick().map(m => m.title), ['⏱ 4h done']);
});

test('tracker: editing thresholds mid-day never repeats fired alerts', () => {
    let cfg = CFG;
    const store = new FakeStore();
    const clock = {now: at(8, 0)};
    const tracker = new Tracker({store, config: () => cfg, now: () => clock.now, bootTime: () => at(8, 0)});
    tracker.tick();
    clock.now = at(12, 0);
    eq(tracker.tick().map(m => m.title), ['⏱ 4h done']);
    cfg = configFrom({thresholds: ['4:00', '6:00', '8:00'], fixedBreak: true, breakStart: '12:30', breakEnd: '13:30', breakAlerts: false});
    clock.now = at(15, 1);
    eq(tracker.tick().map(m => m.title), ['⏱ 6h done'], 'new past threshold fires once');
    clock.now = at(15, 2);
    eq(tracker.tick(), []);
});

test('tracker: with no thresholds there are no work alerts and the view still works', () => {
    const cfg = configFrom({thresholds: [], fixedBreak: true, breakStart: '12:30', breakEnd: '13:30', breakAlerts: false});
    const {clock, tracker} = setup({now: at(8, 0), boot: at(8, 0), cfg});
    tracker.tick();
    clock.now = at(18, 0);
    eq(tracker.tick(), []);
    const v = tracker.view();
    eq([v.workedMin, v.remainingMin, v.next, v.leaveAt], [540, 0, null, null]);
});

test('tracker: a failing store never throws from tick and view keeps working', () => {
    const store = new FakeStore();
    store._set = () => {
        throw new Error('disk full');
    };
    const {tracker} = setup({store});
    eq(tracker.tick(), []);
    eq(tracker.view().workedMin, 53);
});

test('tracker: a failing store still delivers due notifications', () => {
    const store = new FakeStore();
    const {clock, tracker} = setup({store, now: at(8, 0), boot: at(8, 0)});
    tracker.tick();
    store._set = () => {
        throw new Error('disk full');
    };
    clock.now = at(12, 0);
    eq(tracker.tick().map(m => m.title), ['⏱ 4h done']);
    clock.now = at(12, 1);
    eq(tracker.tick(), [], 'not repeated within the session');
});

test('tracker: other days in the month file are kept when today is saved', () => {
    const store = new FakeStore();
    const other = {arrival: '08:02:00', departure: '17:40:00', workedMin: 518};
    store.saveMonth('2026-09', {'2026-09-29': other});
    const {clock, tracker} = setup({store});
    tracker.tick();
    clock.now = at(17, 0);
    tracker.stop();
    eq(store.loadMonth('2026-09')['2026-09-29'], other);
    eq(Object.keys(store.loadMonth('2026-09')).sort(), ['2026-09-29', '2026-09-30']);
});

test('tracker: clock set back before arrival gives 0 worked, not negative', () => {
    const {clock, tracker} = setup();
    tracker.tick();
    clock.now = at(9, 0);
    eq(tracker.view().workedMin, 0);
});

test('tracker: moveTo carries arrival and fired alerts into the new folder', () => {
    const oldStore = new FakeStore();
    const newStore = new FakeStore();
    const {clock, tracker} = setup({store: oldStore, now: at(8, 0), boot: at(8, 0)});
    tracker.tick();
    clock.now = at(12, 0);
    eq(tracker.tick().map(m => m.title), ['⏱ 4h done']);
    clock.now = at(12, 5);
    tracker.moveTo(newStore);
    eq(newStore.loadMonth('2026-09')['2026-09-30'].arrival, '08:00:00');
    eq(newStore.loadState(), {date: '2026-09-30', fired: ['w240']});
    eq(oldStore.loadMonth('2026-09')['2026-09-30'].departure, '12:05:00', 'old folder closed');
    clock.now = at(12, 6);
    eq(tracker.tick(), []);
    const restarted = setup({store: newStore, now: at(13, 0), boot: at(12, 59)});
    eq(restarted.tracker.tick(), [], 'no repeat after a restart either');
    eq(restarted.tracker.arrival.getTime(), at(8, 0).getTime());
});

test('tracker: moveTo works when the old folder is failing', () => {
    const oldStore = new FakeStore();
    const newStore = new FakeStore();
    const {tracker} = setup({store: oldStore});
    tracker.tick();
    oldStore._set = () => {
        throw new Error('gone');
    };
    tracker.moveTo(newStore);
    eq(newStore.loadMonth('2026-09')['2026-09-30'].arrival, '09:49:48');
});

test('tracker: a hand-edited arrival in the month file is adopted', () => {
    const {store, clock, tracker} = setup();
    tracker.tick();
    const month = store.loadMonth('2026-09');
    month['2026-09-30'].arrival = '8:05';
    store.saveMonth('2026-09', month);
    clock.now = at(11, 0);
    tracker.stop();
    eq(tracker.arrival.getTime(), at(8, 5).getTime());
    eq(store.loadMonth('2026-09')['2026-09-30'].arrival, '08:05:00');
    clock.now = at(12, 6);
    eq(tracker.tick().map(m => m.title), ['⏱ 4h done']);
});

test('tracker: resetArrival wins over a pending hand edit', () => {
    const {store, clock, tracker} = setup();
    tracker.tick();
    const month = store.loadMonth('2026-09');
    month['2026-09-30'].arrival = '08:00:00';
    store.saveMonth('2026-09', month);
    clock.now = at(14, 0);
    tracker.resetArrival();
    eq(tracker.arrival.getTime(), at(14, 0).getTime());
    eq(store.loadMonth('2026-09')['2026-09-30'].arrival, '14:00:00');
});

function throwsUserError(fn, message) {
    try {
        fn();
    } catch (e) {
        ok(e instanceof UserError, `expected a UserError, got ${e}`);
        eq(e.message, message);
        return;
    }
    throw new Error(`expected "${message}"`);
}

test('tracker: history entries record breaks, fixed break and target', () => {
    const {store, tracker} = setup();
    tracker.tick();
    eq(store.loadMonth('2026-09')['2026-09-30'], {
        arrival: '09:49:48', departure: '10:43:00', breaks: [], openBreak: null,
        fixedBreak: ['12:30', '13:30'], targetMin: 480, workedMin: 53, overtimeMin: -427,
    });
});

test('tracker: start and finish a break; worked time excludes it', () => {
    const {store, clock, tracker} = setup({now: at(8, 0), boot: at(8, 0)});
    tracker.tick();
    clock.now = at(15, 10);
    tracker.startBreak();
    eq(store.loadMonth('2026-09')['2026-09-30'].openBreak, '15:10:00');
    clock.now = at(15, 40);
    const onBreak = tracker.view();
    eq([onBreak.onBreak, onBreak.openBreak, onBreak.workedMin, onBreak.leaveAt], [true, '15:10:00', 370, null]);
    tracker.finishBreak();
    const entry = store.loadMonth('2026-09')['2026-09-30'];
    eq([entry.openBreak, entry.breaks], [null, [['15:10:00', '15:40:00']]]);
    eq(tracker.view().leaveAt, '17:30', '8h + 1h fixed + 30min manual');
});

test('tracker: break actions refuse the wrong state', () => {
    const {tracker} = setup();
    tracker.tick();
    throwsUserError(() => tracker.finishBreak(), 'No break in progress');
    tracker.startBreak();
    throwsUserError(() => tracker.startBreak(), 'Already on a break');
});

test('tracker: work alerts pause during a break and move later after it', () => {
    const {clock, tracker} = setup({now: at(8, 0), boot: at(8, 0)});
    tracker.tick();
    clock.now = at(15, 0);
    tracker.tick();
    tracker.startBreak();
    clock.now = at(16, 30);
    eq(tracker.tick(), [], 'no 7h alert while on break');
    eq(tracker.view().next, {label: '7h', paused: true});
    tracker.finishBreak();
    clock.now = at(17, 29);
    eq(tracker.tick(), []);
    clock.now = at(17, 30);
    eq(tracker.tick().map(m => m.title), ['⏱ 7h done'], '16:00 + 1h30 of break');
});

test('tracker: an open break survives a restart', () => {
    const {store, clock, tracker} = setup();
    tracker.tick();
    clock.now = at(15, 10);
    tracker.startBreak();
    tracker.stop();
    const again = setup({store, now: at(15, 30), boot: at(15, 25)});
    again.tracker.tick();
    eq(again.tracker.view().openBreak, '15:10:00');
    again.tracker.finishBreak();
    eq(store.loadMonth('2026-09')['2026-09-30'].breaks, [['15:10:00', '15:30:00']]);
});

test('tracker: crossing midnight with an open break closes it at the last tick', () => {
    const {store, clock, tracker} = setup({now: day(30, 22, 0), boot: day(30, 9, 0)});
    tracker.tick();
    tracker.startBreak();
    clock.now = day(30, 22, 30);
    tracker.tick();
    clock.now = new Date(2026, 9, 1, 0, 0, 30);
    tracker.tick();
    const closed = store.loadMonth('2026-09')['2026-09-30'];
    eq([closed.openBreak, closed.breaks, closed.departure], [null, [['22:00:00', '22:30:00']], '22:30:00']);
    eq(tracker.view().onBreak, false, 'the new day starts without a break');
});

test('tracker: the fixed break switched off counts the lunch hour as work', () => {
    const cfg = configFrom({thresholds: ['8:00'], fixedBreak: false, breakStart: '12:30', breakEnd: '13:30', breakAlerts: true});
    const {store, clock, tracker} = setup({now: at(8, 0), boot: at(8, 0), cfg});
    tracker.tick();
    clock.now = at(16, 0);
    eq(tracker.tick().map(m => m.title), ['⏱ 8h done']);
    eq(store.loadMonth('2026-09')['2026-09-30'].fixedBreak, null);
});

test('tracker: setArrival moves arrival, clears fired alerts and refuses the future', () => {
    const {store, clock, tracker} = setup({now: at(12, 0), boot: at(8, 0)});
    eq(tracker.tick().map(m => m.title), ['⏱ 4h done']);
    tracker.setArrival('7:30');
    eq(store.loadMonth('2026-09')['2026-09-30'].arrival, '07:30:00');
    eq(store.loadState().fired, []);
    clock.now = at(12, 1);
    eq(tracker.tick().map(m => m.title), ['⏱ 4h done'], 'catch-up for the new arrival');
    throwsUserError(() => tracker.setArrival('13:00'), 'Arrival cannot be in the future');
    throwsUserError(() => tracker.setArrival('7h30'), 'Arrival: use H:MM');
});

test('tracker: saveDay edits a past day and keeps its own target', () => {
    const store = new FakeStore();
    store.saveMonth('2026-09', {'2026-09-29': {arrival: '08:02:00', departure: '17:40:00', targetMin: 420}});
    const {tracker} = setup({store});
    tracker.tick();
    tracker.saveDay('2026-09-29', {arrival: '8:00', departure: '17:00', breaks: [['15:00', '15:30']], fixedBreak: null});
    eq(store.loadMonth('2026-09')['2026-09-29'], {
        arrival: '08:00:00', departure: '17:00:00', breaks: [['15:00:00', '15:30:00']], openBreak: null,
        fixedBreak: null, targetMin: 420, workedMin: 510, overtimeMin: 90,
    });
    eq(store.loadMonth('2026-09')['2026-09-30'].arrival, '09:49:48', 'today untouched');
});

test('tracker: saveDay adds a missing day with the current target, in its own month', () => {
    const {store, tracker} = setup();
    tracker.tick();
    tracker.saveDay('2026-08-31', {arrival: '9:00', departure: '18:00', breaks: [], fixedBreak: ['12:30', '13:30']});
    eq(store.loadMonth('2026-08')['2026-08-31'].workedMin, 480);
    eq(store.loadMonth('2026-08')['2026-08-31'].targetMin, 480);
});

test('tracker: saveDay refuses invalid input and today', () => {
    const {tracker} = setup();
    tracker.tick();
    throwsUserError(() => tracker.saveDay('2026-09-29', {arrival: '9:00', departure: '8:00', breaks: []}),
        'Departure must be after arrival');
    throwsUserError(() => tracker.saveDay('2026-09-30', {arrival: '8:00', departure: '9:00', breaks: []}),
        'Today is edited on the Today page');
});

test('tracker: deleteDay removes past days only', () => {
    const store = new FakeStore();
    store.saveMonth('2026-09', {'2026-09-29': {arrival: '08:00:00', departure: '17:00:00'}});
    const {tracker} = setup({store});
    tracker.tick();
    tracker.deleteDay('2026-09-29');
    eq(Object.keys(store.loadMonth('2026-09')), ['2026-09-30']);
    throwsUserError(() => tracker.deleteDay('2026-09-29'), 'No entry for 2026-09-29');
    throwsUserError(() => tracker.deleteDay('2026-09-30'), 'Only past days can be deleted');
    throwsUserError(() => tracker.deleteDay('yesterday'), 'Invalid date');
});

test('tracker: a v1 entry for today (upgrade mid-day) keeps its arrival and gains v2 fields', () => {
    const store = new FakeStore();
    store.saveMonth('2026-09', {'2026-09-30': {arrival: '08:10:00', departure: '10:00:00', workedMin: 110}});
    const {tracker} = setup({store});
    tracker.tick();
    const entry = store.loadMonth('2026-09')['2026-09-30'];
    eq([entry.arrival, entry.breaks, entry.fixedBreak, entry.targetMin], ['08:10:00', [], ['12:30', '13:30'], 480]);
});

test('tracker: a past-day edit survives the next saves of today', () => {
    const store = new FakeStore();
    const {clock, tracker} = setup({store});
    tracker.tick();
    tracker.saveDay('2026-09-29', {arrival: '8:00', departure: '17:00', breaks: [], fixedBreak: ['12:30', '13:30']});
    for (let i = 1; i <= SAVE_EVERY_TICKS; i++) {
        clock.now = new Date(at(10, 43).getTime() + i * 60000);
        tracker.tick();
    }
    tracker.stop();
    eq(store.loadMonth('2026-09')['2026-09-29'].departure, '17:00:00');
});

test('tracker: settings changed mid-day apply to today only', () => {
    let cfg = CFG;
    const store = new FakeStore();
    store.saveMonth('2026-09', {'2026-09-29': {arrival: '08:00:00', departure: '17:00:00', fixedBreak: ['12:30', '13:30'], targetMin: 480}});
    const clock = {now: at(10, 0)};
    const tracker = new Tracker({store, config: () => cfg, now: () => clock.now, bootTime: () => at(8, 0)});
    tracker.tick();
    cfg = configFrom({thresholds: ['7:00'], fixedBreak: false, breakStart: '12:30', breakEnd: '13:30', breakAlerts: true});
    clock.now = at(11, 0);
    tracker.stop();
    const month = store.loadMonth('2026-09');
    eq([month['2026-09-30'].targetMin, month['2026-09-30'].fixedBreak], [420, null]);
    eq([month['2026-09-29'].targetMin, month['2026-09-29'].fixedBreak], [480, ['12:30', '13:30']]);
});

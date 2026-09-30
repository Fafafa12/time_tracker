import {eq, ok, test} from './harness.js';
import {configFrom} from '../time-tracker@anjrakot/lib/timecalc.js';
import {SAVE_EVERY_TICKS, Tracker} from '../time-tracker@anjrakot/lib/tracker.js';

const day = (d, h, m, s = 0) => new Date(2026, 8, d, h, m, s); // September 2026
const at = (h, m, s = 0) => day(30, h, m, s);
const CFG = configFrom({
    thresholds: ['4:00', '7:00', '7:45', '8:00'],
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
    eq([v.worked, v.remaining], [270, 210]);
    eq(v.next.label, '7h');
    eq(v.next.time.getTime(), at(16, 30).getTime());
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
    cfg = configFrom({thresholds: ['4:00', '6:00', '8:00'], breakStart: '12:30', breakEnd: '13:30', breakAlerts: false});
    clock.now = at(15, 1);
    eq(tracker.tick().map(m => m.title), ['⏱ 6h done'], 'new past threshold fires once');
    clock.now = at(15, 2);
    eq(tracker.tick(), []);
});

test('tracker: with no thresholds there are no work alerts and the view still works', () => {
    const cfg = configFrom({thresholds: [], breakStart: '12:30', breakEnd: '13:30', breakAlerts: false});
    const {clock, tracker} = setup({now: at(8, 0), boot: at(8, 0), cfg});
    tracker.tick();
    clock.now = at(18, 0);
    eq(tracker.tick(), []);
    const v = tracker.view();
    eq([v.worked, v.remaining, v.next], [540, 0, null]);
});

test('tracker: a failing store never throws from tick and view keeps working', () => {
    const store = new FakeStore();
    store._set = () => {
        throw new Error('disk full');
    };
    const {tracker} = setup({store});
    eq(tracker.tick(), []);
    eq(tracker.view().worked, 53);
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
    eq(tracker.view().worked, 0);
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

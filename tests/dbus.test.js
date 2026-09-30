import {eq, ok, test} from './harness.js';
import {FAILED, INVALID_ARGS} from '../time-tracker@anjrakot/lib/dbus-api.js';
import {TrackerService} from '../time-tracker@anjrakot/lib/dbus.js';
import {configFrom} from '../time-tracker@anjrakot/lib/timecalc.js';
import {Tracker} from '../time-tracker@anjrakot/lib/tracker.js';

const at = (h, m, s = 0) => new Date(2026, 8, 30, h, m, s);
const CFG = configFrom({thresholds: ['4:00', '8:00'], fixedBreak: true, breakStart: '12:30', breakEnd: '13:30', breakAlerts: true});

// Records what a handler answered, like a Gio.DBusMethodInvocation.
class FakeInvocation {
    return_value(variant) {
        this.value = variant === null ? null : variant.deepUnpack();
    }

    return_dbus_error(name, message) {
        this.error = {name, message};
    }
}

class MemoryStore {
    constructor() {
        this.files = {};
    }

    loadMonth(m) {
        return JSON.parse(this.files[m] ?? '{}');
    }

    saveMonth(m, d) {
        this.files[m] = JSON.stringify(d);
    }

    loadState() {
        return JSON.parse(this.files.state ?? '{}');
    }

    saveState(s) {
        this.files.state = JSON.stringify(s);
    }
}

function setup() {
    const clock = {now: at(10, 0)};
    const store = new MemoryStore();
    const tracker = new Tracker({store, config: () => CFG, now: () => clock.now, bootTime: () => at(8, 0)});
    let changes = 0;
    const service = new TrackerService({tracker: () => tracker, onChanged: () => changes++});
    const call = (method, ...args) => {
        const invocation = new FakeInvocation();
        service[`${method}Async`](args, invocation);
        return invocation;
    };
    return {clock, store, tracker, call, changes: () => changes};
}

test('dbus: GetToday returns today as JSON and is not a change', () => {
    const {call, changes} = setup();
    const inv = call('GetToday');
    const today = JSON.parse(inv.value[0]);
    eq([today.date, today.arrival, today.workedMin, today.onBreak], ['2026-09-30', '08:00:00', 120, false]);
    eq(changes(), 0);
});

test('dbus: actions answer with no value and signal a change', () => {
    const {call, changes, clock} = setup();
    eq(call('StartBreak').value, null);
    clock.now = at(10, 20);
    eq(call('FinishBreak').value, null);
    eq(call('SetArrival', '7:45').value, null);
    eq(call('ResetArrival').value, null);
    eq(changes(), 4);
});

test('dbus: refused actions return InvalidArgs with the readable message', () => {
    const {call, changes} = setup();
    eq(call('FinishBreak').error, {name: INVALID_ARGS, message: 'No break in progress'});
    eq(call('SaveDay', '2026-09-29', 'not json').error, {name: INVALID_ARGS, message: 'Invalid day data'});
    eq(call('SaveDay', '2026-09-29', JSON.stringify({arrival: '9:00', departure: '8:00', breaks: []})).error.message,
        'Departure must be after arrival');
    eq(call('DeleteDay', '2026-09-30').error.name, INVALID_ARGS);
    eq(changes(), 0);
});

test('dbus: SaveDay and DeleteDay change past days', () => {
    const {call, store} = setup();
    const day = {arrival: '8:00', departure: '16:30', breaks: [], fixedBreak: ['12:30', '13:30']};
    eq(call('SaveDay', '2026-09-29', JSON.stringify(day)).value, null);
    eq(store.loadMonth('2026-09')['2026-09-29'].workedMin, 450);
    eq(call('DeleteDay', '2026-09-29').value, null);
    ok(!('2026-09-29' in store.loadMonth('2026-09')));
});

test('dbus: unexpected errors return Failed', () => {
    const {call, store} = setup();
    store.saveMonth = () => {
        throw new Error('disk full');
    };
    eq(call('SaveDay', '2026-09-29', JSON.stringify({arrival: '8:00', departure: '9:00', breaks: []})).error,
        {name: FAILED, message: 'disk full'});
});

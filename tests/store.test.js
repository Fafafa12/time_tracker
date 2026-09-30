import GLib from 'gi://GLib';
import {eq, ok, test} from './harness.js';
import {parseBootTime, resolveHistoryDir, Store} from '../time-tracker@anjrakot/lib/store.js';

const tempStore = () => new Store(GLib.dir_make_tmp('time-tracker-XXXXXX'));
const path = (store, name) => GLib.build_filenamev([store.dir, name]);
const writeRaw = (store, name, text) => GLib.file_set_contents(path(store, name), text);
const exists = (store, name) => GLib.file_test(path(store, name), GLib.FileTest.EXISTS);

test('store: missing files read as empty objects', () => {
    const store = tempStore();
    eq(store.loadMonth('2026-09'), {});
    eq(store.loadState(), {});
});

test('store: month and state round-trip', () => {
    const store = tempStore();
    const month = {'2026-09-30': {arrival: '09:49:48', departure: '18:02:10', workedMin: 432}};
    store.saveMonth('2026-09', month);
    store.saveState({date: '2026-09-30', fired: ['w240']});
    eq(store.loadMonth('2026-09'), month);
    eq(store.loadState(), {date: '2026-09-30', fired: ['w240']});
    ok(exists(store, '2026-09.json'));
});

test('store: creates a missing folder on write', () => {
    const store = new Store(GLib.build_filenamev([GLib.dir_make_tmp('time-tracker-XXXXXX'), 'a', 'b']));
    store.saveState({date: '2026-09-30', fired: []});
    eq(store.loadState(), {date: '2026-09-30', fired: []});
});

test('store: corrupt JSON is moved to .bak and reads as empty', () => {
    const store = tempStore();
    writeRaw(store, 'state.json', '{"date": "2026-09-30", "fir');
    eq(store.loadState(), {});
    ok(exists(store, 'state.json.bak'), 'backup kept');
    ok(!exists(store, 'state.json'), 'corrupt file moved away');
});

test('store: JSON that is not an object is treated as corrupt', () => {
    const store = tempStore();
    writeRaw(store, '2026-09.json', '[1, 2, 3]');
    eq(store.loadMonth('2026-09'), {});
    ok(exists(store, '2026-09.json.bak'));
});

test('parseBootTime reads the btime line of /proc/stat', () => {
    eq(parseBootTime('cpu  1 2 3\nbtime 1790750988\nprocesses 42\n').getTime(), 1790750988000);
    eq(parseBootTime('cpu  1 2 3\n'), null);
});

test('resolveHistoryDir: default, ~ expansion, absolute', () => {
    const def = GLib.build_filenamev([GLib.get_user_data_dir(), 'time_tracker']);
    eq(resolveHistoryDir(''), def);
    eq(resolveHistoryDir('   '), def);
    eq(resolveHistoryDir('~/work/hours'), GLib.build_filenamev([GLib.get_home_dir(), 'work/hours']));
    eq(resolveHistoryDir('/srv/hours'), '/srv/hours');
});

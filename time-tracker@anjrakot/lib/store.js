// Filesystem access: JSON files in the history folder, plus the system boot time.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const STATE_FILE = 'state.json';

/** Settings value -> absolute folder. Empty = ~/.local/share/time_tracker, "~/" expanded. */
export function resolveHistoryDir(setting) {
    const value = (setting ?? '').trim();
    if (value === '')
        return GLib.build_filenamev([GLib.get_user_data_dir(), 'time_tracker']);
    if (value === '~' || value.startsWith('~/'))
        return GLib.build_filenamev([GLib.get_home_dir(), value.slice(1)]);
    return value;
}

/** Contents of /proc/stat -> boot Date, or null if there is no btime line. */
export function parseBootTime(procStat) {
    const m = /^btime\s+(\d+)$/m.exec(procStat);
    return m ? new Date(Number(m[1]) * 1000) : null;
}

/** The system boot time, or null if it cannot be read. */
export function readBootTime() {
    try {
        const [, bytes] = GLib.file_get_contents('/proc/stat');
        return parseBootTime(new TextDecoder().decode(bytes));
    } catch (e) {
        console.error(`[time-tracker] cannot read boot time: ${e}`);
        return null;
    }
}

export class Store {
    /** `readOnly` (the app): never writes, and leaves invalid files where they are. */
    constructor(dir, {readOnly = false} = {}) {
        this.dir = dir;
        this.readOnly = readOnly;
    }

    loadMonth(month) {
        return this._read(`${month}.json`);
    }

    saveMonth(month, data) {
        this._write(`${month}.json`, data);
    }

    loadState() {
        return this._read(STATE_FILE);
    }

    saveState(state) {
        this._write(STATE_FILE, state);
    }

    /**
     * Missing file -> {}. Invalid or non-object JSON -> moved to a new
     * <name>.<timestamp>.bak (never overwriting an older backup), then {}.
     * Any other read error is thrown and the file is left untouched.
     */
    _read(name) {
        const path = GLib.build_filenamev([this.dir, name]);
        const file = Gio.File.new_for_path(path);
        let bytes;
        try {
            [, bytes] = file.load_contents(null);
        } catch (e) {
            if (e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                return {};
            throw e;
        }
        try {
            const data = JSON.parse(new TextDecoder().decode(bytes));
            if (typeof data !== 'object' || data === null || Array.isArray(data))
                throw new Error('not a JSON object');
            return data;
        } catch (e) {
            if (this.readOnly) {
                console.error(`[time-tracker] invalid ${path}: ${e}`);
                return {};
            }
            const backup = this._backupPath(path);
            console.error(`[time-tracker] invalid ${path}, moving it to ${backup}: ${e}`);
            // Throws if the backup cannot be made, so the invalid file is never overwritten.
            file.move(Gio.File.new_for_path(backup), Gio.FileCopyFlags.NONE, null, null);
            return {};
        }
    }

    _backupPath(path) {
        const stamp = GLib.DateTime.new_now_local().format('%Y%m%d-%H%M%S');
        let backup = `${path}.${stamp}.bak`;
        for (let n = 1; GLib.file_test(backup, GLib.FileTest.EXISTS); n++)
            backup = `${path}.${stamp}-${n}.bak`;
        return backup;
    }

    /** Atomic: replace_contents writes a temporary file and renames it over the target. */
    _write(name, data) {
        if (this.readOnly)
            throw new Error('read-only store');
        GLib.mkdir_with_parents(this.dir, 0o755);
        const file = Gio.File.new_for_path(GLib.build_filenamev([this.dir, name]));
        const bytes = new TextEncoder().encode(`${JSON.stringify(data, null, 2)}\n`);
        file.replace_contents(bytes, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
    }
}

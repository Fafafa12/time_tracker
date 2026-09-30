// App-side data access: the extension's settings (read-only) and the history files.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {readDay} from '../time-tracker@anjrakot/lib/day.js';
import {monthsIn} from '../time-tracker@anjrakot/lib/stats.js';
import {resolveHistoryDir, Store} from '../time-tracker@anjrakot/lib/store.js';

export const APP_DIR = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
export const EXTENSION_UUID = 'time-tracker@anjrakot';
const SCHEMA_ID = 'org.gnome.shell.extensions.time-tracker';

/** The extension's GSettings (from its own compiled schema), or null if unavailable. */
export function openExtensionSettings() {
    const dir = GLib.build_filenamev([APP_DIR, '..', EXTENSION_UUID, 'schemas']);
    try {
        const source = Gio.SettingsSchemaSource.new_from_directory(dir, Gio.SettingsSchemaSource.get_default(), false);
        const schema = source.lookup(SCHEMA_ID, false);
        return schema ? new Gio.Settings({settings_schema: schema}) : null;
    } catch (e) {
        console.error(`[time-tracker] cannot read settings: ${e}`);
        return null;
    }
}

/** Read-only access to the month files; the extension is the only writer. */
export class History {
    constructor(settings) {
        this._settings = settings;
    }

    get dir() {
        return resolveHistoryDir(this._settings?.get_string('history-dir') ?? '');
    }

    /** Days of one month ("YYYY-MM"), oldest first. */
    month(key) {
        let data = {};
        try {
            data = new Store(this.dir, {readOnly: true}).loadMonth(key);
        } catch (e) {
            console.error(`[time-tracker] cannot read ${key}: ${e}`);
        }
        return Object.keys(data).sort().map(date => readDay(date, data[date])).filter(Boolean);
    }

    /** Days of every month a range touches. */
    range(range) {
        return monthsIn(range).flatMap(key => this.month(key));
    }
}

// D-Bus client for the extension's TrackerService.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {BUS_NAME, INTERFACE_XML, OBJECT_PATH} from '../time-tracker@anjrakot/lib/dbus-api.js';

const TrackerProxy = Gio.DBusProxy.makeProxyWrapper(INTERFACE_XML);

export class TrackerClient {
    constructor() {
        this._listeners = new Set();
        this._proxy = new TrackerProxy(Gio.DBus.session, BUS_NAME, OBJECT_PATH, null, null,
            Gio.DBusProxyFlags.DO_NOT_AUTO_START | Gio.DBusProxyFlags.DO_NOT_LOAD_PROPERTIES);
        this._proxy.connect('notify::g-name-owner', () => this._emit());
        this._proxy.connectSignal('Changed', () => this._emit());
    }

    /** True while the extension is running and owns the service name. */
    get online() {
        return this._proxy.g_name_owner !== null;
    }

    /** `fn()` runs when the extension appears, disappears or reports a change. */
    onChange(fn) {
        this._listeners.add(fn);
    }

    _emit() {
        for (const fn of this._listeners)
            fn();
    }

    /** Tracker.view() of the running extension. */
    async today() {
        const [json] = await this._proxy.GetTodayAsync();
        return JSON.parse(json);
    }

    /** Call an action; a refusal rejects with an Error carrying the extension's message. */
    async call(method, ...args) {
        try {
            await this._proxy[`${method}Async`](...args);
        } catch (e) {
            if (e instanceof GLib.Error)
                Gio.DBusError.strip_remote_error(e);
            throw new Error(e.message);
        }
    }
}

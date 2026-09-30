// The extension's D-Bus service: thin wrappers around Tracker actions.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {BUS_NAME, FAILED, INTERFACE_XML, INVALID_ARGS, OBJECT_PATH} from './dbus-api.js';
import {UserError} from './tracker.js';

export class TrackerService {
    /**
     * @param {object} deps
     * @param {() => import('./tracker.js').Tracker} deps.tracker  the current tracker
     * @param {() => void} deps.onChanged  called after every successful change
     */
    constructor({tracker, onChanged}) {
        this._tracker = tracker;
        this._onChanged = onChanged;
        this._impl = null;
        this._nameId = 0;
    }

    export(connection = Gio.DBus.session) {
        this._impl = Gio.DBusExportedObject.wrapJSObject(INTERFACE_XML, this);
        this._impl.export(connection, OBJECT_PATH);
        this._nameId = Gio.bus_own_name_on_connection(connection, BUS_NAME, Gio.BusNameOwnerFlags.NONE, null, null);
    }

    unexport() {
        if (this._nameId) {
            Gio.bus_unown_name(this._nameId);
            this._nameId = 0;
        }
        this._impl?.unexport();
        this._impl = null;
    }

    emitChanged(date) {
        this._impl?.emit_signal('Changed', new GLib.Variant('(s)', [date]));
    }

    GetTodayAsync(_params, invocation) {
        this._reply(invocation, () => JSON.stringify(this._tracker().view()), false);
    }

    StartBreakAsync(_params, invocation) {
        this._reply(invocation, () => this._tracker().startBreak());
    }

    FinishBreakAsync(_params, invocation) {
        this._reply(invocation, () => this._tracker().finishBreak());
    }

    SetArrivalAsync([time], invocation) {
        this._reply(invocation, () => this._tracker().setArrival(time));
    }

    ResetArrivalAsync(_params, invocation) {
        this._reply(invocation, () => this._tracker().resetArrival());
    }

    SaveDayAsync([date, day], invocation) {
        this._reply(invocation, () => {
            let input;
            try {
                input = JSON.parse(day);
            } catch {
                throw new UserError('Invalid day data');
            }
            this._tracker().saveDay(date, input);
        });
    }

    DeleteDayAsync([date], invocation) {
        this._reply(invocation, () => this._tracker().deleteDay(date));
    }

    /** Run an action; answer with its string result (or nothing) or a D-Bus error. */
    _reply(invocation, action, changes = true) {
        let result;
        try {
            result = action();
        } catch (e) {
            if (e instanceof UserError) {
                invocation.return_dbus_error(INVALID_ARGS, e.message);
            } else {
                console.error(`[time-tracker] D-Bus call failed: ${e}\n${e?.stack ?? ''}`);
                invocation.return_dbus_error(FAILED, String(e?.message ?? e));
            }
            return;
        }
        invocation.return_value(typeof result === 'string' ? new GLib.Variant('(s)', [result]) : null);
        if (changes)
            this._onChanged();
    }
}

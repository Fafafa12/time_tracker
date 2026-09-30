// Entry point: wires settings, the tracker, the top-bar indicator, notifications and D-Bus.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {TrackerService} from './lib/dbus.js';
import {TrackerIndicator} from './lib/indicator.js';
import {readBootTime, resolveHistoryDir, Store} from './lib/store.js';
import {configFrom} from './lib/timecalc.js';
import {Tracker} from './lib/tracker.js';

const TICK_SECONDS = 60;
const ICON = 'preferences-system-time-symbolic';
const APP_DESKTOP_ID = 'io.github.fafafa12.TimeTracker.desktop';

export default class TimeTrackerExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._config = this._readConfig();
        this._historyDir = resolveHistoryDir(this._settings.get_string('history-dir'));
        this._tracker = new Tracker({
            store: new Store(this._historyDir),
            config: () => this._config,
            now: () => new Date(),
            bootTime: readBootTime,
        });

        this._indicator = new TrackerIndicator({
            onToggleBreak: () => this._action(() => {
                if (this._tracker.view().onBreak)
                    this._tracker.finishBreak();
                else
                    this._tracker.startBreak();
            }),
            onOpenApp: () => this._safe(() => this._openApp()),
            onReset: () => this._action(() => this._tracker.resetArrival()),
            onOpenFolder: () => this._safe(() => this._openFolder()),
            onSettings: () => this._safe(() => this.openPreferences()),
        });
        Main.panel.addToStatusArea(this.uuid, this._indicator);

        this._service = new TrackerService({tracker: () => this._tracker, onChanged: () => this._refresh()});
        this._safe(() => this._service.export());

        this._settingsId = this._settings.connect('changed', (_s, key) => this._safe(() => this._onSettingChanged(key)));
        // Logout and power-off end the Shell without calling disable().
        this._shutdownId = global.connect('shutdown', () => this._safe(() => this._tracker.stop()));

        this._refresh();
        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, TICK_SECONDS, () => {
            this._refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    disable() {
        if (this._timeoutId) {
            GLib.Source.remove(this._timeoutId);
            this._timeoutId = 0;
        }
        if (this._settingsId) {
            this._settings.disconnect(this._settingsId);
            this._settingsId = 0;
        }
        if (this._shutdownId) {
            global.disconnect(this._shutdownId);
            this._shutdownId = 0;
        }
        this._safe(() => this._service?.unexport());
        this._safe(() => this._tracker?.stop());
        this._indicator?.destroy();
        this._source?.destroy();
        this._service = null;
        this._indicator = null;
        this._source = null;
        this._tracker = null;
        this._settings = null;
    }

    _readConfig() {
        return configFrom({
            thresholds: this._settings.get_strv('alert-thresholds'),
            fixedBreak: this._settings.get_boolean('fixed-break'),
            breakStart: this._settings.get_string('break-start'),
            breakEnd: this._settings.get_string('break-end'),
            breakAlerts: this._settings.get_boolean('break-alerts'),
        });
    }

    _onSettingChanged(key) {
        if (key === 'test-notification') {
            this._notify({title: '⏱ Time Tracker', body: 'Test notification: alerts are working', urgent: false});
            return;
        }
        if (key === 'history-dir') {
            this._historyDir = resolveHistoryDir(this._settings.get_string('history-dir'));
            this._tracker.moveTo(new Store(this._historyDir));
        }
        this._config = this._readConfig();
        this._refresh();
    }

    /** A menu action; refused actions (e.g. no break in progress) are shown as a notification. */
    _action(fn) {
        try {
            fn();
        } catch (e) {
            this._notify({title: '⏱ Time Tracker', body: String(e?.message ?? e), urgent: false});
        }
        this._refresh();
    }

    /** One tick: send due notifications, update the label, tell the app. Never throws. */
    _refresh() {
        this._safe(() => {
            for (const message of this._tracker.tick())
                this._notify(message);
        });
        this._safe(() => {
            const view = this._tracker.view();
            this._indicator.update(view);
            this._service?.emitChanged(view.date);
        });
    }

    _notify({title, body, urgent}) {
        if (!this._source) {
            this._source = new MessageTray.Source({title: 'Time Tracker', iconName: ICON});
            this._source.connect('destroy', () => {
                this._source = null;
            });
            Main.messageTray.add(this._source);
        }
        const urgency = urgent ? MessageTray.Urgency.CRITICAL : MessageTray.Urgency.NORMAL;
        this._source.addNotification(new MessageTray.Notification({source: this._source, title, body, urgency}));
    }

    _openApp() {
        const app = Gio.DesktopAppInfo.new(APP_DESKTOP_ID);
        if (!app) {
            this._notify({title: '⏱ Time Tracker', body: 'The Time Tracker app is not installed: run install.sh', urgent: false});
            return;
        }
        app.launch([], global.create_app_launch_context(0, -1));
    }

    _openFolder() {
        GLib.mkdir_with_parents(this._historyDir, 0o755);
        Gio.AppInfo.launch_default_for_uri(GLib.filename_to_uri(this._historyDir, null), global.create_app_launch_context(0, -1));
    }

    _safe(fn) {
        try {
            return fn();
        } catch (e) {
            console.error(`[time-tracker] ${e}\n${e?.stack ?? ''}`);
            return undefined;
        }
    }
}

// Settings window (runs in its own process, not in GNOME Shell).
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {formatHM, parseHM, parseThresholds} from './lib/timecalc.js';

const isThreshold = text => (parseHM(text) ?? 0) > 0;

function markValid(row, valid) {
    if (valid)
        row.remove_css_class('error');
    else
        row.add_css_class('error');
}

export default class TimeTrackerPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window._settings = settings; // keep alive as long as the window

        const page = new Adw.PreferencesPage({title: 'Time Tracker', iconName: 'preferences-system-time-symbolic'});
        page.add(this._alertsGroup(settings));
        page.add(this._breakGroup(settings));
        page.add(this._historyGroup(settings));
        window.add(page);
    }

    _alertsGroup(settings) {
        const group = new Adw.PreferencesGroup({
            title: 'Work alerts',
            description: 'Time worked (H:MM) at which to notify. The largest one is the end of the day. Press ✓ to save.',
        });
        const rows = [];

        const save = () => {
            const values = rows.map(r => r.text).filter(isThreshold);
            settings.set_strv('alert-thresholds', parseThresholds(values).map(formatHM));
        };

        const addRow = text => {
            const row = new Adw.EntryRow({title: 'Alert after', text, showApplyButton: true});
            const remove = new Gtk.Button({iconName: 'user-trash-symbolic', valign: Gtk.Align.CENTER, cssClasses: ['flat']});
            remove.connect('clicked', () => {
                rows.splice(rows.indexOf(row), 1);
                group.remove(row);
                save();
            });
            row.add_suffix(remove);
            row.connect('changed', () => markValid(row, row.text === '' || isThreshold(row.text)));
            row.connect('apply', save);
            rows.push(row);
            group.add(row);
            return row;
        };

        settings.get_strv('alert-thresholds').forEach(addRow);

        const add = new Gtk.Button({iconName: 'list-add-symbolic', valign: Gtk.Align.CENTER, cssClasses: ['flat']});
        add.connect('clicked', () => addRow('').grab_focus());
        group.set_header_suffix(add);
        return group;
    }

    _breakGroup(settings) {
        const group = new Adw.PreferencesGroup({title: 'Break', description: 'Not counted as work time. Press ✓ to save.'});
        const start = new Adw.EntryRow({title: 'Break start (HH:MM)', text: settings.get_string('break-start'), showApplyButton: true});
        const end = new Adw.EntryRow({title: 'Break end (HH:MM)', text: settings.get_string('break-end'), showApplyButton: true});

        const validate = () => {
            const s = parseHM(start.text);
            const e = parseHM(end.text);
            const valid = s !== null && e !== null && e > s;
            markValid(start, valid);
            markValid(end, valid);
            return valid ? [s, e] : null;
        };
        const apply = () => {
            const range = validate();
            if (!range)
                return;
            settings.set_string('break-start', formatHM(range[0]));
            settings.set_string('break-end', formatHM(range[1]));
        };
        for (const row of [start, end]) {
            row.connect('changed', validate);
            row.connect('apply', apply);
            group.add(row);
        }

        const alerts = new Adw.SwitchRow({title: 'Break alerts', subtitle: 'Notify at break start and end'});
        settings.bind('break-alerts', alerts, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(alerts);
        return group;
    }

    _historyGroup(settings) {
        const group = new Adw.PreferencesGroup({title: 'History'});
        const dir = new Adw.EntryRow({
            title: 'History folder (empty = ~/.local/share/time_tracker)',
            text: settings.get_string('history-dir'),
            showApplyButton: true,
        });
        dir.connect('apply', () => settings.set_string('history-dir', dir.text.trim()));
        group.add(dir);

        const test = new Adw.ActionRow({title: 'Test notification', subtitle: 'Check that alerts appear'});
        const send = new Gtk.Button({label: 'Send', valign: Gtk.Align.CENTER});
        send.connect('clicked', () => settings.set_uint('test-notification', settings.get_uint('test-notification') + 1));
        test.add_suffix(send);
        group.add(test);
        return group;
    }
}

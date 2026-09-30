// Edit a past day, or add a missing one. Checks with day.validateDay as you type;
// Save sends SaveDay to the extension (the only writer).
import Adw from 'gi://Adw?version=1';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';

import {
    DEFAULT_TARGET_MIN, computeDay, dayFromInput, inputFromDay, validateDay,
} from '../time-tracker@anjrakot/lib/day.js';
import {dateFromKey, dateKey, formatDuration, formatSigned} from '../time-tracker@anjrakot/lib/timecalc.js';

const LONG_DATE = {weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'};

function timeEntry(text) {
    return new Gtk.Entry({text, max_width_chars: 5, width_chars: 5, valign: Gtk.Align.CENTER, xalign: 0.5});
}

function markError(widget, bad) {
    if (bad)
        widget.add_css_class('error');
    else
        widget.remove_css_class('error');
}

export const DayDialog = GObject.registerClass(
class DayDialog extends Adw.Dialog {
    /**
     * @param {object} ctx  window context
     * @param {object|null} day  the Day to edit, or null to add one
     * @param {string} defaultDate  "YYYY-MM-DD" proposed when adding
     */
    _init(ctx, day, defaultDate) {
        const adding = day === null;
        super._init({title: adding ? 'Add a day' : 'Edit day', content_width: 400});
        this._ctx = ctx;
        this._adding = adding;
        this._key = adding ? defaultDate : day.date;
        this._target = day?.targetMin ?? DEFAULT_TARGET_MIN;
        const input = adding
            ? {arrival: '8:00', departure: '16:30', breaks: [], fixedBreak: ['12:30', '13:30']}
            : inputFromDay(day);

        const header = new Adw.HeaderBar({show_end_title_buttons: false, show_start_title_buttons: false});
        const cancel = new Gtk.Button({label: 'Cancel'});
        cancel.connect('clicked', () => this.close());
        this._save = new Gtk.Button({label: 'Save', css_classes: ['suggested-action']});
        this._save.connect('clicked', () => this._onSave());
        header.pack_start(cancel);
        header.pack_end(this._save);

        const page = new Adw.PreferencesPage();
        this._summary = new Gtk.Label({wrap: true, css_classes: ['title-4'], margin_bottom: 4});
        const top = new Adw.PreferencesGroup({
            title: adding ? 'New day' : dateFromKey(this._key).toLocaleDateString(undefined, LONG_DATE),
        });
        top.set_header_suffix(this._summary);
        if (adding) {
            this._date = new Adw.EntryRow({title: 'Date (YYYY-MM-DD)', text: this._key});
            this._date.connect('changed', () => this._check());
            top.add(this._date);
        }
        this._arrival = new Adw.EntryRow({title: 'Arrival (H:MM)', text: input.arrival});
        this._departure = new Adw.EntryRow({title: 'Departure (H:MM)', text: input.departure});
        for (const row of [this._arrival, this._departure]) {
            row.connect('changed', () => this._check());
            top.add(row);
        }
        page.add(top);

        const fixed = new Adw.PreferencesGroup({title: 'Fixed break'});
        this._fixedOn = new Adw.SwitchRow({title: 'Fixed break this day', active: input.fixedBreak !== null});
        this._fixedStart = new Adw.EntryRow({title: 'Start (H:MM)', text: input.fixedBreak?.[0] ?? '12:30'});
        this._fixedEnd = new Adw.EntryRow({title: 'End (H:MM)', text: input.fixedBreak?.[1] ?? '13:30'});
        this._fixedOn.connect('notify::active', () => this._check());
        fixed.add(this._fixedOn);
        for (const row of [this._fixedStart, this._fixedEnd]) {
            this._fixedOn.bind_property('active', row, 'sensitive', GObject.BindingFlags.SYNC_CREATE);
            row.connect('changed', () => this._check());
            fixed.add(row);
        }
        page.add(fixed);

        this._breaksGroup = new Adw.PreferencesGroup({title: 'Breaks'});
        const add = new Gtk.Button({icon_name: 'list-add-symbolic', css_classes: ['flat'], tooltip_text: 'Add break'});
        add.connect('clicked', () => {
            this._addBreak('15:00', '15:15');
            this._check();
        });
        this._breaksGroup.set_header_suffix(add);
        this._breakRows = [];
        input.breaks.forEach(([s, e]) => this._addBreak(s, e));
        page.add(this._breaksGroup);

        if (!adding) {
            const danger = new Adw.PreferencesGroup();
            const del = new Gtk.Button({label: 'Delete day', css_classes: ['destructive-action', 'pill'], halign: Gtk.Align.CENTER});
            del.connect('clicked', () => this._confirmDelete());
            danger.add(del);
            page.add(danger);
        }

        const view = new Adw.ToolbarView({content: page});
        view.add_top_bar(header);
        this.set_child(view);
        this._check();
    }

    _addBreak(start, end) {
        const row = new Adw.ActionRow({title: `Break ${this._breakRows.length + 1}`});
        const s = timeEntry(start);
        const e = timeEntry(end);
        const remove = new Gtk.Button({icon_name: 'user-trash-symbolic', css_classes: ['flat'], valign: Gtk.Align.CENTER});
        row.add_suffix(s);
        row.add_suffix(new Gtk.Label({label: '–'}));
        row.add_suffix(e);
        row.add_suffix(remove);
        const item = {row, s, e};
        remove.connect('clicked', () => {
            this._breakRows.splice(this._breakRows.indexOf(item), 1);
            this._breaksGroup.remove(row);
            this._breakRows.forEach((b, i) => (b.row.title = `Break ${i + 1}`));
            this._check();
        });
        s.connect('changed', () => this._check());
        e.connect('changed', () => this._check());
        this._breakRows.push(item);
        this._breaksGroup.add(row);
    }

    _input() {
        return {
            arrival: this._arrival.text.trim(),
            departure: this._departure.text.trim(),
            breaks: this._breakRows.map(b => [b.s.text.trim(), b.e.text.trim()]),
            fixedBreak: this._fixedOn.active ? [this._fixedStart.text.trim(), this._fixedEnd.text.trim()] : null,
        };
    }

    _currentKey() {
        return this._adding ? this._date.text.trim() : this._key;
    }

    /** Validate, mark fields, update the live summary and the Save button. */
    _check() {
        const input = this._input();
        const key = this._currentKey();
        const exists = this._adding && this._ctx.history.month(key.slice(0, 7)).some(d => d.date === key);
        const errors = validateDay(input, key, new Date(), {adding: this._adding, exists});
        const fields = new Set(errors.map(e => e.field));
        if (this._adding)
            markError(this._date, fields.has('date'));
        markError(this._arrival, fields.has('arrival'));
        markError(this._departure, fields.has('departure'));
        markError(this._fixedStart, fields.has('fixedBreak'));
        markError(this._fixedEnd, fields.has('fixedBreak'));
        this._breakRows.forEach((b, i) => {
            markError(b.s, fields.has(`breaks.${i}`));
            markError(b.e, fields.has(`breaks.${i}`));
        });
        this._save.sensitive = errors.length === 0 && this._ctx.client.online;
        if (errors.length) {
            this._summary.label = errors[0].message;
            this._summary.css_classes = ['error-text'];
            return;
        }
        const {workedMin, overtimeMin} = computeDay(dayFromInput(key, input, this._target));
        this._summary.label = `${formatDuration(workedMin)} · ${formatSigned(overtimeMin)}`;
        this._summary.css_classes = ['title-4'];
    }

    async _onSave() {
        this._save.sensitive = false;
        if (await this._ctx.run('SaveDay', this._currentKey(), JSON.stringify(this._input())))
            this.close();
        else
            this._check();
    }

    _confirmDelete() {
        const dialog = new Adw.AlertDialog({heading: 'Delete this day?', body: 'Its arrival, departure and breaks are removed from the history.'});
        dialog.add_response('cancel', 'Cancel');
        dialog.add_response('delete', 'Delete');
        dialog.set_response_appearance('delete', Adw.ResponseAppearance.DESTRUCTIVE);
        dialog.connect('response', async (_d, id) => {
            if (id === 'delete' && await this._ctx.run('DeleteDay', this._key))
                this.close();
        });
        dialog.present(this);
    }
});

/** Yesterday's date key: the default when adding a day. */
export function yesterdayKey(now = new Date()) {
    return dateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
}

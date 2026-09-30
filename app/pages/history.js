// History: one month at a time, one row per day (newest first); click to edit, "＋ Add day".
import Adw from 'gi://Adw?version=1';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';

import {computeDay} from '../../time-tracker@anjrakot/lib/day.js';
import {dateKey, formatClock, formatDuration, formatSigned, monthKey} from '../../time-tracker@anjrakot/lib/timecalc.js';
import {DayDialog, yesterdayKey} from '../dayDialog.js';
import {pastDaysKey} from '../signatures.js';

const MONTH_TITLE = {month: 'long', year: 'numeric'};
const WEEKDAY = {weekday: 'short'};

function summaryChip(title) {
    const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, css_classes: ['summary-chip'], hexpand: true});
    box.append(new Gtk.Label({label: title, css_classes: ['caption', 'dim-label']}));
    const value = new Gtk.Label({css_classes: ['summary-value']});
    box.append(value);
    return {box, value};
}

export const HistoryPage = GObject.registerClass(
class HistoryPage extends Gtk.ScrolledWindow {
    _init(ctx) {
        super._init({hscrollbar_policy: Gtk.PolicyType.NEVER});
        this._ctx = ctx;
        const now = new Date();
        this._month = new Date(now.getFullYear(), now.getMonth(), 1);

        const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 12,
            margin_top: 16, margin_bottom: 24, margin_start: 16, margin_end: 16});
        this.set_child(new Adw.Clamp({maximum_size: 560, child: box}));

        const nav = new Gtk.CenterBox();
        const prev = new Gtk.Button({icon_name: 'go-previous-symbolic', css_classes: ['circular']});
        this._next = new Gtk.Button({icon_name: 'go-next-symbolic', css_classes: ['circular']});
        this._title = new Gtk.Label({css_classes: ['title-3']});
        prev.connect('clicked', () => this._shift(-1));
        this._next.connect('clicked', () => this._shift(1));
        nav.set_start_widget(prev);
        nav.set_center_widget(this._title);
        nav.set_end_widget(this._next);
        box.append(nav);

        const chips = new Gtk.Box({spacing: 8, homogeneous: true});
        this._days = summaryChip('Days');
        this._worked = summaryChip('Worked');
        this._overtime = summaryChip('Overtime');
        for (const chip of [this._days, this._worked, this._overtime])
            chips.append(chip.box);
        box.append(chips);

        this._add = new Gtk.Button({label: '＋ Add day', css_classes: ['pill'], halign: Gtk.Align.CENTER});
        this._add.connect('clicked', () => this.openAddDay());
        box.append(this._add);

        this._list = new Gtk.ListBox({css_classes: ['boxed-list'], selection_mode: Gtk.SelectionMode.NONE});
        this._list.set_placeholder(new Gtk.Label({label: 'No days recorded this month', margin_top: 24, margin_bottom: 24, css_classes: ['dim-label']}));
        box.append(this._list);
    }

    openAddDay() {
        new DayDialog(this._ctx, null, yesterdayKey()).present(this._ctx.window);
    }

    _shift(step) {
        this._month = new Date(this._month.getFullYear(), this._month.getMonth() + step, 1);
        this.reload();
    }

    /** Re-read the shown month from disk. */
    reload() {
        const now = new Date();
        const todayKey = dateKey(now);
        this._title.label = this._month.toLocaleDateString(undefined, MONTH_TITLE);
        this._next.sensitive = monthKey(this._month) < monthKey(now);
        this._add.sensitive = this._ctx.client.online;

        const days = this._ctx.history.month(monthKey(this._month)).reverse();
        const past = days.filter(d => d.date < todayKey);
        const totals = past.map(d => computeDay(d));
        this._days.value.label = String(past.length);
        this._worked.value.label = formatDuration(totals.reduce((s, t) => s + t.workedMin, 0));
        const overtime = totals.reduce((s, t) => s + t.overtimeMin, 0);
        this._overtime.value.label = formatSigned(overtime);

        // The minute refresh only changes today's numbers: update that row in place, and
        // rebuild (with the fade-in only on a month change) when past days really changed.
        const month = monthKey(this._month);
        const key = `${month}|${pastDaysKey(days, todayKey)}`;
        const today = days.find(d => d.date === todayKey);
        if (key === this._key) {
            if (today && this._todayRow)
                this._fill(this._todayRow, today, true, now);
            return;
        }
        const fade = month !== this._shownMonth;
        this._key = key;
        this._shownMonth = month;
        this._todayRow = null;
        this._list.remove_all();
        days.forEach((day, i) => this._list.append(this._row(day, day.date === todayKey, fade ? i : null, now)));
    }

    /** Set a row's subtitle, bar and pill from the day (today: computed until now). */
    _fill(parts, day, isToday, now) {
        const until = isToday ? now : day.departure ?? day.arrival;
        const {workedMin, overtimeMin} = computeDay(day, until);
        parts.row.subtitle = `${formatClock(day.arrival)} → ${isToday ? 'now' : formatClock(day.departure ?? day.arrival)} · ${formatDuration(workedMin)}`;
        parts.bar.fraction = Math.min(1, day.targetMin ? workedMin / day.targetMin : 1);
        parts.bar.css_classes = ['mini', ...(overtimeMin >= 0 ? ['ot'] : [])];
        parts.pill.label = isToday ? 'today' : formatSigned(overtimeMin);
        parts.pill.css_classes = ['pill', isToday ? 'today' : overtimeMin >= 0 ? 'plus' : 'minus'];
    }

    /** A day row; `index` (or null) staggers the fade-in when a month is first shown. */
    _row(day, isToday, index, now) {
        const date = new Date(day.arrival);
        const row = new Adw.ActionRow({
            title: `${date.getDate()} · ${date.toLocaleDateString(undefined, WEEKDAY)}`,
            activatable: true,
            css_classes: [...(index === null ? [] : ['fade-in', `d${Math.min(index + 1, 8)}`]), ...(isToday ? ['today-row'] : [])],
        });
        const bar = new Gtk.ProgressBar({valign: Gtk.Align.CENTER});
        const pill = new Gtk.Label({valign: Gtk.Align.CENTER});
        const parts = {row, bar, pill};
        this._fill(parts, day, isToday, now);
        if (isToday)
            this._todayRow = parts;
        row.add_suffix(bar);
        row.add_suffix(pill);
        row.connect('activated', () => {
            if (isToday)
                this._ctx.openToday();
            else
                new DayDialog(this._ctx, day, day.date).present(this._ctx.window);
        });
        return row;
    }
});

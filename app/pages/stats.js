// Stats: week/month totals, bar chart, averages and records.
import Adw from 'gi://Adw?version=1';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';

import {periodRange, shiftPeriod, summarize} from '../../time-tracker@anjrakot/lib/stats.js';
import {dateFromKey, formatDuration, formatSigned} from '../../time-tracker@anjrakot/lib/timecalc.js';
import {BarChart} from '../widgets/barChart.js';

const pad = n => String(n).padStart(2, '0');
const clock = minutes => (minutes === null ? '—' : `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`);
const shortDate = key => dateFromKey(key).toLocaleDateString(undefined, {day: 'numeric', month: 'short'});

function statCard(title, css) {
    const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, css_classes: ['stat-card', css], hexpand: true});
    box.append(new Gtk.Label({label: title, xalign: 0}));
    const value = new Gtk.Label({css_classes: ['stat-value'], xalign: 0});
    box.append(value);
    return {box, value};
}

function valueRow(group, title) {
    const row = new Adw.ActionRow({title});
    const value = new Gtk.Label({css_classes: ['dim-label']});
    row.add_suffix(value);
    group.add(row);
    return value;
}

export const StatsPage = GObject.registerClass(
class StatsPage extends Gtk.ScrolledWindow {
    _init(ctx) {
        super._init({hscrollbar_policy: Gtk.PolicyType.NEVER});
        this._ctx = ctx;
        this._kind = 'month';
        this._anchor = new Date();

        const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 12,
            margin_top: 16, margin_bottom: 24, margin_start: 16, margin_end: 16});
        this.set_child(new Adw.Clamp({maximum_size: 560, child: box}));

        const toggle = new Gtk.Box({css_classes: ['linked'], halign: Gtk.Align.CENTER});
        const week = new Gtk.ToggleButton({label: 'Week'});
        const month = new Gtk.ToggleButton({label: 'Month', group: week, active: true});
        week.connect('toggled', () => {
            if (week.active)
                this._setKind('week');
        });
        month.connect('toggled', () => {
            if (month.active)
                this._setKind('month');
        });
        toggle.append(week);
        toggle.append(month);
        box.append(toggle);

        const nav = new Gtk.CenterBox();
        const prev = new Gtk.Button({icon_name: 'go-previous-symbolic', css_classes: ['circular']});
        this._nextButton = new Gtk.Button({icon_name: 'go-next-symbolic', css_classes: ['circular']});
        this._title = new Gtk.Label({css_classes: ['title-3']});
        prev.connect('clicked', () => this._shift(-1));
        this._nextButton.connect('clicked', () => this._shift(1));
        nav.set_start_widget(prev);
        nav.set_center_widget(this._title);
        nav.set_end_widget(this._nextButton);
        box.append(nav);

        const grid = new Gtk.Grid({column_spacing: 8, row_spacing: 8, column_homogeneous: true});
        this._cards = {
            worked: statCard('Worked', 'c1'),
            overtime: statCard('Overtime', 'c2'),
            days: statCard('Days', 'c3'),
            avg: statCard('Avg / day', 'c4'),
        };
        grid.attach(this._cards.worked.box, 0, 0, 1, 1);
        grid.attach(this._cards.overtime.box, 1, 0, 1, 1);
        grid.attach(this._cards.days.box, 0, 1, 1, 1);
        grid.attach(this._cards.avg.box, 1, 1, 1, 1);
        box.append(grid);

        this._chart = new BarChart();
        const chartCard = new Gtk.Box({css_classes: ['card-box']});
        chartCard.append(this._chart);
        box.append(chartCard);

        const averages = new Adw.PreferencesGroup({title: 'Averages'});
        this._avgArrival = valueRow(averages, 'Arrival · departure');
        this._avgBreak = valueRow(averages, 'Break');
        box.append(averages);

        const records = new Adw.PreferencesGroup({title: 'Records'});
        this._earliest = valueRow(records, '🌅 Earliest arrival');
        this._latest = valueRow(records, '🌙 Latest departure');
        this._longest = valueRow(records, '🏔 Longest day');
        this._shortest = valueRow(records, '🐣 Shortest day');
        box.append(records);
    }

    _setKind(kind) {
        this._kind = kind;
        this._anchor = new Date();
        this.reload();
    }

    _shift(step) {
        this._anchor = shiftPeriod(this._kind, this._anchor, step);
        this.reload();
    }

    reload() {
        const now = new Date();
        const range = periodRange(this._kind, this._anchor);
        this._nextButton.sensitive = range.end < new Date(now.getFullYear(), now.getMonth(), now.getDate());
        this._title.label = this._kind === 'month'
            ? range.start.toLocaleDateString(undefined, {month: 'long', year: 'numeric'})
            : `${range.start.toLocaleDateString(undefined, {day: 'numeric', month: 'short'})} – ${range.end.toLocaleDateString(undefined, {day: 'numeric', month: 'short', year: 'numeric'})}`;

        const s = summarize(this._ctx.history.range(range), range, now);
        this._cards.worked.value.label = formatDuration(s.workedMin);
        this._cards.overtime.value.label = formatSigned(s.overtimeMin);
        this._cards.days.value.label = String(s.days);
        this._cards.avg.value.label = s.avgWorkedMin === null ? '—' : formatDuration(s.avgWorkedMin);
        this._chart.setChart(s.chart);
        this._avgArrival.label = `${clock(s.avgArrival)} · ${clock(s.avgDeparture)}`;
        this._avgBreak.label = s.avgBreakMin === null ? '—' : formatDuration(s.avgBreakMin);
        const rec = (r, fmt) => (r ? `${fmt(r.value)} · ${shortDate(r.date)}` : '—');
        this._earliest.label = rec(s.records.earliestArrival, clock);
        this._latest.label = rec(s.records.latestDeparture, clock);
        this._longest.label = rec(s.records.longestDay, formatDuration);
        this._shortest.label = rec(s.records.shortestDay, formatDuration);
    }
});

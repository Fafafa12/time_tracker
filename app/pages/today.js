// Today: hero card (ring, arrival, left/overtime, break chip), timeline, details, actions.
import Adw from 'gi://Adw?version=1';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';

import {formatDuration, formatSigned, parseHM} from '../../time-tracker@anjrakot/lib/timecalc.js';
import {Ring} from '../widgets/ring.js';
import {Timeline} from '../widgets/timeline.js';

const minutesOf = text => parseHM(text.slice(0, 5));
const label = (text, css = []) => new Gtk.Label({label: text, css_classes: css, xalign: 0});

function valueRow(group, title) {
    const row = new Adw.ActionRow({title});
    const value = new Gtk.Label({css_classes: ['dim-label'], xalign: 1, justify: Gtk.Justification.RIGHT});
    row.add_suffix(value);
    group.add(row);
    return value;
}

export const TodayPage = GObject.registerClass(
class TodayPage extends Gtk.Stack {
    /** @param {object} ctx  shared window context (see window.js) */
    _init(ctx) {
        super._init({transition_type: Gtk.StackTransitionType.CROSSFADE});
        this._ctx = ctx;
        this._celebrated = null;

        this.add_named(new Adw.StatusPage({
            icon_name: 'preferences-system-time-symbolic',
            title: 'The tracker is off',
            description: 'Enable the Time Tracker extension to see today.\nHistory and Stats still work.',
        }), 'off');

        const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 14,
            margin_top: 16, margin_bottom: 24, margin_start: 16, margin_end: 16});
        this.add_named(new Gtk.ScrolledWindow({
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            child: new Adw.Clamp({maximum_size: 560, child: box}),
        }), 'live');

        // Hero card.
        this._hero = new Gtk.Box({spacing: 16, css_classes: ['hero', 'working']});
        this._ring = new Ring();
        const ringOverlay = new Gtk.Overlay({child: this._ring});
        const ringText = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER});
        this._worked = new Gtk.Label({css_classes: ['hero-big']});
        this._of = new Gtk.Label({css_classes: ['hero-small']});
        ringText.append(this._worked);
        ringText.append(this._of);
        ringOverlay.add_overlay(ringText);
        this._hero.append(ringOverlay);

        const heroText = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 4, valign: Gtk.Align.CENTER});
        this._arrived = label('', ['hero-dim']);
        this._left = label('', ['hero-title']);
        this._chip = new Gtk.Box({spacing: 6, css_classes: ['chip'], halign: Gtk.Align.START});
        this._chip.append(new Gtk.Box({css_classes: ['pulse-dot'], valign: Gtk.Align.CENTER}));
        this._chipLabel = new Gtk.Label();
        this._chip.append(this._chipLabel);
        heroText.append(this._arrived);
        heroText.append(this._left);
        heroText.append(this._chip);
        this._hero.append(heroText);
        box.append(this._hero);

        // Timeline.
        this._timeline = new Timeline();
        const timelineCard = new Gtk.Box({css_classes: ['card-box']});
        timelineCard.append(this._timeline);
        box.append(timelineCard);

        // Details.
        const details = new Adw.PreferencesGroup();
        this._breaks = valueRow(details, 'Breaks');
        this._next = valueRow(details, 'Next alert');
        this._leave = valueRow(details, 'Leave at');
        box.append(details);

        // Actions.
        this._breakButton = new Gtk.Button({css_classes: ['big-button']});
        this._breakButton.connect('clicked', () => ctx.run(this._view?.onBreak ? 'FinishBreak' : 'StartBreak'));
        box.append(this._breakButton);
        const row = new Gtk.Box({spacing: 8, homogeneous: true});
        const setArrival = new Gtk.Button({label: '✎ Set arrival…', css_classes: ['big-button']});
        setArrival.connect('clicked', () => this._askArrival());
        const reset = new Gtk.Button({label: '↺ Reset arrival', css_classes: ['big-button']});
        reset.connect('clicked', () => this._confirmReset());
        row.append(setArrival);
        row.append(reset);
        box.append(row);

        this.set_visible_child_name('off');
    }

    /** @param {object|null} view  Tracker.view() from the extension, or null when it is off */
    update(view) {
        this._view = view;
        if (!view) {
            this.set_visible_child_name('off');
            return;
        }
        this.set_visible_child_name('live');
        const done = view.targetMin > 0 && view.workedMin >= view.targetMin;

        for (const css of ['working', 'break', 'done'])
            this._hero.remove_css_class(css);
        this._hero.add_css_class(view.onBreak ? 'break' : done ? 'done' : 'working');
        this._ring.setFraction(view.targetMin > 0 ? view.workedMin / view.targetMin : 1);
        this._worked.label = formatDuration(view.workedMin);
        this._of.label = view.targetMin > 0 ? `of ${formatDuration(view.targetMin)}` : 'worked';
        this._arrived.label = `Arrived ${view.arrival.slice(0, 5)}`;
        this._left.label = done ? `${formatSigned(view.overtimeMin)} overtime` : `${formatDuration(view.remainingMin)} left`;
        this._chip.visible = view.onBreak || done;
        this._chipLabel.label = view.onBreak ? `☕ Break since ${view.openBreak.slice(0, 5)}` : '🎉 Day complete';

        const breaks = [...(view.fixedBreak ? [[...view.fixedBreak, 'fixed']] : []), ...view.breaks];
        this._breaks.label = [
            ...breaks.map(([s, e, tag]) => `${s.slice(0, 5)}–${e.slice(0, 5)}${tag ? ' (fixed)' : ''}`),
            ...(view.onBreak ? [`${view.openBreak.slice(0, 5)}–…`] : []),
        ].join('\n') || 'none';
        this._next.label = view.next?.paused ? `${view.next.label} · paused`
            : view.next ? `${view.next.label} at ${view.next.time}` : 'none';
        this._leave.label = view.leaveAt ?? (view.onBreak ? 'after the break' : '—');

        const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
        this._timeline.setData({
            arrival: minutesOf(view.arrival),
            now: Math.max(nowMin, minutesOf(view.arrival)),
            breaks: [
                ...breaks.map(([s, e]) => [minutesOf(s), minutesOf(e)]),
                ...(view.onBreak ? [[minutesOf(view.openBreak), nowMin]] : []),
            ],
        });

        this._breakButton.label = view.onBreak ? '▶ Finish break' : '☕ Start break';
        this._breakButton.css_classes = ['big-button', view.onBreak ? 'break-action' : 'suggested-action'];

        if (done && this._celebrated !== view.date) {
            this._celebrated = view.date;
            this._ctx.celebrate();
        }
    }

    _askArrival() {
        const entry = new Gtk.Entry({text: this._view?.arrival.slice(0, 5) ?? '', input_purpose: Gtk.InputPurpose.DIGITS});
        const dialog = new Adw.AlertDialog({heading: 'Set arrival', body: 'Today\'s arrival time (H:MM).', extra_child: entry});
        dialog.add_response('cancel', 'Cancel');
        dialog.add_response('set', 'Set');
        dialog.set_response_appearance('set', Adw.ResponseAppearance.SUGGESTED);
        dialog.set_default_response('set');
        entry.connect('activate', () => dialog.response('set'));
        dialog.connect('response', (_d, id) => {
            if (id === 'set')
                this._ctx.run('SetArrival', entry.text.trim());
        });
        dialog.present(this._ctx.window);
    }

    _confirmReset() {
        const dialog = new Adw.AlertDialog({
            heading: 'Reset arrival to now?',
            body: 'Today\'s arrival becomes the current time and today\'s alerts start again.',
        });
        dialog.add_response('cancel', 'Cancel');
        dialog.add_response('reset', 'Reset');
        dialog.set_response_appearance('reset', Adw.ResponseAppearance.DESTRUCTIVE);
        dialog.connect('response', (_d, id) => {
            if (id === 'reset')
                this._ctx.run('ResetArrival');
        });
        dialog.present(this._ctx.window);
    }
});

// Top-bar button: "⏱ 5h12" (or "☕ 5h12" on a break) plus a menu with today's details and actions.
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {formatDuration, formatSigned} from './timecalc.js';

export const TrackerIndicator = GObject.registerClass(
class TrackerIndicator extends PanelMenu.Button {
    /**
     * @param {object} actions
     * @param {() => void} actions.onToggleBreak
     * @param {() => void} actions.onOpenApp
     * @param {() => void} actions.onReset
     * @param {() => void} actions.onOpenFolder
     * @param {() => void} actions.onSettings
     */
    _init({onToggleBreak, onOpenApp, onReset, onOpenFolder, onSettings}) {
        super._init(0.5, 'Time Tracker');

        this._label = new St.Label({text: '⏱ …', y_align: Clutter.ActorAlign.CENTER});
        this.add_child(this._label);

        this._arrival = this._addInfo();
        this._worked = this._addInfo();
        this._balance = this._addInfo();
        this._next = this._addInfo();
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._breakItem = this.menu.addAction('☕ Start break', onToggleBreak);
        this.menu.addAction('Open Time Tracker', onOpenApp);
        this.menu.addAction('Reset arrival to now', onReset);
        this.menu.addAction('Open history folder', onOpenFolder);
        this.menu.addAction('Settings', onSettings);
    }

    _addInfo() {
        const item = new PopupMenu.PopupMenuItem('', {reactive: false});
        this.menu.addMenuItem(item);
        return item.label;
    }

    /** @param {object} view  Tracker.view() */
    update(view) {
        this._label.text = `${view.onBreak ? '☕' : '⏱'} ${formatDuration(view.workedMin)}`;
        this._arrival.text = `Arrival: ${view.arrival.slice(0, 5)}`;
        this._worked.text = `Worked: ${formatDuration(view.workedMin)}`;
        this._balance.text = view.targetMin > 0 && view.workedMin >= view.targetMin
            ? `Overtime: ${formatSigned(view.overtimeMin)}`
            : `Remaining: ${formatDuration(view.remainingMin)}`;
        this._next.text = `Next alert: ${nextText(view)}`;
        this._breakItem.label.text = view.onBreak
            ? `▶ Finish break (since ${view.openBreak.slice(0, 5)})`
            : '☕ Start break';
    }
});

function nextText({next, targetMin, workedMin}) {
    if (next?.paused)
        return `${next.label} · paused (on a break)`;
    if (next)
        return `${next.label} at ${next.time}`;
    return targetMin > 0 && workedMin >= targetMin ? 'none, day complete' : 'none';
}

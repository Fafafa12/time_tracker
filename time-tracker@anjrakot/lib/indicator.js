// Top-bar button: "⏱ 5h12" label plus a menu with today's details and actions.
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {formatClock, formatDuration} from './timecalc.js';

export const TrackerIndicator = GObject.registerClass(
class TrackerIndicator extends PanelMenu.Button {
    /**
     * @param {object} actions
     * @param {() => void} actions.onReset
     * @param {() => void} actions.onOpenFolder
     * @param {() => void} actions.onSettings
     */
    _init({onReset, onOpenFolder, onSettings}) {
        super._init(0.5, 'Time Tracker');

        this._label = new St.Label({text: '⏱ …', y_align: Clutter.ActorAlign.CENTER});
        this.add_child(this._label);

        this._arrival = this._addInfo();
        this._worked = this._addInfo();
        this._remaining = this._addInfo();
        this._next = this._addInfo();
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addAction('Reset arrival to now', onReset);
        this.menu.addAction('Open history folder', onOpenFolder);
        this.menu.addAction('Settings', onSettings);
    }

    _addInfo() {
        const item = new PopupMenu.PopupMenuItem('', {reactive: false});
        this.menu.addMenuItem(item);
        return item.label;
    }

    /** @param {{arrival: Date, worked: number, remaining: number, next: ?{label: string, time: Date}}} view */
    update(view) {
        this._label.text = `⏱ ${formatDuration(view.worked)}`;
        this._arrival.text = `Arrival: ${formatClock(view.arrival)}`;
        this._worked.text = `Worked: ${formatDuration(view.worked)}`;
        this._remaining.text = `Remaining: ${formatDuration(view.remaining)}`;
        this._next.text = view.next
            ? `Next alert: ${view.next.label} at ${formatClock(view.next.time)}`
            : 'Next alert: none, day complete';
    }
});

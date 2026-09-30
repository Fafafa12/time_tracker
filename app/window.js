// Main window: header-bar tabs (Today · History · Stats), off banner, toasts, confetti.
import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';

import {TodayPage} from './pages/today.js';
import {Confetti} from './widgets/confetti.js';

export const TrackerWindow = GObject.registerClass(
class TrackerWindow extends Adw.ApplicationWindow {
    /**
     * @param {object} params
     * @param {Adw.Application} params.application
     * @param {import('./client.js').TrackerClient} params.client
     * @param {import('./data.js').History} params.history
     */
    _init({application, client, history}) {
        super._init({application, title: 'Time Tracker', default_width: 460, default_height: 780,
            width_request: 360, height_request: 480});
        this._client = client;
        this._pending = 0;

        // Shared by all pages and dialogs.
        const ctx = {
            client,
            history,
            window: this,
            toast: text => this._toasts.add_toast(new Adw.Toast({title: text, timeout: 4})),
            run: (method, ...args) => this._run(method, ...args),
            openToday: () => this._stack.set_visible_child_name('today'),
            celebrate: () => this._confetti.burst(),
        };

        this._stack = new Adw.ViewStack();
        this._todayPage = new TodayPage(ctx);
        this._stack.add_titled_with_icon(this._todayPage, 'today', 'Today', 'preferences-system-time-symbolic');

        const header = new Adw.HeaderBar({title_widget: new Adw.ViewSwitcher({stack: this._stack, policy: Adw.ViewSwitcherPolicy.WIDE})});
        const menu = new Gio.Menu();
        menu.append('Settings', 'app.settings');
        menu.append('About Time Tracker', 'app.about');
        header.pack_end(new Gtk.MenuButton({icon_name: 'open-menu-symbolic', menu_model: menu, primary: true, tooltip_text: 'Main menu'}));
        const switcherBar = new Adw.ViewSwitcherBar({stack: this._stack});

        this._banner = new Adw.Banner({title: 'The tracker is off — view only'});
        this._toasts = new Adw.ToastOverlay({child: this._stack});
        const overlay = new Gtk.Overlay({child: this._toasts});
        this._confetti = new Confetti();
        overlay.add_overlay(this._confetti);

        const toolbar = new Adw.ToolbarView({content: overlay});
        toolbar.add_top_bar(header);
        toolbar.add_top_bar(this._banner);
        toolbar.add_bottom_bar(switcherBar);
        this.set_content(toolbar);

        // Narrow window: tabs move to a bar at the bottom.
        const narrow = new Adw.Breakpoint({condition: Adw.BreakpointCondition.parse('max-width: 420sp')});
        narrow.add_setter(switcherBar, 'reveal', true);
        narrow.add_setter(header, 'show-title', false);
        this.add_breakpoint(narrow);

        client.onChange(() => this.refresh());
        this.refresh();
    }

    /** Re-read everything (coalesced: several change signals in a row cause one refresh). */
    refresh() {
        if (this._pending)
            return;
        this._pending = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._pending = 0;
            this._reload().catch(e => console.error(`[time-tracker] refresh failed: ${e}`));
            return GLib.SOURCE_REMOVE;
        });
    }

    async _reload() {
        const online = this._client.online;
        this._banner.revealed = !online;
        let today = null;
        if (online) {
            try {
                today = await this._client.today();
            } catch (e) {
                console.error(`[time-tracker] GetToday failed: ${e}`);
            }
        }
        this._todayPage.update(today);
    }

    /** Call an extension action; shows the refusal as a toast. Resolves to true on success. */
    async _run(method, ...args) {
        try {
            await this._client.call(method, ...args);
            this.refresh();
            return true;
        } catch (e) {
            this._toasts.add_toast(new Adw.Toast({title: e.message, timeout: 5}));
            return false;
        }
    }

    showPage(name) {
        this._stack.set_visible_child_name(name);
    }
});

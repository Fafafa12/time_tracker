// Time Tracker app entry point: `gjs -m app/main.js` (installed as `time-tracker`).
import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import System from 'system';

import {TrackerClient} from './client.js';
import {APP_DIR, EXTENSION_UUID, History, openExtensionSettings} from './data.js';
import {TrackerWindow} from './window.js';

const APP_ID = 'io.github.fafafa12.TimeTracker';

const app = new Adw.Application({application_id: APP_ID});
let client = null;
let history = null;

function addAction(name, callback, accels = []) {
    const action = new Gio.SimpleAction({name});
    action.connect('activate', callback);
    app.add_action(action);
    if (accels.length)
        app.set_accels_for_action(`app.${name}`, accels);
}

app.connect('startup', () => {
    const css = new Gtk.CssProvider();
    css.load_from_path(GLib.build_filenamev([APP_DIR, 'style.css']));
    Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(), css, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
    Gtk.IconTheme.get_for_display(Gdk.Display.get_default()).add_search_path(GLib.build_filenamev([APP_DIR, 'icons']));

    client = new TrackerClient();
    history = new History(openExtensionSettings());

    addAction('settings', () => {
        try {
            Gio.Subprocess.new(['gnome-extensions', 'prefs', EXTENSION_UUID], Gio.SubprocessFlags.NONE);
        } catch (e) {
            console.error(`[time-tracker] cannot open settings: ${e}`);
        }
    });
    addAction('about', () => new Adw.AboutDialog({
        application_name: 'Time Tracker',
        application_icon: APP_ID,
        developer_name: 'anjrakot',
        version: '2.0',
        website: 'https://github.com/Fafafa12/time_tracker',
        comments: 'Counts office time, breaks and overtime.',
        license_type: Gtk.License.MIT_X11,
    }).present(app.active_window));
    addAction('quit', () => app.quit(), ['<Control>q']);
    app.set_accels_for_action('window.close', ['<Control>w']);
});

app.connect('activate', () => {
    // Screenshot mode (dev/preview.sh): Broadway has no frame clock without a browser, so
    // animations would never finish; turn them off like GNOME's "reduce animation" setting.
    if (GLib.getenv('TT_SCREENSHOT'))
        Gtk.Settings.get_default().gtk_enable_animations = false;
    const win = app.active_window ?? new TrackerWindow({application: app, client, history});
    win.present();
    maybeScreenshot(win);
});

/** Dev only (dev/preview.sh): TT_SCREENSHOT=out.png [TT_PAGE=history] renders the window and quits. */
function maybeScreenshot(win) {
    const out = GLib.getenv('TT_SCREENSHOT');
    if (!out)
        return;
    const page = GLib.getenv('TT_PAGE');
    if (page)
        win.showPage(page);
    if (GLib.getenv('TT_DIALOG') === 'add')
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 800, () => {
            win.openAddDay();
            return GLib.SOURCE_REMOVE;
        });
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, Number(GLib.getenv('TT_DELAY_MS') ?? 2500), () => {
        const paintable = new Gtk.WidgetPaintable({widget: win});
        const snapshot = new Gtk.Snapshot();
        paintable.snapshot(snapshot, win.get_width(), win.get_height());
        const node = snapshot.to_node();
        if (node)
            win.get_renderer().render_texture(node, null).save_to_png(out);
        app.quit();
        return GLib.SOURCE_REMOVE;
    });
}

app.run([System.programInvocationName, ...ARGV]);

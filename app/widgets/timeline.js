// The day at a glance: worked time as a blue bar, breaks striped orange, a red "now" marker.
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import PangoCairo from 'gi://PangoCairo';

import {animate} from './anim.js';

const BAR = 14;
const BLUE = [0.21, 0.52, 0.89];
const ORANGE = [0.9, 0.65, 0.04];
const RED = [0.88, 0.11, 0.14];

function roundedRect(cr, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    cr.newSubPath();
    cr.arc(x + w - rr, y + rr, rr, -Math.PI / 2, 0);
    cr.arc(x + w - rr, y + h - rr, rr, 0, Math.PI / 2);
    cr.arc(x + rr, y + h - rr, rr, Math.PI / 2, Math.PI);
    cr.arc(x + rr, y + rr, rr, Math.PI, 1.5 * Math.PI);
    cr.closePath();
}

export const Timeline = GObject.registerClass(
class Timeline extends Gtk.DrawingArea {
    _init() {
        super._init({content_height: 44, hexpand: true});
        this._data = null;
        this._grow = 1;
        this.set_draw_func((_area, cr, w) => this._draw(cr, w));
    }

    /**
     * @param {{arrival: number, now: number, breaks: Array<[number, number]>}|null} data
     *   minutes since midnight; breaks are clipped to [arrival, now].
     */
    setData(data) {
        const first = this._data === null;
        this._data = data;
        if (first && data)
            animate(this, 0, 1, 900, v => {
                this._grow = v;
                this.queue_draw();
            });
        this.queue_draw();
    }

    _draw(cr, w) {
        const d = this._data;
        if (!d) {
            cr.$dispose();
            return;
        }
        const fg = this.get_color();
        const startH = Math.min(7, Math.floor(d.arrival / 60));
        const endH = Math.max(20, Math.ceil(d.now / 60));
        const span = (endH - startH) * 60;
        const x = m => ((m - startH * 60) / span) * w;

        cr.setSourceRGBA(fg.red, fg.green, fg.blue, 0.1);
        roundedRect(cr, 0, 0, w, BAR, BAR / 2);
        cr.fill();

        const workEnd = d.arrival + (d.now - d.arrival) * this._grow;
        cr.setSourceRGBA(...BLUE, 1);
        roundedRect(cr, x(d.arrival), 0, Math.max(BAR, x(workEnd) - x(d.arrival)), BAR, BAR / 2);
        cr.fill();

        for (const [s, e] of d.breaks) {
            const bs = Math.max(s, d.arrival);
            const be = Math.min(e, workEnd);
            if (be <= bs)
                continue;
            cr.save();
            cr.rectangle(x(bs), 0, x(be) - x(bs), BAR);
            cr.clip();
            cr.setSourceRGBA(...ORANGE, 1);
            cr.paint();
            cr.setSourceRGBA(0.96, 0.83, 0.18, 1);
            cr.setLineWidth(3);
            for (let sx = x(bs) - BAR; sx < x(be) + BAR; sx += 8) {
                cr.moveTo(sx, BAR);
                cr.lineTo(sx + BAR, 0);
            }
            cr.stroke();
            cr.restore();
        }

        if (this._grow >= 1) {
            cr.setSourceRGBA(...RED, 1);
            cr.rectangle(x(d.now) - 1, -2, 2, BAR + 4);
            cr.fill();
        }

        cr.setSourceRGBA(fg.red, fg.green, fg.blue, 0.6);
        for (let hour = startH; hour <= endH; hour += 2) {
            const layout = this.create_pango_layout(`${hour}`);
            const [, extents] = layout.get_pixel_extents();
            const lx = Math.max(0, Math.min(w - extents.width, x(hour * 60) - extents.width / 2));
            cr.moveTo(lx, BAR + 6);
            PangoCairo.show_layout(cr, layout);
        }
        cr.$dispose();
    }
});

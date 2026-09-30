// Progress ring (worked / target), drawn in white on the colored hero card.
import Cairo from 'cairo';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';

import {animate} from './anim.js';

const WIDTH = 11;

export const Ring = GObject.registerClass(
class Ring extends Gtk.DrawingArea {
    _init() {
        super._init({content_width: 124, content_height: 124});
        this._shown = 0;
        this._target = 0;
        this._animation = null;
        this.set_draw_func((_area, cr, w, h) => this._draw(cr, w, h));
    }

    /** 0..1 (values above 1 show a full ring). Animated from the current value. */
    setFraction(fraction) {
        const to = Math.max(0, Math.min(1, fraction));
        if (Math.abs(to - this._target) < 0.001)
            return;
        this._target = to;
        this._animation?.skip();
        this._animation = animate(this, this._shown, to, 900, v => {
            this._shown = v;
            this.queue_draw();
        });
    }

    _draw(cr, w, h) {
        const r = Math.min(w, h) / 2 - WIDTH;
        cr.setLineWidth(WIDTH);
        cr.setLineCap(Cairo.LineCap.ROUND);
        cr.setSourceRGBA(1, 1, 1, 0.28);
        cr.arc(w / 2, h / 2, r, 0, 2 * Math.PI);
        cr.stroke();
        if (this._shown > 0.001) {
            cr.setSourceRGBA(1, 1, 1, 1);
            cr.arc(w / 2, h / 2, r, -Math.PI / 2, -Math.PI / 2 + 2 * Math.PI * this._shown);
            cr.stroke();
        }
        cr.$dispose();
    }
});

// A short confetti burst drawn over the whole window (does not take clicks).
import Adw from 'gi://Adw?version=1';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';

import {animate} from './anim.js';

const COLORS = [[0.21, 0.52, 0.89], [0.18, 0.76, 0.49], [0.9, 0.65, 0.04], [0.88, 0.11, 0.14], [0.57, 0.25, 0.67], [0.96, 0.83, 0.18]];
const COUNT = 140;
const SECONDS = 2.6;
const GRAVITY = 900;

export const Confetti = GObject.registerClass(
class Confetti extends Gtk.DrawingArea {
    _init() {
        super._init({can_target: false, hexpand: true, vexpand: true});
        this._particles = [];
        this._t = 0;
        this.set_draw_func((_area, cr, w, h) => this._draw(cr, w, h));
    }

    burst() {
        this._particles = Array.from({length: COUNT}, () => ({
            x: 0.3 + Math.random() * 0.4,
            vx: (Math.random() - 0.5) * 700,
            vy: -300 - Math.random() * 600,
            spin: (Math.random() - 0.5) * 12,
            size: 5 + Math.random() * 6,
            color: COLORS[Math.floor(Math.random() * COLORS.length)],
        }));
        animate(this, 0, 1, SECONDS * 1000, v => {
            this._t = v;
            if (v >= 1)
                this._particles = [];
            this.queue_draw();
        }, Adw.Easing.LINEAR);
    }

    _draw(cr, w, h) {
        const t = this._t * SECONDS;
        const alpha = this._t < 0.7 ? 1 : (1 - this._t) / 0.3;
        for (const p of this._particles) {
            const px = p.x * w + p.vx * t;
            const py = h * 0.35 + p.vy * t + (GRAVITY * t * t) / 2;
            cr.save();
            cr.translate(px, py);
            cr.rotate(p.spin * t);
            cr.setSourceRGBA(...p.color, alpha);
            cr.rectangle(-p.size / 2, -p.size / 4, p.size, p.size / 2);
            cr.fill();
            cr.restore();
        }
        cr.$dispose();
    }
});

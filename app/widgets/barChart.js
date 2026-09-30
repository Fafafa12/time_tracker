// One bar per day: blue up to the target, green overtime on top, orange for days under
// target, a dashed red target line; today faded. Bars grow in when the data changes.
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import PangoCairo from 'gi://PangoCairo';

import {animate} from './anim.js';

const BLUE = [0.21, 0.52, 0.89];
const GREEN = [0.18, 0.76, 0.49];
const ORANGE = [0.9, 0.38, 0.0];
const RED = [0.88, 0.11, 0.14];
const LABELS = 18;

export const BarChart = GObject.registerClass(
class BarChart extends Gtk.DrawingArea {
    _init() {
        super._init({content_height: 170, hexpand: true});
        this._chart = [];
        this._grow = 1;
        this.set_draw_func((_area, cr, w, h) => this._draw(cr, w, h));
    }

    /** @param {Array} chart  stats.summarize(...).chart */
    setChart(chart) {
        const changed = JSON.stringify(chart) !== JSON.stringify(this._chart);
        this._chart = chart;
        if (changed)
            animate(this, 0, 1, 1000, v => {
                this._grow = v;
                this.queue_draw();
            });
        this.queue_draw();
    }

    _draw(cr, w, h) {
        const bars = this._chart;
        if (!bars.length) {
            cr.$dispose();
            return;
        }
        const fg = this.get_color();
        const top = 14;
        const plot = h - LABELS - top;
        const target = Math.max(...bars.map(b => b.targetMin ?? 0), 1);
        const max = Math.max(target * 1.2, ...bars.map(b => b.workedMin ?? 0));
        const y = minutes => top + plot - (minutes / max) * plot;
        const slot = w / bars.length;
        const bw = Math.max(3, Math.min(28, slot * 0.62));

        bars.forEach((b, i) => {
            const cx = slot * i + slot / 2;
            if (!b.empty) {
                const worked = b.workedMin * this._grow;
                const alpha = b.today ? 0.45 : 1;
                const base = Math.min(worked, b.targetMin);
                cr.setSourceRGBA(...(b.workedMin < b.targetMin ? ORANGE : BLUE), alpha);
                cr.rectangle(cx - bw / 2, y(base), bw, y(0) - y(base));
                cr.fill();
                if (worked > b.targetMin) {
                    cr.setSourceRGBA(...GREEN, alpha);
                    cr.rectangle(cx - bw / 2, y(worked), bw, y(b.targetMin) - y(worked));
                    cr.fill();
                }
            }
            if (bars.length <= 16 || i % 2 === 0) {
                const layout = this.create_pango_layout(String(Number(b.date.slice(8))));
                const [, extents] = layout.get_pixel_extents();
                cr.setSourceRGBA(fg.red, fg.green, fg.blue, 0.6);
                cr.moveTo(cx - extents.width / 2, h - LABELS + 2);
                PangoCairo.show_layout(cr, layout);
            }
        });

        cr.setSourceRGBA(...RED, 0.75);
        cr.setLineWidth(1.5);
        cr.setDash([6, 4], 0);
        cr.moveTo(0, y(target));
        cr.lineTo(w, y(target));
        cr.stroke();
        cr.setDash([], 0);
        const layout = this.create_pango_layout(`${Math.round(target / 60 * 10) / 10}h`);
        const [, extents] = layout.get_pixel_extents();
        cr.moveTo(w - extents.width, y(target) - extents.height - 1);
        PangoCairo.show_layout(cr, layout);
        cr.$dispose();
    }
});

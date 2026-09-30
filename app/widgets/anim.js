// Small helper: animate a number on a widget with Adw.TimedAnimation.
// libadwaita skips animations when GNOME's animations are turned off.
import Adw from 'gi://Adw?version=1';

/**
 * Animate from `from` to `to` over `ms`, calling `apply(value)` on each frame.
 * Returns the animation (already playing); call `.skip()` to jump to the end.
 */
export function animate(widget, from, to, ms, apply, easing = Adw.Easing.EASE_OUT_CUBIC) {
    const animation = new Adw.TimedAnimation({
        widget,
        value_from: from,
        value_to: to,
        duration: ms,
        easing,
        target: Adw.CallbackAnimationTarget.new(apply),
    });
    animation.play();
    return animation;
}

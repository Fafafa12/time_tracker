#!/usr/bin/env bash
# Links the extension into GNOME Shell, compiles its settings schema and installs the
# Time Tracker app (launcher command, app-grid entry, icon). Changes no GNOME settings.
set -euo pipefail

UUID="time-tracker@anjrakot"
APP_ID="io.github.fafafa12.TimeTracker"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$ROOT/$UUID"
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"
BIN="$HOME/.local/bin/time-tracker"
APPS="$HOME/.local/share/applications"
ICONS="$HOME/.local/share/icons/hicolor/scalable/apps"

link() { # link <target> <link-path>: refuses to replace a real file
    if [ -e "$2" ] && [ ! -L "$2" ]; then
        echo "error: $2 exists and is not a symlink; remove it first" >&2
        exit 1
    fi
    ln -sfn "$1" "$2"
}

glib-compile-schemas "$SRC/schemas"
mkdir -p "$(dirname "$DEST")" "$(dirname "$BIN")" "$APPS" "$ICONS"
link "$SRC" "$DEST"
link "$ROOT/app/time-tracker" "$BIN"
link "$ROOT/app/icons/hicolor/scalable/apps/$APP_ID.svg" "$ICONS/$APP_ID.svg"
sed "s|@BIN@|$ROOT/app/time-tracker|" "$ROOT/app/$APP_ID.desktop.in" > "$APPS/$APP_ID.desktop"
if command -v update-desktop-database >/dev/null; then
    update-desktop-database -q "$APPS" || true
fi

echo "Linked $DEST -> $SRC"
echo "App: run 'time-tracker' or open 'Time Tracker' from the app grid"
echo "Wayland: after changing extension code, log out and back in, then run: gnome-extensions enable $UUID"

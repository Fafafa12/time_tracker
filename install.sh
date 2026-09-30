#!/usr/bin/env bash
# Links the extension into GNOME Shell and compiles its settings schema.
set -euo pipefail

UUID="time-tracker@anjrakot"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$UUID"
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"

glib-compile-schemas "$SRC/schemas"

mkdir -p "$(dirname "$DEST")"
if [ -e "$DEST" ] && [ ! -L "$DEST" ]; then
    echo "error: $DEST exists and is not a symlink; remove it first" >&2
    exit 1
fi
ln -sfn "$SRC" "$DEST"

echo "Linked $DEST -> $SRC"
echo "Wayland: log out and back in once, then run: gnome-extensions enable $UUID"

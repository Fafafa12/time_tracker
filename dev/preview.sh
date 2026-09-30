#!/usr/bin/env bash
# Dev only: render the app's pages to PNGs without touching your desktop.
# Broadway (no window on screen) + a private D-Bus + in-memory GSettings + temp data dir.
#   dev/preview.sh [out-dir] [--break] [--offline]
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${1:-${TMPDIR:-/tmp}/tt-preview}"
shift || true
FLAGS=("$@")
mkdir -p "$OUT"
TMP="$(mktemp -d)"
glib-compile-schemas "$ROOT/time-tracker@anjrakot/schemas"

export XDG_DATA_HOME="$TMP/data" GSETTINGS_BACKEND=memory GIO_USE_VFS=local NO_AT_BRIDGE=1 GTK_A11Y=none GTK_USE_PORTAL=0 ADW_DISABLE_PORTAL=1
export GDK_BACKEND=broadway BROADWAY_DISPLAY=:9 ROOT OUT
gtk4-broadwayd --address 127.0.0.1 :9 >/dev/null 2>&1 &
BROADWAY=$!
trap 'kill $BROADWAY 2>/dev/null || true; rm -rf "$TMP"' EXIT

OFFLINE=0
SERVICE_FLAGS=(--sample)
for f in "${FLAGS[@]}"; do
    case "$f" in
        --break) SERVICE_FLAGS+=(--break) ;;
        --offline) OFFLINE=1 ;;
    esac
done
export OFFLINE SERVICE_FLAGS_STR="${SERVICE_FLAGS[*]}"

dbus-run-session -- bash -c '
    gjs -m "$ROOT/dev/fake-service.js" $SERVICE_FLAGS_STR &
    SERVICE=$!
    for _ in $(seq 1 50); do
        gdbus introspect --session --dest io.github.fafafa12.TimeTrackerService \
            --object-path /io/github/fafafa12/TimeTrackerService >/dev/null 2>&1 && break
        sleep 0.1
    done
    [ "$OFFLINE" = 1 ] && kill $SERVICE
    for page in ${PAGES:-today history stats}; do
        TT_SCREENSHOT="$OUT/$page.png" TT_PAGE=$page timeout 20 gjs -m "$ROOT/app/main.js"
    done
    for dialog in ${DIALOGS-add}; do
        TT_SCREENSHOT="$OUT/dialog-$dialog.png" TT_PAGE=history TT_DIALOG=$dialog timeout 20 gjs -m "$ROOT/app/main.js"
    done
    kill $SERVICE 2>/dev/null || true
'
echo "Screenshots in $OUT"

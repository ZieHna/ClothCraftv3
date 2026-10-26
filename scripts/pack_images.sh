#!/bin/sh
# Product pictures for a restored scenario-pack database (used by scripts/pack_run.ps1: restore, images, export-images). Runs INSIDE the Odoo container.
# A dump holds the database rows but not the filestore, so the product pictures (ir_attachment rows on product.template.image_1920) point at files that a restored
# database does not have. This script only COPIES those exact files; it never overwrites a file, never touches any other file, never touches the database, and checks
# every copy (Odoo names a stored file by the SHA-1 of its content).
#
#   PICTURES_MODE=restore  DB=<database>  [ARCHIVE=<file inside /mnt/images>]   stdin: one store_fname per line (the wrapper reads them from the database)
#   PICTURES_MODE=export   ARCHIVE=<file inside /mnt/backups>                   stdin: the same list; writes a .tgz of those files from the shop's filestore
set -u
ROOT=/var/lib/odoo/.local/share/Odoo/filestore
LIST=/tmp/pack_images.list
tr -d '\r' | grep -v '^$' > "$LIST"                  # the Windows shell sends CRLF lines
[ -s "$LIST" ] || { echo "IMAGES nothing to do: the list is empty"; exit 0; }

case "${PICTURES_MODE:-}" in
restore)
    DST="$ROOT/${DB:?DB is required}"
    if [ -n "${ARCHIVE:-}" ]; then
        SRC=/tmp/pack_images_src
        mkdir -p "$SRC"
        tar -xzf "/mnt/images/$ARCHIVE" -C "$SRC" || { echo "BAD the archive could not be read"; exit 5; }
    else
        SRC="$ROOT/clothcraft_shop"
        [ -d "$SRC" ] || { echo "MISSING no shop filestore on this computer ($SRC)"; echo "IMAGES copied=0 already_there=0 missing=$(wc -l < "$LIST")"; exit 0; }
    fi
    mkdir -p "$DST"
    copied=0; there=0; missing=0
    while read -r f; do
        if [ -f "$DST/$f" ]; then there=$((there + 1)); continue; fi
        if [ ! -f "$SRC/$f" ]; then echo "MISSING $f"; missing=$((missing + 1)); continue; fi
        mkdir -p "$DST/$(dirname "$f")"
        cp "$SRC/$f" "$DST/$f"
        if [ "$(sha1sum "$DST/$f" | cut -d' ' -f1)" = "$(basename "$f")" ]; then copied=$((copied + 1)); else rm -f "$DST/$f"; echo "BAD $f"; missing=$((missing + 1)); fi
    done < "$LIST"
    echo "IMAGES copied=$copied already_there=$there missing=$missing"
    ;;
export)
    SRC="$ROOT/clothcraft_shop"
    cd "$SRC" || { echo "MISSING no shop filestore ($SRC)"; exit 3; }
    ok=1
    while read -r f; do [ -f "$f" ] || { echo "MISSING $f"; ok=0; }; done < "$LIST"
    [ "$ok" = 1 ] || exit 4
    tar -czf "/mnt/backups/${ARCHIVE:?ARCHIVE is required}" -T "$LIST"
    echo "EXPORTED $(wc -l < "$LIST") files"
    ;;
*)
    echo "BAD PICTURES_MODE must be restore or export"; exit 2
    ;;
esac

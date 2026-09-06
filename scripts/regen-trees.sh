#!/usr/bin/env bash
# Regenerate the lidar tree layers for one site from its persisted sources:
# canopy / canopy-color / surface tiles, tree-stems.json, and trees.geojson
# (polygons, for import-generated-features), then re-register the tile
# manifest so the API serves the new generatedAt.
#
#   bun run trees:regen -- <courseId|siteId>   # or: scripts/regen-trees.sh <courseId|siteId>
#
# A course id is resolved to its site through data/app.sqlite (courses.site_id);
# a site id is used as given. Same steps as the "Regenerate trees" action in
# the Create-mode actions menu (server MapBuildService.reTrees). Needs
# data/sources/<siteId>/lidar/*.laz and data/sources/<siteId>/dem.tif from a
# completed map build.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT=$PWD
ID=${1:?usage: scripts/regen-trees.sh <courseId|siteId>}
DATA=${DATA_DIR:-$ROOT/data}
SITE=$ID
if [[ -f $DATA/app.sqlite ]] && command -v sqlite3 >/dev/null; then
    resolved=$(sqlite3 "$DATA/app.sqlite" "select site_id from courses where id='${ID//\'/\'\'}' limit 1")
    if [[ -n $resolved && $resolved != "$ID" ]]; then
        echo "Course $ID uses site $resolved"
        SITE=$resolved
    fi
fi
SOURCES=$DATA/sources/$SITE
TILES=$DATA/tiles/$SITE
PYTHON=${MAP_PIPELINE_PYTHON:-$ROOT/pipeline/.venv/bin/python}
WORK=$(mktemp -d "${TMPDIR:-/tmp}/golftrees-XXXXXX")
trap 'rm -rf "$WORK"' EXIT

DEM=
for candidate in "$SOURCES/dem-edited.tif" "$SOURCES/dem.tif" "$DATA/dem/$SITE.tif"; do
    [[ -f $candidate ]] && { DEM=$candidate; break; }
done
[[ -n $DEM ]] || { echo "No DEM at $SOURCES/dem.tif or $DATA/dem/$SITE.tif; run a map build first" >&2; exit 1; }

LIDAR=()
for f in "$SOURCES"/lidar/*.laz; do [[ -f $f ]] && LIDAR+=(--lidar "$f"); done
[[ ${#LIDAR[@]} -gt 0 ]] || { echo "No lidar files under $SOURCES/lidar; rebuild the map to fetch them" >&2; exit 1; }

cd "$ROOT/pipeline"
"$PYTHON" -m golfpipe canopy "${LIDAR[@]}" --dem "$DEM" --course-id "$SITE" \
    --tiles-dir "$TILES" --workdir "$WORK/canopy" --minzoom 12 --maxzoom 17 \
    --trees-out "$SOURCES/trees.geojson"
"$PYTHON" -m golfpipe trees-stems "${LIDAR[@]}" --dem "$DEM" --course-id "$SITE" \
    --tiles-dir "$TILES" --out "$WORK/tree-stems.geojson"

cd "$ROOT/server"
bun scripts/register-tile-manifest.ts "$SITE" --db "$DATA/app.sqlite" --data-dir "$DATA"
echo "Tree polygons written to $SOURCES/trees.geojson (import with server/scripts/import-generated-features.ts or Import GeoJSON)"

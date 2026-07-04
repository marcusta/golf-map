#!/usr/bin/env bash
# Idempotent setup for the golfpipe tile pipeline.
# Creates (or reuses) a self-contained venv at pipeline/.venv and installs
# requirements.txt into it. No system GDAL is required or used — rasterio's
# wheels bundle their own GDAL build.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

VENV_DIR=".venv"

if [ ! -d "$VENV_DIR" ]; then
    echo "Creating venv at pipeline/$VENV_DIR ..."
    python3 -m venv "$VENV_DIR"
else
    echo "Reusing existing venv at pipeline/$VENV_DIR"
fi

"$VENV_DIR/bin/pip" install --upgrade pip
"$VENV_DIR/bin/pip" install -r requirements.txt

echo
echo "Done. Activate with:"
echo "  source pipeline/$VENV_DIR/bin/activate"
echo "Or run directly:"
echo "  pipeline/$VENV_DIR/bin/python -m golfpipe --help"

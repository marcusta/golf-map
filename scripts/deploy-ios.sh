#!/usr/bin/env bash
# Build the iOS app (Release) and install + launch it on a connected iPhone.
#
#   bun run ios:deploy                 # first available paired iPhone
#   DEVICE="Marcuss iPhone (2)" bun run ios:deploy   # explicit device name
#
# Needs: Xcode with a valid signing team (project.yml: automatic signing),
# the phone paired (cable or same-network wifi), unlocked, and trusting this
# Mac. Developer Mode must be on (Settings > Privacy & Security).
set -euo pipefail

cd "$(dirname "$0")/.."

SCHEME=GolfMap
BUNDLE_ID=com.marcusandersson.golfmap
DERIVED=ios/.deploy-derived

# The xcodeproj is generated and gitignored — regenerate when missing or when
# project.yml is newer than the last generation.
if [ ! -d ios/GolfMap.xcodeproj ] || [ ios/project.yml -nt ios/GolfMap.xcodeproj/project.pbxproj ]; then
    echo "==> xcodegen"
    (cd ios && xcodegen generate)
fi

# Resolve the target device: $DEVICE by name, else the first available iPhone.
DEVICE_JSON=$(mktemp)
trap 'rm -f "$DEVICE_JSON"' EXIT
xcrun devicectl list devices --json-output "$DEVICE_JSON" >/dev/null

UDID=$(DEVICE="${DEVICE:-}" python3 - "$DEVICE_JSON" <<'PY'
import json, os, sys
wanted = os.environ.get("DEVICE") or None
data = json.load(open(sys.argv[1]))
for d in data["result"]["devices"]:
    props = d.get("deviceProperties", {})
    hw = d.get("hardwareProperties", {})
    name = props.get("name", "")
    if hw.get("deviceType") != "iPhone":
        continue
    if wanted and name != wanted:
        continue
    if "available" not in d.get("connectionProperties", {}).get("pairingState", "") and wanted is None:
        pass  # devicectl reports pairing under varying keys; install will error clearly if unusable
    print(d["identifier"])
    break
PY
)
if [ -z "$UDID" ]; then
    echo "No paired iPhone found (xcrun devicectl list devices). Plug in / pair the phone." >&2
    exit 1
fi
echo "==> Deploying to device $UDID"

echo "==> xcodebuild (Release)"
xcodebuild -project ios/GolfMap.xcodeproj -scheme "$SCHEME" \
    -configuration Release \
    -destination "id=$UDID" \
    -derivedDataPath "$DERIVED" \
    -allowProvisioningUpdates \
    build | grep -E "error:|warning: .*deprecated|BUILD" || true

APP="$DERIVED/Build/Products/Release-iphoneos/$SCHEME.app"
if [ ! -d "$APP" ]; then
    echo "Build failed — $APP missing. Re-run without the grep filter for full output:" >&2
    echo "  xcodebuild -project ios/GolfMap.xcodeproj -scheme $SCHEME -configuration Release -destination id=$UDID -derivedDataPath $DERIVED -allowProvisioningUpdates build" >&2
    exit 1
fi

echo "==> Installing $APP"
xcrun devicectl device install app --device "$UDID" "$APP"

echo "==> Launching $BUNDLE_ID"
# Launch is best-effort: it fails if the phone is locked — the install above
# already succeeded, so just say so instead of failing the whole deploy.
xcrun devicectl device process launch --device "$UDID" "$BUNDLE_ID" \
    || echo "(launch skipped — unlock the phone and open the app manually)"

echo "==> Done"

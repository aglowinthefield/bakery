#!/usr/bin/env bash
# Archive the app on the Mac (visitingstar) and upload it to TestFlight.
# Needs an App Store Connect API key at ~/.appstoreconnect/private_keys/AuthKey_<ASC_KEY_ID>.p8 on the Mac.
# Usage: ASC_KEY_ID=... ASC_ISSUER_ID=... ios/scripts/testflight.sh [build-number]
set -euo pipefail
HOST=${MAC_HOST:-visitingstar}
HERE=$(cd "$(dirname "$0")/.." && pwd)
BUILD=${1:-$(date +%y%m%d%H%M)}
rsync -az --delete --exclude build --exclude '*.xcodeproj' "$HERE/" "$HOST:code/bakery-ios/"
ssh -o BatchMode=yes "$HOST" env KEY="${ASC_KEY_ID:?}" ISSUER="${ASC_ISSUER_ID:?}" BUILD="$BUILD" bash -s <<'REMOTE'
set -euo pipefail
PATH=/opt/homebrew/bin:$PATH xcodegen -s ~/code/bakery-ios/project.yml --project ~/code/bakery-ios >/dev/null
# Homebrew rsync on PATH breaks the IPA step ("--extended-attributes: unknown option"): use system tools only.
export PATH=/usr/bin:/bin:/usr/sbin:/sbin:/Applications/Xcode.app/Contents/Developer/usr/bin
cd ~/code/bakery-ios
AUTH=(-allowProvisioningUpdates -authenticationKeyPath "$HOME/.appstoreconnect/private_keys/AuthKey_$KEY.p8" -authenticationKeyID "$KEY" -authenticationKeyIssuerID "$ISSUER")
rm -rf build/archive build/export
xcodebuild -project Bakery.xcodeproj -scheme Bakery -configuration Release -destination 'generic/platform=iOS' \
  -archivePath build/archive/Bakery.xcarchive CURRENT_PROJECT_VERSION="$BUILD" CODE_SIGNING_ALLOWED=NO archive 2>&1 | grep -E 'error:|ARCHIVE (SUCCEEDED|FAILED)'
cat > build/ExportOptions.plist <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>method</key><string>app-store-connect</string>
<key>destination</key><string>upload</string>
<key>teamID</key><string>MYFY26Q83G</string>
<key>signingStyle</key><string>automatic</string>
</dict></plist>
PLIST
xcodebuild -exportArchive -archivePath build/archive/Bakery.xcarchive -exportOptionsPlist build/ExportOptions.plist \
  -exportPath build/export "${AUTH[@]}" 2>&1 | grep -E 'error:|EXPORT (SUCCEEDED|FAILED)|Upload succeeded|Upload (failed|error)|ERROR'
REMOTE

#!/usr/bin/env bash
# Build the iOS app on the Mac (visitingstar), install it on the booted simulator, launch it,
# and pull a screenshot back. Usage: ios/scripts/sim.sh [build|run|shot NAME] [launch args...]
set -euo pipefail
HOST=${MAC_HOST:-visitingstar}
HERE=$(cd "$(dirname "$0")/.." && pwd)
REMOTE=code/bakery-ios
mode=${1:-run}; shift || true
rsync -az --delete --exclude build --exclude '*.xcodeproj' "$HERE/" "$HOST:$REMOTE/"
ssh -o BatchMode=yes "$HOST" env BAKERY_BOARD="${BAKERY_BOARD:-}" BAKERY_CARD="${BAKERY_CARD:-}" BAKERY_URL="${BAKERY_URL:-}" bash -s -- "$mode" "$@" <<'REMOTE'
set -euo pipefail
export PATH=/opt/homebrew/bin:$PATH
cd ~/code/bakery-ios
mode=$1; shift
xcodegen generate --quiet
DEV=$(xcrun simctl list devices booted | grep -m1 -oE '[0-9A-F-]{36}')
if [ "$mode" = test ]; then
  # TEST_RUNNER_ vars reach the test process; BAKERY_BOARD names the board the flows use.
  rm -f /tmp/bakery-uitest-*.png
  TEST_RUNNER_BAKERY_CARD=${BAKERY_CARD:-} TEST_RUNNER_BAKERY_BOARD=${BAKERY_BOARD:?set BAKERY_BOARD} TEST_RUNNER_BAKERY_URL=${BAKERY_URL:-http://mochi:4317} \
  xcodebuild -project Bakery.xcodeproj -scheme Bakery -sdk iphonesimulator -destination "id=$DEV" \
    -derivedDataPath build CODE_SIGNING_ALLOWED=NO test 2>&1 \
    | grep -E 'error:|Test Case.*(passed|failed|skipped)|skipped|XCTAssert|TEST (SUCCEEDED|FAILED)' | head -60
  exit 0
fi
xcodebuild -project Bakery.xcodeproj -scheme Bakery -configuration Debug -sdk iphonesimulator \
  -destination "id=$DEV" -derivedDataPath build CODE_SIGNING_ALLOWED=NO build 2>&1 \
  | grep -E 'error:|warning: unre|BUILD (SUCCEEDED|FAILED)' | grep -v '^ld: warning' | head -60
test -d build/Build/Products/Debug-iphonesimulator/Bakery.app || exit 1
[ "$mode" = build ] && exit 0
xcrun simctl terminate "$DEV" dev.bakery.ios 2>/dev/null || true
xcrun simctl install "$DEV" build/Build/Products/Debug-iphonesimulator/Bakery.app
if [ "$mode" = shot ]; then
  name=$1; shift
  xcrun simctl launch "$DEV" dev.bakery.ios "$@" >/dev/null
  sleep ${SHOT_WAIT:-5}
  xcrun simctl io "$DEV" screenshot "/tmp/bakery-$name.png" >/dev/null 2>&1
  echo "shot /tmp/bakery-$name.png"
else
  xcrun simctl launch "$DEV" dev.bakery.ios "$@"
fi
REMOTE
if [ "$mode" = test ]; then
  mkdir -p /tmp/bakery-ios-shots
  ssh "$HOST" bash -c "'cd /tmp && tar cf - bakery-uitest-*.png'" | tar xf - -C /tmp/bakery-ios-shots || echo "no screenshots"
  exit 0
fi
if [ "$mode" = shot ]; then
  mkdir -p /tmp/bakery-ios-shots
  scp -q "$HOST:/tmp/bakery-$1.png" "/tmp/bakery-ios-shots/$1.png"
  magick "/tmp/bakery-ios-shots/$1.png" -resize 50% "/tmp/bakery-ios-shots/$1.small.png" 2>/dev/null || true
  echo "/tmp/bakery-ios-shots/$1.small.png"
fi

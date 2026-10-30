#!/usr/bin/env bash
# Keeps a Bakery checkout run with `npm start` (for example under systemd) up to date with origin/main.
#   scripts/update.sh          fetch origin/main only. The server lists the new commits in the UI and installs
#                              them when asked, or by itself while no run is active. The update timer runs this.
#   scripts/update.sh install  fast-forward main, npm install, build the UI into dist-next. The server runs this,
#                              then drains active runs and exits so the service manager restarts it on the new code.
#                              The new server moves dist-next over dist, so the old one serves the matching old UI.
set -euo pipefail
cd "$(dirname "$0")/.."

case ${1:-fetch} in
  fetch)
    git fetch -q origin main
    echo "$(git rev-list --count HEAD..origin/main) update(s) pending."
    ;;
  install)
    git merge --ff-only origin/main
    npm install --no-audit --no-fund
    rm -rf dist-next dist-next.partial
    npx vite build --outDir dist-next.partial --emptyOutDir
    mv dist-next.partial dist-next
    ;;
  *) echo "Usage: scripts/update.sh [fetch|install]" >&2; exit 2 ;;
esac

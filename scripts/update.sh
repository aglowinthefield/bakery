#!/usr/bin/env bash
# Keeps a Bakery checkout run with `npm start` (for example under systemd) up to date with origin/main.
#   scripts/update.sh          fetch origin/main only. The server lists the new commits in the UI and installs
#                              them when asked, or by itself while no run is active. The update timer runs this.
#   scripts/update.sh install  fast-forward main, npm install, build the UI. The server runs this, then drains
#                              active runs and exits so the service manager restarts it on the new code.
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
    npx vite build
    ;;
  *) echo "Usage: scripts/update.sh [fetch|install]" >&2; exit 2 ;;
esac

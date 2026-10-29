#!/usr/bin/env bash
# Update a Bakery checkout run with `npm start` (for example under systemd) to origin/main.
# Pulls, installs, builds, then sends SIGUSR2 to the service: it refuses new runs, waits for
# active ones to finish, and exits so the service manager restarts it on the new code.
# Usage: scripts/update.sh [service-name]   (default: bakery, a systemd user unit)
set -euo pipefail
cd "$(dirname "$0")/.."
service=${1:-bakery}

git fetch -q origin main
if [[ $(git rev-parse HEAD) == $(git rev-parse origin/main) ]]; then echo "Already up to date."; exit 0; fi
git merge --ff-only origin/main
npm install --no-audit --no-fund
npx vite build
systemctl --user kill -s SIGUSR2 --kill-whom=main "$service"
echo "Updated to $(git rev-parse --short HEAD); $service will restart once active runs finish."

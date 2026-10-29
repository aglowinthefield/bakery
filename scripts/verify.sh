#!/usr/bin/env bash
# Bakery's verification command for this repository: set it in the repository settings as `scripts/verify.sh`.
# Unattended review runs it in a scratch merge of the card into main, which has no node_modules, so this
# borrows the main checkout's. The link is ignored (.gitignore says `node_modules`, which matches links too),
# so the merged tree stays clean.
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ ! -e node_modules ]]; then
  main=$(git worktree list --porcelain | sed -n '1s/^worktree //p')
  ln -s "$main/node_modules" node_modules
fi
npx tsc -b
npm test

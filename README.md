# Bakery

A local board per Git repository for Pi work. Boards and manual cards are stored in SQLite. Starting a card creates a dedicated Git worktree and runs Pi there. A successful Pi settlement moves the card to Review, not Done. Bakery never stages, commits, pushes, opens PRs, deploys, or writes to an issue tracker.

## Run

Requires Node 24, Git, and `pi` on your PATH with a configured provider. From this directory:

```sh
npm install
npm run dev
```

Open http://127.0.0.1:5173. For a single production server, run `npm run build && npm start`, then open http://127.0.0.1:4317.

The server binds to loopback. Data and worktrees live under `~/.local/share/bakery/` by default. Override with `BAKERY_DATA_DIR`, `BAKERY_PORT`, or `BAKERY_PI_BIN` for a local test. Do not expose the server on a network: there is no account authentication. The UI is a local operator control surface, not a remote service.

Add a repository by entering its Git root (an absolute path or `~/` path). Bakery keeps a separate board for each repository and stores the canonical root. New cards inherit the selected board's root. Existing cards are grouped by their stored paths when you upgrade.

To repair an incorrect path, edit the board. Bakery moves its cards only if none has an attempt, because attempts keep their worktrees and sessions in the original repository. If a card has an attempt, create a new card on the correct board. Removing a board hides it without deleting cards, runs, or worktrees; add the same repository again to restore it.

A repository needs an initial commit containing the files Pi should work on. Git worktrees start from `HEAD`; uncommitted or untracked files in the original checkout do not appear in the card's worktree. Bakery does not stage or commit files for you.

Creating a board or card does not start Pi. Explicitly start a run; Bakery asks for confirmation because Pi may use paid model tokens. Read the output and inspect the worktree before marking the card Done. The agent is instructed not to stage, commit, push, or publish, but that instruction is **not a sandbox**: only start agents on repositories you trust.

Only one server may own a data directory. If a crash leaves `server.lock`, check whether its recorded PID is still running before removing the lock. After an unexpected server restart, an active card becomes Interrupted and cannot be retried until you inspect its worktree and release it in the GUI. Bakery checks that the recorded PID is not alive before releasing it. This is conservative: an unrelated process that reused the PID also blocks release. Normal Stop ends the child process and marks the attempt Failed. Runs have a 30-minute timeout. Output is a bounded tail of assistant text and tool names, not full tool arguments. Pi's own session holds the full conversation.

## Verification

```sh
npm test
npm run build
```

Tests launch a fake offline Pi command against a temporary Git repository. They do not call a model or test live provider auth.

## Next slices

- Read-only Linear source adapter, keyed by Linear issue ID, with manual import into the same local card model. No Linear writes.
- Better interrupted-process identity checks beyond PID liveness.
- Review handoff and automatic pickup only after the manual start and review loop proves reliable.

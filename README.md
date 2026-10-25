# Bakery

A local board per Git repository for Pi work. Boards and manual cards are stored in SQLite. Starting a card creates a dedicated Git worktree and runs Pi there. A successful Pi settlement moves the card to Review, not Done. Approving reviewed work commits its changes and merges into the local `main` branch before marking the card Done. Bakery does not push, open PRs, deploy, or write to an issue tracker.

## Run

Requires Node 24, Git, and `pi` on your PATH with a configured provider. From this directory:

```sh
npm install
npm run dev
```

Open http://127.0.0.1:5173. For a single production server, run `npm run build && npm start`, then open http://127.0.0.1:4317.

The server binds to loopback. Data and worktrees live under `~/.local/share/bakery/` by default. Override with `BAKERY_DATA_DIR`, `BAKERY_PORT`, or `BAKERY_PI_BIN` for a local test. Do not expose the server on a network: there is no account authentication. The UI is a local operator control surface, not a remote service.

Add a repository by entering its Git root (an absolute path or `~/` path). Bakery expands `~` using the server user's home directory, stores the canonical root, and displays the resulting absolute path. Each repository gets a separate board; new cards inherit its root. Existing cards are grouped by their stored paths when you upgrade.

To repair an incorrect path, edit the board. Bakery moves its cards only if none has an attempt, because attempts keep their worktrees and sessions in the original repository. If a card has an attempt, create a new card on the correct board. To remove a board, open its edit window and use Remove repository. This hides the board without deleting cards, runs, or worktrees; add the same repository again to restore it.

A repository needs an initial commit containing the files Pi should work on. Git worktrees start from `HEAD`; uncommitted or untracked files in the original checkout do not appear in the card's worktree. Starting a run does not stage or commit files for you.

Creating a board or card does not start Pi. Explicitly start a run; it may use paid model tokens. In Settings, turn on "Confirm before starting a run" if you want a confirmation dialog. This preference defaults off and persists in Bakery's SQLite database. Read the output and inspect the worktree before using **Approve and merge**. Approval stages all unignored worktree changes, commits them on the card branch, reconciles that branch with the current local `main` in a temporary worktree, checks for Git conflicts and whitespace errors, then fast-forwards the clean `main` checkout. It does **not** run tests, CI, or push. If approval fails, the card stays in Review and its worktree remains. A merge conflict shows the conflicting files and recovery steps in the card's Review window, with Git output behind a details control. It clears the pending approval. Use **Fix conflict with Pi** to start a new attempt in the card worktree with the conflicting files and current `main` tip in its prompt, or resolve the branch yourself. For this repair, Pi may merge `main` into the card branch and commit the resolution there; it must not change `main`. Review the repaired work before approving again. The action starts Pi and may spend model tokens. The conflict notice survives reloads and failed repair attempts. It hides while Pi works and clears after the run reaches Review, you dismiss it, retry approval, or merge successfully; the card and worktree remain. For other failures that leave a pending approval, use **Withdraw approval** to unlock revision. Withdrawal never removes Git commits or worktrees. If Bakery already moved `main`, it refuses withdrawal and asks you to inspect the result. Only an unrun Ready card can be closed with **Mark done**. The agent is instructed not to stage, commit, push, or publish during its run, but that instruction is **not a sandbox**: only start agents on repositories you trust.

Only one server may own a data directory. If a crash leaves `server.lock`, check whether its recorded PID is still running before removing the lock. After an unexpected server restart, an active card becomes Interrupted and cannot be retried until you inspect its worktree and release it in the GUI. Bakery checks that the recorded PID is not alive before releasing it. This is conservative: an unrelated process that reused the PID also blocks release. Normal Stop ends the child process and marks the attempt Failed. Runs have a 30-minute timeout. Output is a bounded tail of assistant text and per-turn activity summaries (tool counts, reported failures, and changed worktree filenames). Bakery derives these from Pi's existing events and Git without extra model calls; it does not store tool arguments or results in the card transcript. Pi's own session holds the full conversation.

If an older card was marked Done while its reviewed work was left in a worktree, use **Reopen**. Bakery returns it to Review so you can inspect and approve that work without starting Pi again. An already integrated Done card reopens to Ready.

## Verification

```sh
npm test
npm run build
```

Tests launch a fake offline Pi command and exercise local Git integration in temporary repositories. They do not call a model, test live provider auth, or run tests in repositories you add to Bakery. Approval is your verification decision; configurable per-repository checks and CI are future work.

## Next slices

- Read-only Linear source adapter, keyed by Linear issue ID, with manual import into the same local card model. No Linear writes.
- Better interrupted-process identity checks beyond PID liveness.
- Optional per-repository verification and CI before approval, then automatic card creation and pickup once the manual review and integration loop proves reliable.

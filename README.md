# Bakery

A local kanban board that hands coding tasks to [Pi](https://pi.dev) agents, one Git worktree per card. Nothing reaches your `main` branch until you approve it.

![The Bakery board: cards in Triage and Ready lanes](docs/images/board.png)

- [Why Bakery](#why-bakery)
- [Problems it solves](#problems-it-solves)
- [Bakery and Hermes](#bakery-and-hermes)
- [How to use](#how-to-use)
- [A tour](#a-tour)
- [What's next](#whats-next)
- [Contributing](#contributing)
- [Documentation](#documentation)

## Why Bakery

You write down tasks. Agents work on them in the background, each in its own checkout, and you review the diffs when you're ready. You stay the one who decides what lands.

- **Safe by default.** Every card gets its own worktree and branch (`bakery/CARD_ID`). Your checkout is never touched while an agent works.
- **You approve.** A finished run only reaches **Review**. Bakery doesn't push, deploy, or write to an issue tracker unless you turn that on.
- **Local.** One server on `127.0.0.1`, one SQLite file, no account.
- **Parallel.** Several cards can run at once, and cards can wait on other cards.

```mermaid
flowchart LR
  you([You]) -->|browser| ui[Board UI]
  you -->|terminal| cli[bakery-cli]
  ui --> server
  cli --> server
  server[Bakery server<br/>127.0.0.1:4317] --> db[(SQLite)]
  server -->|one per card| wt[Git worktree<br/>branch bakery/CARD_ID]
  server -->|spawns| pi[pi agent]
  pi -->|edits| wt
  wt -->|Approve and merge into local main| main[local main]
```

## Problems it solves

- **Agents step on your work.** Running an agent in your checkout mixes its edits with yours. Bakery gives each task a separate worktree.
- **Parallel tasks collide.** Cards run side by side without sharing files, and dependencies make a card wait until the cards it needs are Done.
- **Changes land unreviewed.** Review shows the diff, lets you comment on lines and send the card back, and only your approval merges it.
- **Work gets lost between sessions.** Cards, attempts, transcripts, costs and review history stay on the board, and a retry continues the same Pi session.
- **Spend is invisible.** Each attempt shows its tokens and cost, the board shows the last 24 hours, and an optional daily budget stops automatic pickup.
- **Babysitting.** Opt-in automatic pickup starts Ready cards for you, and opt-in unattended review verifies, reviews and merges (or opens a PR) without you.

## Bakery and Hermes

[Hermes](https://github.com/NousResearch/hermes-agent) is a general-purpose agent, and it ships its own [Kanban board](https://hermes-agent.nousresearch.com/docs/user-guide/features/kanban) for routing tasks between agent profiles. Bakery is narrower: a board for coding work, built around Git and review of the diff.

| | Bakery | Hermes Kanban |
| --- | --- | --- |
| Board, cards and dependencies | ✅ | ✅ |
| Local SQLite, no account | ✅ | ✅ |
| Review lane before Done | ✅ | ✅ |
| Retries and attempt history | ✅ | ✅ |
| Git worktree per card | ✅ Always, branch `bakery/CARD_ID` | ⚠️ Opt-in; the default workspace is a scratch directory |
| Review the code diff in the UI | ✅ | ❌ |
| Line comments on the diff, sent back as feedback | ✅ | ❌ |
| One-click merge into local `main` | ✅ | ❌ |
| Open a PR on approval | ✅ | ✅ |
| Unattended reviewer agent and verification | ✅ Opt-in, with a verification command | ✅ Automatic `sdlc-review` reviewer |
| Unattended merge into `main` | ✅ Opt-in, with a merge limit | ❌ |
| Per-attempt tokens and cost | ✅ | ❌ |
| 24-hour spend and a daily budget that stops pickup | ✅ | ❌ |
| Dependency graph visualizer | ✅ | ❌ |
| `doctor` command to check your setup | ✅ | ✅ |
| Multiple agent profiles and roles | ❌ Pi only | ✅ |
| Automatic task decomposition | ❌ | ✅ |
| Several boards | ✅ One per repository | ✅ |

✅ means supported, ⚠️ means partly, ❌ means not supported. For Hermes, ❌ means I didn't find it in its Kanban docs, which change quickly, so check them before relying on a row.

Pick Bakery when you want coding tasks isolated per Git worktree, reviewed as diffs, and approved before anything lands. Pick Hermes Kanban when you need a fleet of differently configured agents.

## How to use

You need Node 24, Git, and `pi` on your `PATH` with a configured provider.

```sh
git clone <this repository> && cd bakery
npm install
npm run dev
```

Open http://127.0.0.1:5173, then:

1. **Add a repository** by entering its Git root (an absolute or `~/` path). It needs at least one commit.
2. **Create a card.** New cards start in **Triage**.
3. **Move it to Ready and start it.** Starting a run uses paid model tokens.
4. **Review.** When Pi finishes, read the diff, then **Approve and merge into local main** (or **Approve and open PR** on a GitHub pull request board), or **Request changes**.

Uncommitted files in your checkout don't appear in card worktrees.

From a terminal, `npm run bakery -- add fix the flaky login test` captures a card in the repository you're in, and `npm run bakery -- doctor` checks your setup. For production, run `npm run build && BAKERY_SERVE_UI=1 npm start` and open http://127.0.0.1:4317.

Everything else (the card lifecycle, dependencies, the visualizer, GitHub pull request mode, automation, the full CLI, hosting on another machine) is in the [reference](docs/reference.md).

## Desktop client

The [Tauri desktop client](docs/desktop.md) connects to an existing Bakery server without Electron or a bundled backend. Run `npm run desktop:dev` after installing the Tauri platform prerequisites. See the desktop guide for server access, builds, tests, and current platform limits.

## A tour

These screenshots come from a demo board with real runs. Pi finished one card and you merged it. Another waits in Review, and two cards wait on it.

**Review.** The diff shows what the agent changed against `main`. Comment on lines, send the card back with **Request changes**, or approve.

![The Review tab: approve, request changes, and a unified diff of src/fetch.js](docs/images/review-diff.png)

**Attempts.** Each run keeps its worktree path, a transcript grouped by turn, and its token cost. A retry continues the same Pi session.

![The Attempts tab: one attempt with its transcript and cost](docs/images/card-attempt.png)

**Visualizer.** Dependencies drawn as a graph. Dashed cards are blocked until the card they depend on is Done.

![The Visualizer: one card in Review with two blocked cards depending on it](docs/images/visualizer.png)

## What's next

- Read-only Linear import into local cards, keyed by issue ID. Bakery won't write to Linear.
- Better process identity checks for interrupted runs, beyond PID liveness.
- External CI before approval and automatic card creation.

## Contributing

Issues and pull requests are welcome. Before you open one:

```sh
npm test               # fake offline pi and temporary Git repositories; no model calls
npm run build          # runs format:check, tsc, and vite build
npm run format         # fixes formatting in the covered frontend files
```

- Keep a change focused on one thing, and add or update a test for behavior you change.
- The formatter check covers the board, card details, review, attempts, usage, API, and model modules. It doesn't cover server or test files yet.
- Tests never touch repositories you've added to Bakery.

## Documentation

- [Reference](docs/reference.md): every feature, setting, CLI command and environment variable.
- **Safety:** Pi is told not to commit, push, or publish, but **that isn't a sandbox**. Only run agents on repositories you trust. The server has no authentication and listens on `127.0.0.1` only; see [Safety](docs/reference.md#safety) and [Hosting on another machine](docs/reference.md#hosting-on-another-machine).

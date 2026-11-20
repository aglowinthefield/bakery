# Colleagues and rooms: implementation notes

Where the feature lives and what it deliberately does not do. Behaviour is specified in `colleagues-spec.md` and `colleagues-ui-flow.md`.

- `server/colleague-store.ts`: SQLite tables (`colleagues`, `rooms`, `room_messages`, `room_rounds`, `room_runs`, `room_handoffs`, `room_memory_saves`, `board_card_policies`), created in the Bakery database. Opening the store marks running rounds interrupted and pauses their rooms; nothing is replayed.
- `server/rooms.ts`: routing, rounds, queue, Stop/Resume/Steer, standup, handoff and memory. `server/room-routes.ts` is the HTTP surface under `/api/colleagues`, `/api/rooms` and `/api/boards/:id/new-card-policy`.
- `server/impression.ts`: the Impression client (search and explicit save). Config comes from `IMPRESSION_URL`/`IMPRESSION_TOKEN` or `~/.config/impression/config.json`.
- `src/colleagues.tsx`: the Colleagues and Rooms screens.

## Access model

Each colleague run is a stateless `pi` call (`--no-session --no-extensions --no-mcp --no-skills --no-context-files`). Without an execution project it also gets `--no-tools` and a scratch cwd. With one it gets `--tools read,grep,find,ls` in that repository only. The transcript snapshot is built from delivered messages up to the round's snapshot, so queued text never reaches an earlier run. Each run stores its resolved configuration (`room_runs.config`), shown under "Context used".

## Limits and known gaps

- Screening uses `BAKERY_SCREEN_MODEL` (default `anthropic/claude-haiku-4-5`), at most four checks per round and two interjections.
- A handoff card runs with the board's work model. The assignee's model is recorded in the handoff snapshot but is not applied to the card run.
- Memory saves go to Impression with the source reference inside the content, because the API has no provenance field. Memory retrieval is off per project until enabled in the room.
- Room events use SSE plus a four second refetch; there is no live token streaming beyond the in-progress text.

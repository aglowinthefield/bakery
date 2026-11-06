# Colleagues UI flow

Status: proposed interaction sketch for [the draft spec](colleagues-spec.md), not an implemented or visually approved interface. All names below are illustrative.

## Question

Can an operator move from a familiar specialist to a group discussion and executable work without managing an organization chart?

The proposed answer is a global colleague directory and room list, with project shortcuts inside existing boards. Teams are not required.

## Fit with Bakery today

`src/main.tsx` owns navigation and Today; `src/chat.tsx` owns board chat, its conversation sidebar, model controls, and transcript; `src/chat-sidebar.ts` owns sizing helpers. Extend those familiar navigation patterns rather than opening a separate collaboration application.

The sketches describe information layout, not final styling. Preserve Bakery's existing theme, density, typography, and resizable navigation. Existing card detail and review surfaces remain the execution destination.

## 1. Find or create a colleague

Proposed global navigation:

```text
Today
Rooms                         2 unread
Colleagues

Projects
  Silk
    Board
    Rooms
  Bakery
  Coda
```

Rooms is the global list. A project's Rooms shortcut filters that same list rather than making copies. A room associated with multiple projects can appear under each; opening it always opens the same conversation.

```text
Colleagues                           [New colleague]

Ingest    Silk AI ingestion specialist    Silk
Scout     Search and discovery           Silk
Relay     Reliability                    Bakery, Coda
```

Creating a colleague asks for name and specialty first. Instructions, default model/thinking, and project associations are editable in the same form, with optional configuration behind a disclosure. No team, room, or repository is mandatory for identity creation.

Selecting a colleague offers Chat, Edit, and its project associations. Chat opens a direct room; choosing whether to reuse an existing direct room or start a fresh topic remains a design decision.

## 2. Start a room

```text
New room

Topic          [Ingestion quality                  ]
Participants   [Ingest] [Scout] [+ Add]
Projects       [Silk] [+ Add]
Lead           [Ingest v]
Participation  [Lead + important interjections v]

[Create room]
```

Projects supply intended context, not new tool permissions. A context disclosure must distinguish selected projects from authorized resources. A projectless room is valid and must not silently inherit whichever board was previously open.

Creating a direct chat preselects its colleague as lead. A group room requires a lead among its active participants. Removing the lead requires selecting a replacement before further unaddressed rounds.

## 3. Discuss

```text
Ingestion quality                 [Participants 2] [Context]
Projects: Silk                    [Run standup]

You
Why do retries create duplicate media?

Ingest · lead
...answer...
                         [Context used] [Create card]

Scout · interjection
One dependency: ranking still uses the original metadata.

---------------------------------------------------------
Responding: Ingest       Mode: Lead + important interjections
[Message, or @mention a colleague...                     ]
[Ask everyone]                                    [Send]
```

The composer previews who will answer before sending. Selecting Ask everyone changes the next send's target; it does not submit an empty question. Mentions resolve to participant IDs, not ambiguous display names.

Use distinct labels for primary responses, interjections, standup reports, and system updates. Keep tool details collapsed using the existing transcript pattern. A participant list is not a row of model selectors: model configuration belongs behind colleague/run details.

Show the active phase, such as primary responses or checking for important contributions, and attributable usage. Mention-only is available from room participation settings. Do not show a separate no-contribution message from every silent colleague.

## 4. Queue and steer

```text
Ingest is responding...                         [Stop]

Queued messages (2)
1  Compare this with last week's failure.     [Edit] [Remove]
2  Preserve the schema; no migration.         [Steer now]
                                             [Edit] [Remove]
```

Queued messages remain visibly distinct from context already delivered to respondents. Steer now promotes message 2 without reordering the remaining queue. Mark the old response interrupted and show a small system entry identifying the steering message.

After Stop, show Queue paused and a Resume queue action. Sending another message while paused should not silently resume pending paid work; proposed behavior is to queue it until Resume queue or Steer now.

Retry appears on a failed response, not on the entire transcript. It identifies the original question and context so retry does not look like a new room-wide request.

## 5. Inspect context and remember

Context used opens a side panel for the selected response:

```text
Context used for Ingest's response

Projects        Silk
Configuration   Ingest · model/thinking used for this run
Conversation    Through your retry question
Memories        3 from Impression
  Retry constraint        [source] [Open in Impression]
  Older pipeline decision [staleness warning]
Tools/workspace Explicit execution context, if any
```

Display actual supplied context, not a retrospective guess. Memory-unavailable states appear here and beside the response. Credentials and raw secret-bearing tool configuration never appear in this panel.

Remember on selected text opens a small save preview with editable content, User/Project scope, explicit project selection when needed, and source message references. Show Saved only after acknowledgment. Keep failed saves visible with Retry. Editing and correcting stored knowledge links to Impression rather than creating a parallel memory editor.

## 6. Run a standup

Run standup shows the participants and project scope before the action. The action itself starts the bounded paid round; it does not need a second confirmation after configuration is visible.

```text
Standup · Silk · since previous cutoff

Ingest
Completed: card reference
Active: card reference
Blocked: evidence or no known blocker
Proposed next: suggestion, not an assignment

Scout
Update unavailable                       [Retry report]

Summary · partial
...completed work, blockers, missing Scout report...
```

The first standup needs a visible reporting window; proposed default is the previous 24 hours. Later standups use the previous cutoff. The summary identifies its generator and source reports. Who generates the summary and its model/cost are still open.

Do not put a task-launching button beside every speculative next step. An explicit Create card action can open the normal handoff for a selected proposal.

## 7. Hand off a card

```text
Create card

Board         [Silk v]
Assigned to   [Ingest v]        [Use board default]
Title         [Retry enrichment without duplicate imports]
Goal          [...]
Constraints   [Preserve existing schema]
Acceptance    [...]
Sources       [2 selected messages] [1 memory reference]

Destination   [Ready v]         Board default
Auto pickup is on. This queues paid work.

[Cancel]                              [Create & queue work]
```

Preselecting the originating colleague remains a proposal. Show independent review separately rather than implying the implementer approves itself. The board policy controls destination, with an intentional Triage override.

A confirmed handoff produces a linked card entry in the room. Creating from a conversational request may use the same policy without forcing a second approval dialog; the system must still expose destination and paid-work consequences clearly. Repeated clicks or retried creation must not duplicate cards.

Later needs-input and review events return as compact linked system updates. They do not summon everyone or start a room round. Open the existing card detail/review surface for full evidence.

## Walkthrough to validate

1. Create Ingest, associate it with Silk, and open a direct room.
2. Add Scout and make the topic Ingestion quality, without creating a team.
3. Send an ordinary message and see Ingest answer, with one useful Scout interjection.
4. Queue two messages, steer the second, then inspect interrupted and pending states.
5. Save a selected decision and inspect its source/scope; simulate an unavailable memory service.
6. Run a standup with a missing participant report and a clearly partial summary.
7. Create a Ready card with paid pickup visible; see a linked review update return without triggering responses.

## Decisions exposed by this sketch

- Is Rooms plus Colleagues sufficient global navigation, with project-level filtered shortcuts?
- Should Chat reuse a direct room, offer recent topics, or always create a fresh topic?
- Confirm paused-queue sending behavior and the first standup reporting window.
- Confirm originating-colleague assignment and handoff presentation for natural-language creation requests.
- Define membership-history access and resource authorization before showing real cross-project content.

This is a text wireframe only. A clickable fixture-backed prototype and human visual review remain future work; no rendered UI or live memory integration was verified.

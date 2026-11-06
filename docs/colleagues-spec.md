# Persistent colleagues and rooms

Status: draft product spec, not authorization for implementation runs. Product direction is agreed; proposals and open decisions below are not implementation requirements yet.

## Purpose

Work with persistent AI colleagues across projects, discuss work together in rooms, and carry relevant knowledge into execution without repeating context.

Success means less repeated explanation, fewer domain misunderstandings, and less effort turning conversation into work. Names alone do not improve agent performance. Track cost and time per completed task as well as operator effort.

## Vocabulary

| Concept | Meaning |
| --- | --- |
| Colleague | Persistent AI identity with a name, specialty, instructions, and model defaults. The product name remains provisional. |
| Specialty | Subject or kind of work the colleague focuses on. It guides context and suggestions, not permissions. |
| Project association | Connects a colleague to a project, with relevant context and configuration. It does not grant unrestricted access. |
| Room | Persistent conversation with the operator and selected colleagues, with explicit project context. |
| Lead | The colleague responsible for unaddressed messages in one room, not a permanent rank. |
| Assignment | Responsibility for a card, such as implementation or review. |
| Run | One execution with explicit configuration, workspace, and permission scope. |
| Round | Bounded responses initiated by one operator message or room action. A round can contain several runs. |
| Team | Optional reusable grouping of colleagues. Deferred from the MVP. |

Identity is independent of repositories and models. A colleague can specialize entirely in Silk ingestion while working across associated repositories. Changing the model does not create a new colleague.

Reviewer and implementer are assignments, not necessarily separate identities.

Bakery owns identity, conversations, assignments, and execution context. Impression owns saved knowledge and retrieval. Bakery remains authoritative for card and run status.

## Agreed MVP scope

- Create and edit colleagues with specialties, instructions, and model defaults.
- Associate colleagues with projects without duplicating their identities.
- Direct and group rooms. A direct chat is a room with one colleague.
- A visible, changeable lead for each room.
- Mentions, Ask everyone, useful unsolicited interjections, and manual standups.
- Queue messages by default, with Stop and Steer now controls.
- Scoped Impression retrieval and explicit memory saving.
- Colleague selection for cards and an inspectable conversation-to-task handoff.
- A context-used view showing supplied memories, scopes, and source references.
- Existing board chats and card work remain usable without colleagues.

Do not require team creation before opening a room. Rooms have their own membership and explicit project context; they are not limited to one board's roster.

Deferred: team hierarchies, automatic work allocation, scheduled standups, autonomous ongoing discussions, automatic memory extraction by Bakery, and a second memory database/editor in Bakery.

## Agreed conversation behavior

### Response routing

| Operator action | Primary respondents |
| --- | --- |
| Ordinary message | Room lead |
| Mention one colleague | Mentioned colleague instead of the lead |
| Mention several colleagues | Each mentioned colleague once |
| Ask everyone | Every active colleague once |
| Run standup | Every active colleague gives an activity update, followed by a combined summary |

Ask everyone supplies the same conversation snapshot to each respondent so answers can run independently. Participants do not see sibling answers from that same pass. A subsequent operator follow-up can ask one colleague to respond to another's point.

### Important interjections

After primary responses, other participants may raise a material correction, overlooked dependency or risk, decision-changing evidence, or a relevant blocker. Agreement and paraphrasing are insufficient. Silence is expected most of the time.

At most two unsolicited contributions are admitted per operator-message round. They are short points that can be explored in a follow-up. Interjections cannot start further automatic rounds. Ask everyone and standups do not receive an additional interjection pass.

The default room mode is lead plus important interjections. Mention-only is an alternative for quieter or cheaper rooms. Screening has a cost even when everyone stays silent; background activity and cost must be visible. A lightweight screening pass is a technical proposal, not a chosen implementation.

### Queue and steering

Messages sent during an active round are saved immediately and queued. They do not interrupt by default.

Steer now on a queued message:

1. Cancels the current round and pending interjections.
2. Preserves completed answers and marks partial answers interrupted.
3. Promotes the selected message into a new round using the conversation so far and its normal addressing rules.
4. Leaves other queued messages in their existing relative order, then resumes queue processing. The promoted message is not executed twice.

Other queued messages remain editable or removable. A promoted message must not cause later queued messages to leak into its input just because they were already saved.

Stop cancels the current round and pauses the queue. Steer now replaces the current round and resumes the queue. Late output from a cancelled round cannot become a new completed answer. Neither action rolls back tool actions already performed.

### Standups

Run standup is manual in the MVP. Each colleague reports completed work, active work and blockers, and proposed next work, with card/run references. Proposed work is distinct from assigned work. No activity means no activity, not an invented update.

Bakery supplies current task evidence; Impression supplies background. The standup ends after the combined summary. It does not start work, change assignments, or launch a debate.

## Agreed creation policy

New cards is a board setting with Ready by default and Triage by default options. Room handoffs inherit the target board's policy, with a per-card override.

- Ready by default puts clear, actionable work in Ready. Existing pickup settings control when it starts.
- Triage by default holds new work for review.
- Unresolved scope or product decisions require clarification or an explicit Triage card, not invented requirements.

Buttons show the consequence: Create in Ready, Create & queue work when pickup is on, or Create in Triage. Explain paid execution when configuring the policy and at the action; do not require repetitive confirmation dialogs after the operator has chosen it.

An operator request to create actionable work can create and queue it under that policy. A colleague's casual suggestion or standup proposal does not itself authorize work.

## Proposed handoff and recovery details

These defaults were discussed but have not all received separate operator decisions.

### Room to card

Prepare an inspectable draft with target board, assignee, goal, constraints, acceptance criteria, selected decisions, and source references. Do not copy the entire transcript by default. Essential requirements belong in the card even when memory references are attached.

Proposed assignment default: preselect the originating colleague, with an override or the board's default worker. Review remains a separate independent assignment. This default still needs a decision.

Bring linked needs-input and review updates back to the source room, without streaming every tool call or automatically triggering discussion.

### Recovery

- Preserve successful responses when one participant fails. Retry only the failed response with its original context snapshot; do not repeat successful answers or restart interjections.
- If Impression is unavailable, continue with a visible shared-memory-unavailable notice. Do not imply memory was checked. A failed save stays visibly unsaved with a retry action.
- Record a standup activity cutoff so the next standup includes work occurring during generation. Mark missing reports in partial summaries rather than treating failures as no activity.

## Memory and access boundaries

Proposed initial scopes are operator/user knowledge and project knowledge in Impression; colleague instructions remain in Bakery. Conversation transcripts remain room-local unless deliberately attached or extracted. Do not introduce private colleague experience stores in the MVP: a useful project fact should be discoverable by another authorized colleague.

Every explicit save needs a chosen scope and source reference. Retrieval should expose memory identifiers and staleness warnings. Current repository evidence outranks old memory. Memory never grants permission.

Project association and room participation do not automatically grant repository, credential, tool, or write access. Cross-project rooms need explicit retrieval targets and explicit execution workspaces. An agent must not read another room's transcript solely because its identity participates in both.

## Integration evidence

Inspected local Bakery commit `fa38120` and local Impression commit `3509cd0`. These observations describe those checkouts, not deployed capabilities.

| Current owner | Observation and consequence |
| --- | --- |
| `server/board.ts`, `Chat`, `ChatMessage` | Chats have a board ID and model settings. Messages have user/agent/error roles, without colleague attribution. Rooms need explicit participant and speaker identities. |
| `server/chat.ts`, `ChatRunner.send` | One Pi session per chat; a concurrent send throws `The agent is still answering the previous message`. Room rounds and durable queued messages need new behavior. |
| `server/chat.ts`, `chatSystemPrompt` | Prompts assume a single board and the repository's main checkout. Do not extend that assumption into unrestricted multi-project execution. |
| `server/agent-models.ts` | Work/conflict/review/draft model settings already exist, with repository/global inheritance and per-chat choices. Colleague defaults must integrate with these rather than replace them silently. |
| `server/worker.ts` | Card implementation already has dedicated worktrees and sessions. Reuse that execution lifecycle rather than turning a room into an implementation workspace. |
| Impression `packages/mcp/src/server.ts` | Search and add tools exist. Both infer project from cwd; search accepts query/limit, and add accepts content and project/user scope. Multi-project selection is not an MCP parameter today. |
| Impression `packages/shared/src/project.ts` | Project identity normalizes git remotes and falls back to paths. Map Bakery boards to this identity rather than inventing another memory namespace. |
| Impression `README.md` | Documents HTTP search filters, anchors/staleness, and extraction hooks. README descriptions are not proof of deployed authorization or availability. |

The MCP add tool does not expose a structured room/message source parameter. Verify the HTTP contract before choosing structured provenance or a source link in content. Bakery must not claim that this adapter is already implemented.

Impression's optional Pi extension performs automatic session capture. Explicit-only Bakery saving requires checking the effective hook configuration; omitting a Bakery extraction feature alone does not disable installed hooks.

No live Impression API request or access-boundary test was performed for this draft. No integration code has changed.

## Acceptance scenarios

1. Create a Silk ingestion colleague, associate it with Silk, and use it in a fresh chat and a card without duplicating its identity. Changing model preserves identity/history.
2. In a group room, an ordinary message gets a lead response. An explicit mention chooses its respondent. A material overlooked dependency admits an interjection; agreement does not. No round admits more than two unsolicited contributions or recursively continues itself.
3. Ask everyone produces one independently contextualized response per participant. A failed participant can be retried without duplicating successful responses.
4. Send messages during a round. They persist in order. Steer the second queued message: the old round stops, the promoted message runs once, and remaining messages retain order. Late cancelled output stays fenced out.
5. Stop pauses pending work. Restarting the server must not silently replay completed responses or lose queued operator messages; exact crash recovery is still to be designed.
6. A manual standup references actual card/run activity, separates proposals from assignments, and ends after its summary. Missing reports are visible and do not launch work.
7. Save a scoped decision explicitly, then retrieve and apply it in a fresh chat/card. Display its source and memory identifier. Do not expose an unrelated project's memories or another room's transcript.
8. With Impression unavailable, show the degraded context state. A failed save remains unsaved. Essential card requirements remain readable without retrieval.
9. A Ready-default board queues an actionable requested task without a separate Triage step. A Triage override parks it. Unresolved decisions and casual standup suggestions do not start paid work.
10. Existing board chats and ordinary cards remain functional without colleague setup. Implementation and independent review remain separate.

## Open decisions before implementation

- Settle the product name for the persistent individual; specialty is agreed.
- Confirm the proposed originating-colleague assignment default and model-setting precedence.
- Confirm handoff and recovery proposals, including degraded-memory operation.
- Define explicit room project context, access enforcement, and what newly invited participants can read.
- Choose screening, token/spend budgets, interjection selection when more than two qualify, and summary responsibility.
- Define queue persistence, crash recovery, resume controls, and cancellation behavior across Pi processes.
- Verify Impression HTTP contracts, effective Pi hooks, provenance, scope isolation, and retrieval failure behavior.

## Next design artifact

Sketch colleague setup, room membership/context, the composer with visible lead, queued-message steering, standups, context-used inspection, and card handoff. Check this flow against existing Bakery UI before creating implementation cards. Keep this spec's agreed behavior separate from unresolved proposals during that pass.

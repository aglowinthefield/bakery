import type { AutoReviewJob, Card, CardEvent, CardStatus, Run } from "./board.js";

/** One line in a card's history, oldest first. `from`/`to` are set when the line is a status change. */
export type CardHistoryEntry = { at: string; from: CardStatus | null; to: CardStatus | null; text: string; detail?: string };

/**
 * A card's history: when it was created, every status change with its reason, notes such as a failed restart, and the
 * agent reviewer's verdicts. Status changes were only recorded from card_events onward, so runs that started before the
 * card's first recorded event are rebuilt from the runs table instead.
 */
export function cardHistory(card: Card, events: CardEvent[], runs: Run[], reviews: AutoReviewJob[]): CardHistoryEntry[] {
  const entries: CardHistoryEntry[] = [{ at: card.createdAt, from: null, to: null, text: "Card created" }];
  for (const event of events) entries.push({ at: event.at, from: event.fromStatus, to: event.toStatus, text: event.reason || "Status changed" });
  const recordedSince = events[0]?.at;
  for (const run of runs) {
    if (recordedSince && run.startedAt >= recordedSince) continue;
    entries.push({ at: run.startedAt, from: null, to: "running", text: `Attempt ${run.attempt} started${run.startedBy === "auto" ? " by auto-pickup" : ""}` });
    if (!run.finishedAt || run.status === "running") continue;
    const text = run.status === "review" ? `Attempt ${run.attempt} finished; waiting for review`
      : run.status === "interrupted" ? `Attempt ${run.attempt} was interrupted`
        : `Attempt ${run.attempt} failed`;
    entries.push({ at: run.finishedAt, from: null, to: run.status, text, detail: run.error ?? undefined });
  }
  const attempts = new Map(runs.map(run => [run.id, run.attempt]));
  for (const review of reviews) {
    const attempt = attempts.get(review.runId), of = attempt ? ` of attempt ${attempt}` : "";
    if (review.state === "running") { entries.push({ at: review.startedAt, from: null, to: null, text: `Agent review${of} started`, detail: review.details || undefined }); continue; }
    const at = review.finishedAt ?? review.startedAt;
    if (review.state === "merged") { entries.push({ at, from: null, to: null, text: `Agent reviewer approved attempt ${attempt ?? "?"} and Bakery merged it`, detail: review.details || undefined }); continue; }
    if (review.state === "pull_request") { entries.push({ at, from: null, to: null, text: `Agent reviewer approved attempt ${attempt ?? "?"} and Bakery opened its pull request`, detail: review.details || undefined }); continue; }
    const sentBack = review.details.startsWith("Sent back to the implementer: ");
    entries.push({
      at, from: null, to: null,
      text: sentBack ? `Agent reviewer requested changes${of}` : review.details.startsWith("Agent approved: ") ? `Agent reviewer approved attempt ${attempt ?? "?"}; merging is up to you` : `Agent review${of} left this for you`,
      detail: review.details.replace(/^(Sent back to the implementer|Agent approved): /, "") || undefined,
    });
  }
  // Stable sort: same-instant entries keep insertion order (created, recorded events, rebuilt runs, reviews).
  return entries.sort((a, b) => a.at.localeCompare(b.at));
}

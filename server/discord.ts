import type { Board, Run } from "./board.js";

type Post = (url: string, init: { method: "POST"; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number }>;

/** Posts a message when a run finishes: green for review, red for failed. Needs a Discord webhook URL; without one it does nothing. */
export class Discord {
  constructor(private readonly board: Board, private readonly url: string | undefined, private readonly post: Post = fetch) {
    if (url) board.onRun((event, run) => event === "finished" ? this.finished(run) : undefined);
  }

  /** Discord caps embed titles at 256 characters and descriptions at 4096. Interrupted runs say nothing: they were stopped on purpose. */
  async finished(run: Run): Promise<void> {
    if (!this.url || (run.status !== "review" && run.status !== "failed")) return;
    const card = this.board.getCard(run.cardId);
    const ok = run.status === "review";
    const detail = ok ? run.report ?? "" : run.error ?? "unknown error";
    const embed = {
      title: `${ok ? "Ready for review" : "Run failed"}: ${card?.title ?? run.cardId}`.slice(0, 256),
      description: detail.slice(0, 1000),
      color: ok ? 0x2ecc71 : 0xe74c3c,
      footer: { text: `attempt ${run.attempt} · $${Number(run.cost ?? 0).toFixed(2)}` },
    };
    const res = await this.post(this.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ embeds: [embed], allowed_mentions: { parse: [] } }) });
    if (!res.ok) throw new Error(`Discord webhook returned ${res.status}`);
  }
}

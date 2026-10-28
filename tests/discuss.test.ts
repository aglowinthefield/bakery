import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../server/board.js";
import { discuss, discussionPrompt } from "../server/discuss.js";

test("discussion messages persist per card in order", () => {
  const dir = mkdtempSync(join(tmpdir(), "bakery-discuss-"));
  try {
    const board = new Board(join(dir, "board.sqlite"));
    const a = board.createCard({ title: "A", body: "", repo: dir }), b = board.createCard({ title: "B", body: "", repo: dir });
    board.addDiscussionMessage(a.id, "user", "why?");
    board.addDiscussionMessage(a.id, "agent", "because");
    board.addDiscussionMessage(b.id, "user", "other");
    assert.deepEqual(board.listDiscussion(a.id).map(item => [item.role, item.body]), [["user", "why?"], ["agent", "because"]]);
    board.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the discussion prompt carries the card, report and recent chat, and forbids edits", () => {
  const dir = mkdtempSync(join(tmpdir(), "bakery-discuss-"));
  try {
    const board = new Board(join(dir, "board.sqlite"));
    const card = board.createCard({ title: "Fix feed", body: "Details here", repo: dir });
    const history = [board.addDiscussionMessage(card.id, "user", "earlier question")];
    const prompt = discussionPrompt(card, undefined, history, "new question");
    for (const text of ["Fix feed", "Details here", "Operator: earlier question", "Operator: new question", "Do NOT edit"]) assert.ok(prompt.includes(text), text);
    board.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("discuss returns Pi's reply and reports failures", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bakery-discuss-"));
  try {
    const ok = join(dir, "pi-ok"), bad = join(dir, "pi-bad");
    writeFileSync(ok, `#!/bin/sh
echo '{"type":"message_end","message":{"role":"assistant","stopReason":"stop","content":[{"type":"text","text":"hello there"}]}}'
echo '{"type":"agent_settled"}'
`);
    writeFileSync(bad, "#!/bin/sh\nexit 3\n");
    chmodSync(ok, 0o755); chmodSync(bad, 0o755);
    assert.equal(await discuss({ prompt: "hi", cwd: dir, piBin: ok, models: [] }), "hello there");
    await assert.rejects(discuss({ prompt: "hi", cwd: dir, piBin: bad, models: [] }), /Pi failed \(3\)/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

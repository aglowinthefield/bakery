import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Board } from "../server/board.js";

const withBoard = (run: (board: Board, dir: string) => void) => {
  const dir = mkdtempSync(join(tmpdir(), "bakery-new-cards-"));
  const board = new Board(join(dir, "board.sqlite"));
  try {
    run(board, dir);
  } finally {
    board.close();
    rmSync(dir, { recursive: true, force: true });
  }
};

test("the first outside card on an implicitly created board counts as new", () => {
  withBoard((board, dir) => {
    // createCard creates the board itself; nothing was seen before it.
    const card = board.createCard({
      title: "From the CLI",
      body: "",
      repo: dir,
    });
    assert.equal(board.newCardCounts()[dir], 1);
    assert.deepEqual(board.markCardsSeen(board.listBoards()[0].id, [card.id]), [
      card.id,
    ]);
    assert.equal(board.newCardCounts()[dir] ?? 0, 0);
  });
});

test("cards created in the same instant are tracked one by one", () => {
  withBoard((board, dir) => {
    mock.timers.enable({
      apis: ["Date"],
      now: new Date("2026-01-01T00:00:00.000Z"),
    });
    try {
      const first = board.createCard({ title: "A", body: "", repo: dir });
      const id = board.listBoards()[0].id;
      assert.deepEqual(board.markCardsSeen(id, [first.id]), [first.id]);
      const second = board.createCard({ title: "B", body: "", repo: dir });
      assert.equal(second.createdAt, first.createdAt);
      assert.equal(board.newCardCounts()[dir], 1);
      assert.deepEqual(board.markCardsSeen(id, [first.id, second.id]), [
        second.id,
      ]);
    } finally {
      mock.timers.reset();
    }
  });
});

test("acknowledging leaves cards the screen never loaded, UI cards and repeats alone", () => {
  withBoard((board, dir) => {
    const seen = board.createCard({ title: "Loaded", body: "", repo: dir });
    const later = board.createCard({
      title: "Arrived after loading",
      body: "",
      repo: dir,
    });
    const ui = board.createCard({
      title: "Typed",
      body: "",
      repo: dir,
      origin: "ui",
    });
    const id = board.listBoards()[0].id;
    assert.equal(board.newCardCounts()[dir], 2);
    assert.deepEqual(board.markCardsSeen(id, [seen.id, ui.id]), [seen.id]);
    assert.equal(board.newCardCounts()[dir], 1);
    assert.deepEqual(board.markCardsSeen(id, [seen.id]), []);
    assert.deepEqual(board.markCardsSeen(id, [later.id]), [later.id]);
    assert.throws(() => board.markCardsSeen("missing", []), /Board not found/);
  });
});

test("cards that exist before the upgrade are not new", () => {
  const dir = mkdtempSync(join(tmpdir(), "bakery-new-cards-"));
  try {
    const file = join(dir, "board.sqlite");
    const first = new Board(file);
    first.createCard({ title: "Old", body: "", repo: dir });
    first.close();
    const raw = new DatabaseSync(file);
    raw.exec("ALTER TABLE cards DROP COLUMN unseen");
    raw.close();
    const upgraded = new Board(file);
    assert.equal(upgraded.newCardCounts()[dir] ?? 0, 0);
    upgraded.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

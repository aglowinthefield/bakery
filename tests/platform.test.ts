import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { command } from "../server/platform.js";

function withDir(fn: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "bakery-platform-"));
  try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("commands are untouched off Windows", () => {
  assert.deepEqual(command("pi", ["-x"], "linux"), ["pi", ["-x"]]);
});

test("on Windows an npm .cmd shim runs its script under node", () => withDir(dir => {
  mkdirSync(join(dir, "node_modules", "pi", "dist"), { recursive: true });
  writeFileSync(join(dir, "node_modules", "pi", "dist", "cli.js"), "");
  // Named in PATHEXT case: Windows matches extensions case-insensitively, but this test may run on a case-sensitive disk.
  writeFileSync(join(dir, "pi.CMD"), '@ECHO off\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\pi\\dist\\cli.js" %*\r\n');
  const [file, args] = command("pi", ["--print", "a \"quoted\"\nprompt"], "win32", { PATH: dir, PATHEXT: ".EXE;.CMD" });
  assert.equal(file, process.execPath);
  assert.deepEqual(args, [join(dir, "node_modules", "pi", "dist", "cli.js"), "--print", "a \"quoted\"\nprompt"]);
}));

test("on Windows an .exe on PATH is resolved and an unknown name is left alone", () => withDir(dir => {
  writeFileSync(join(dir, "wt.EXE"), "");
  assert.deepEqual(command("wt", ["--version"], "win32", { PATH: dir, PATHEXT: ".EXE" }), [join(dir, "wt.EXE"), ["--version"]]);
  assert.deepEqual(command("nope", [], "win32", { PATH: dir, PATHEXT: ".EXE" }), ["nope", []]);
}));

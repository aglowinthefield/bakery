import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../scripts/release.mjs", import.meta.url));

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "bakery-release-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "T");
  git(dir, "config", "commit.gpgsign", "false");
  git(dir, "config", "tag.gpgsign", "false");
  mkdirSync(join(dir, "scripts"));
  mkdirSync(join(dir, "src-tauri"));
  copyFileSync(script, join(dir, "scripts/release.mjs"));
  const json = (v: object) => `${JSON.stringify(v, null, 2)}\n`;
  writeFileSync(join(dir, "package.json"), json({ name: "demo", version: "0.1.0" }));
  writeFileSync(join(dir, "package-lock.json"), json({ name: "demo", version: "0.1.0", packages: { "": { name: "demo", version: "0.1.0" }, "node_modules/x": { version: "9.9.9" } } }));
  writeFileSync(join(dir, "src-tauri/tauri.conf.json"), json({ productName: "Demo", version: "0.1.0" }));
  writeFileSync(join(dir, "src-tauri/Cargo.toml"), '[package]\nname = "demo-desktop"\nversion = "0.1.0"\n\n[dependencies]\nserde = { version = "1" }\n');
  writeFileSync(join(dir, "src-tauri/Cargo.lock"), '[[package]]\nname = "serde"\nversion = "1.0.0"\n\n[[package]]\nname = "demo-desktop"\nversion = "0.1.0"\n');
  writeFileSync(join(dir, "CHANGELOG.md"), "# Changelog\n\n## Unreleased\n");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "Initial");
  return dir;
}

function merge(dir: string, branch: string, subject: string) {
  git(dir, "checkout", "-q", "-b", branch);
  writeFileSync(join(dir, `${branch}.txt`), branch);
  git(dir, "add", ".");
  git(dir, "commit", "-qm", `Work on ${branch}`);
  git(dir, "checkout", "-q", "main");
  git(dir, "merge", "--no-ff", "-q", branch, "-m", subject);
}

const run = (dir: string, ...args: string[]) => spawnSync("node", ["scripts/release.mjs", ...args], { cwd: dir, encoding: "utf8" });

test("release bumps versions, writes the changelog, commits and tags without pushing", () => {
  const dir = fixture();
  try {
    merge(dir, "one", "Merge card: First change");
    merge(dir, "two", "Merge card: Second change");
    const first = run(dir, "0.2.0");
    assert.equal(first.status, 0, first.stderr);

    const read = (p: string) => readFileSync(join(dir, p), "utf8");
    assert.equal(JSON.parse(read("package.json")).version, "0.2.0");
    const lock = JSON.parse(read("package-lock.json"));
    assert.equal(lock.version, "0.2.0");
    assert.equal(lock.packages[""].version, "0.2.0");
    assert.equal(lock.packages["node_modules/x"].version, "9.9.9");
    assert.equal(JSON.parse(read("src-tauri/tauri.conf.json")).version, "0.2.0");
    assert.match(read("src-tauri/Cargo.toml"), /name = "demo-desktop"\nversion = "0.2.0"/);
    assert.match(read("src-tauri/Cargo.toml"), /serde = \{ version = "1" \}/);
    const cargoLock = read("src-tauri/Cargo.lock");
    assert.match(cargoLock, /name = "serde"\nversion = "1.0.0"/);
    assert.match(cargoLock, /name = "demo-desktop"\nversion = "0.2.0"/);

    const changelog = read("CHANGELOG.md");
    assert.match(changelog, /^# Changelog\n\n## Unreleased\n\n## 0\.2\.0 - \d{4}-\d{2}-\d{2}\n\n- Second change\n- First change\n$/);
    assert.equal(run(dir, "--notes", "v0.2.0").stdout.trim(), "- Second change\n- First change");

    assert.equal(git(dir, "tag", "--list"), "v0.2.0");
    assert.equal(git(dir, "log", "-1", "--format=%s"), "Release v0.2.0");
    assert.equal(git(dir, "rev-parse", "v0.2.0^{commit}"), git(dir, "rev-parse", "HEAD"));
    assert.equal(git(dir, "status", "--porcelain"), "");

    // The next release only lists merges since the previous tag.
    merge(dir, "three", "Merge card: Third change");
    assert.equal(run(dir, "0.3.0").status, 0);
    assert.equal(run(dir, "--notes", "0.3.0").stdout.trim(), "- Third change");
    assert.equal(run(dir, "0.3.0").status, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("release rejects bad versions and dirty trees", () => {
  const dir = fixture();
  try {
    assert.equal(run(dir, "banana").status, 1);
    writeFileSync(join(dir, "stray.txt"), "x");
    const dirty = run(dir, "0.2.0");
    assert.equal(dirty.status, 1);
    assert.match(dirty.stderr, /not clean/);
    assert.equal(git(dir, "tag", "--list"), "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

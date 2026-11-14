#!/usr/bin/env node
// Cut a release: npm run release -- 0.2.0
// Bumps versions, prepends a CHANGELOG.md section built from merge commit subjects since the last tag,
// commits, and tags v0.2.0. It never pushes. `--notes 0.2.0` prints that version's changelog section.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const semver = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const fail = (message) => {
  console.error(`release: ${message}`);
  process.exit(1);
};
const read = (path) => readFileSync(join(root, path), "utf8");
const write = (path, text) => writeFileSync(join(root, path), text);

function section(changelog, version) {
  const lines = changelog.split("\n");
  const start = lines.findIndex((line) => line.startsWith(`## ${version} `) || line === `## ${version}`);
  if (start < 0) return null;
  let end = lines.findIndex((line, i) => i > start && line.startsWith("## "));
  if (end < 0) end = lines.length;
  return lines.slice(start + 1, end).join("\n").trim();
}

function bumpJson(path, version, paths) {
  const data = JSON.parse(read(path));
  let changed = false;
  for (const get of paths) {
    const target = get(data);
    if (target && "version" in target) {
      target.version = version;
      changed = true;
    }
  }
  if (changed) write(path, `${JSON.stringify(data, null, 2)}\n`);
  return changed;
}

function bumpToml(path, version, packageName) {
  const text = read(path);
  // Only the `version` line right after the package's own name line (Cargo.lock) or in [package] (Cargo.toml).
  const pattern = packageName
    ? new RegExp(`(name = "${packageName}"\\r?\\nversion = ")[^"]*(")`)
    : /(\[package\][^[]*?\nversion = ")[^"]*(")/;
  if (!pattern.test(text)) return false;
  write(path, text.replace(pattern, `$1${version}$2`));
  return true;
}

function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--notes") {
    if (!args[1]) fail("usage: release.mjs --notes <version>");
    const notes = section(read("CHANGELOG.md"), args[1].replace(/^v/, ""));
    if (notes === null) fail(`CHANGELOG.md has no section for ${args[1]}`);
    console.log(notes);
    return;
  }
  const version = args[0]?.replace(/^v/, "");
  if (!version || !semver.test(version)) fail("usage: npm run release -- <major.minor.patch>");
  const tag = `v${version}`;
  if (git("status", "--porcelain")) fail("working tree is not clean");
  if (git("tag", "--list", tag)) fail(`tag ${tag} already exists`);

  let lastTag = "";
  try {
    lastTag = git("describe", "--tags", "--abbrev=0", "--match", "v*");
  } catch {
    // No tag yet: use all history.
  }
  const range = lastTag ? [`${lastTag}..HEAD`] : ["HEAD"];
  const subjects = git("log", "--merges", "--format=%s", ...range)
    .split("\n")
    .map((subject) => subject.replace(/^Merge card:\s*/, "").trim())
    .filter(Boolean);

  const touched = [];
  const bump = (path, changed) => changed && touched.push(path);
  const name = JSON.parse(read("package.json")).name;
  bump("package.json", bumpJson("package.json", version, [(d) => d]));
  if (existsSync(join(root, "package-lock.json"))) {
    bump("package-lock.json", bumpJson("package-lock.json", version, [(d) => d, (d) => d.packages?.[""]]));
  }
  if (existsSync(join(root, "src-tauri/tauri.conf.json"))) {
    bump("src-tauri/tauri.conf.json", bumpJson("src-tauri/tauri.conf.json", version, [(d) => d]));
  }
  if (existsSync(join(root, "src-tauri/Cargo.toml"))) {
    bump("src-tauri/Cargo.toml", bumpToml("src-tauri/Cargo.toml", version));
    const cargoName = /\[package\][^[]*?\nname = "([^"]+)"/.exec(read("src-tauri/Cargo.toml"))?.[1];
    if (cargoName && existsSync(join(root, "src-tauri/Cargo.lock"))) {
      bump("src-tauri/Cargo.lock", bumpToml("src-tauri/Cargo.lock", version, cargoName));
    }
  }

  const date = new Date().toISOString().slice(0, 10);
  const body = subjects.length ? subjects.map((s) => `- ${s}`).join("\n") : "- No merged changes.";
  const entry = `## ${version} - ${date}\n\n${body}\n`;
  let changelog = existsSync(join(root, "CHANGELOG.md")) ? read("CHANGELOG.md") : "# Changelog\n\n## Unreleased\n";
  const unreleased = /^## Unreleased[^\n]*\n*/m.exec(changelog);
  if (unreleased) {
    const at = unreleased.index + unreleased[0].length;
    changelog = `${changelog.slice(0, at).trimEnd()}\n\n${entry}\n${changelog.slice(at).trimStart()}`;
  } else {
    changelog = `${changelog.trimEnd()}\n\n${entry}`;
  }
  write("CHANGELOG.md", `${changelog.trimEnd()}\n`);
  touched.push("CHANGELOG.md");

  git("add", "--", ...touched);
  git("commit", "-m", `Release ${tag}`, "--", ...touched);
  git("tag", "-a", tag, "-m", `${name} ${tag}`);
  console.log(`Created commit and tag ${tag} (${touched.map((p) => relative(".", p)).join(", ")}). Not pushed; run: git push origin HEAD ${tag}`);
}

main();

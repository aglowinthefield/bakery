import assert from "node:assert/strict";
import { test } from "node:test";
import { describeRemote } from "../src/remote-link.js";

test("remote links get short labels and a host", () => {
  assert.deepEqual(describeRemote("https://github.com/owner/repo"), { host: "github", hostname: "github.com", label: "owner/repo" });
  assert.deepEqual(describeRemote("https://www.github.com/owner/repo.git/"), { host: "github", hostname: "github.com", label: "owner/repo" });
  assert.deepEqual(describeRemote("https://gitlab.com/group/sub/repo"), { host: "gitlab", hostname: "gitlab.com", label: "group/sub/repo" });
  assert.deepEqual(describeRemote("https://git.example.com/team/repo"), { host: "other", hostname: "git.example.com", label: "git.example.com/team/repo" });
  assert.deepEqual(describeRemote("https://github.com/"), { host: "github", hostname: "github.com", label: "github.com" });
  assert.equal(describeRemote("not a url").label, "not a url");
});

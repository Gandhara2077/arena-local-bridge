// The path guard is the one seam the whole Local MCP stands on: workspace in,
// everything else out. These tests drive the PURE function only — no
// filesystem, no browser, no network. The `resolve` hook stands in for
// fs.realpathSync so symlink escapes can be expressed without a real tree.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { decidePath } from "../src/path-guard.mjs";

// Platform-neutral fixtures: roots and targets are built with path.resolve so
// the suite behaves identically on Windows and ubuntu CI.
const WS = path.resolve("/home/user/workspace");
const WS_CHILD = path.join(WS, "project", "src", "main.js");
const OUTSIDE = path.resolve("/home/user/other/secret.txt");
const DATA = path.join(WS, ".arena-bridge");
const READ_ONLY = path.resolve("/srv/skills");

const roots = {
  workspaceRoots: [WS],
  readOnlyRoots: [READ_ONLY],
  privateRoots: [DATA],
};

describe("workspace: read, write and exec are allowed", () => {
  test("a file inside the workspace is readable and writable", () => {
    for (const intent of ["read", "write"]) {
      const decision = decidePath({ path: WS_CHILD, intent, ...roots });
      assert.deepEqual(decision, { allowed: true, mode: "read-write" });
    }
  });

  test("exec is allowed inside the workspace (its cwd)", () => {
    const decision = decidePath({ path: path.join(WS, "project"), intent: "exec", ...roots });
    assert.deepEqual(decision, { allowed: true, mode: "read-write" });
  });

  test("the workspace root itself is inside", () => {
    const decision = decidePath({ path: WS, intent: "read", ...roots });
    assert.deepEqual(decision, { allowed: true, mode: "read-write" });
  });
});

describe("outside every root: denied, whatever the intent", () => {
  test("a plain outside path is denied", () => {
    const decision = decidePath({ path: OUTSIDE, intent: "read", ...roots });
    assert.equal(decision.allowed, false);
  });

  test("a sibling whose name merely extends the root's name is NOT inside", () => {
    // /home/user/workspace vs /home/user/workspace2 — a naive prefix check
    // would let this through.
    const sibling = WS + "2";
    const decision = decidePath({ path: sibling, intent: "read", ...roots });
    assert.equal(decision.allowed, false);
  });
});

describe("lexical escapes", () => {
  test("a .. path that climbs out is denied", () => {
    const escape = path.join(WS, "..", "other", "secret.txt");
    const decision = decidePath({ path: escape, intent: "read", ...roots });
    assert.equal(decision.allowed, false);
  });

  test("a .. path that stays inside is fine", () => {
    const stay = path.join(WS, "project", "..", "notes.txt");
    const decision = decidePath({ path: stay, intent: "read", ...roots });
    assert.deepEqual(decision, { allowed: true, mode: "read-write" });
  });
});

describe("symlink escapes (via the injected resolver)", () => {
  test("a link that resolves outside the workspace is denied", () => {
    const link = path.join(WS, "innocent.txt");
    const decision = decidePath(
      { path: link, intent: "read", ...roots },
      { resolve: () => OUTSIDE },
    );
    assert.equal(decision.allowed, false);
  });

  test("a link that resolves inside stays allowed", () => {
    const link = path.join(WS, "alias.js");
    const decision = decidePath(
      { path: link, intent: "read", ...roots },
      { resolve: (p) => (p === path.resolve(link) ? WS_CHILD : p) },
    );
    assert.deepEqual(decision, { allowed: true, mode: "read-write" });
  });

  test("a WRITE target whose PARENT is a symlink pointing outside is denied", () => {
    // The target does not exist yet (so its own realpath throws), and its
    // parent directory is a link out of the workspace. The lexical fallback
    // would wave this through; the nearest-existing-ancestor walk must not.
    const parent = path.join(WS, "link");
    const target = path.join(parent, "new-file.txt");
    const decision = decidePath(
      { path: target, intent: "write", ...roots },
      {
        resolve: (p) => {
          if (p === path.resolve(parent)) return OUTSIDE; // the link is real
          if (p === path.resolve(target)) throw new Error("ENOENT"); // not on disk yet
          return p;
        },
      },
    );
    assert.equal(decision.allowed, false);
  });

  test("a WRITE target under an existing inside directory stays allowed", () => {
    const target = path.join(WS, "project", "new-file.txt");
    const decision = decidePath(
      { path: target, intent: "write", ...roots },
      {
        resolve: (p) => {
          if (p === path.resolve(target)) throw new Error("ENOENT");
          return p;
        },
      },
    );
    assert.deepEqual(decision, { allowed: true, mode: "read-write" });
  });
});

describe("the data directory is denied even inside the workspace", () => {
  test("read inside the private root is denied", () => {
    const decision = decidePath({ path: path.join(DATA, "credentials.json"), intent: "read", ...roots });
    assert.equal(decision.allowed, false);
  });

  test("write inside the private root is denied", () => {
    const decision = decidePath({ path: path.join(DATA, "x.txt"), intent: "write", ...roots });
    assert.equal(decision.allowed, false);
  });

  test("a sibling of the private root is still workspace", () => {
    const decision = decidePath({ path: path.join(WS, ".arena-bridge2", "x.txt"), intent: "read", ...roots });
    assert.deepEqual(decision, { allowed: true, mode: "read-write" });
  });
});

describe("read-only roots: read yes, write and exec no", () => {
  test("read is allowed, flagged read-only", () => {
    const decision = decidePath({ path: path.join(READ_ONLY, "some-skill.md"), intent: "read", ...roots });
    assert.deepEqual(decision, { allowed: true, mode: "read-only" });
  });

  test("write is denied", () => {
    const decision = decidePath({ path: path.join(READ_ONLY, "x.md"), intent: "write", ...roots });
    assert.equal(decision.allowed, false);
  });

  test("exec is denied (a read-only root is not an execution location)", () => {
    const decision = decidePath({ path: READ_ONLY, intent: "exec", ...roots });
    assert.equal(decision.allowed, false);
  });
});

describe("malformed input is denied, never thrown", () => {
  test("relative paths are rejected", () => {
    const decision = decidePath({ path: "project/main.js", intent: "read", ...roots });
    assert.equal(decision.allowed, false);
  });

  test("empty and non-string paths are rejected", () => {
    for (const bad of ["", "   ", null, undefined, 42]) {
      const decision = decidePath({ path: bad, intent: "read", ...roots });
      assert.equal(decision.allowed, false);
    }
  });

  test("an unknown intent is rejected", () => {
    const decision = decidePath({ path: WS_CHILD, intent: "delete", ...roots });
    assert.equal(decision.allowed, false);
  });
});

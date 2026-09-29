// Ticket 13 — Skills read-only roots. The guard side (decidePath's
// readOnlyRoots input) landed with ticket 11; what this ticket adds is the
// EXPLICIT opt-in surface: ARENA_SKILL_ROOTS from the environment and one
// buildRoots() that assembles the roots object every consumer receives.
// The four acceptance items are asserted through buildRoots -> decidePath —
// ticket-11 logic only, no second implementation — with real mkdtemp
// directories and the real filesystem as the resolve hook.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.mjs";
import { decidePath, buildRoots } from "../src/path-guard.mjs";

const resolveReal = (p) => fs.realpathSync.native(p);
const join = (...parts) => path.join(...parts);

describe("ARENA_SKILL_ROOTS parsing", () => {
  test("splits on the platform path delimiter and trims empties", () => {
    // Delimiter-free fixture paths: a Windows drive letter's colon would
    // itself be the delimiter on POSIX and tear the paths apart.
    const first = path.resolve("/skills-a");
    const second = path.resolve("/skills-b");
    const env = { ARENA_SKILL_ROOTS: [first, "", second].join(path.delimiter) };
    const config = loadConfig(env, { requireBridgeKey: false });
    assert.deepEqual(config.skillRoots, [first, second]);
  });

  test("unset means no read-only roots at all", () => {
    const config = loadConfig({}, { requireBridgeKey: false });
    assert.deepEqual(config.skillRoots, []);
  });

  test("a relative entry is rejected at the config gate", () => {
    // decidePath resolves roots against the process cwd; a relative entry
    // would silently grant a directory that depends on where the bridge
    // was started from.
    assert.throws(
      () => loadConfig({ ARENA_SKILL_ROOTS: "skills" }, { requireBridgeKey: false }),
      /ARENA_SKILL_ROOTS entries must be absolute paths: skills/,
    );
  });
});

describe("buildRoots composes the boundary in one place", () => {
  test("workspace stays read-write; skill roots are read-only; dataDir is private", () => {
    const roots = buildRoots({ skillRoots: ["/skills"], dataDir: "/data" }, ["/ws"]);
    assert.deepEqual(roots, {
      workspaceRoots: ["/ws"],
      readOnlyRoots: ["/skills"],
      privateRoots: ["/data"],
    });
  });

  test("no dataDir means no privateRoots; inputs are copied, not aliased", () => {
    const skillRoots = ["/skills"];
    const roots = buildRoots({ skillRoots }, []);
    roots.readOnlyRoots.push("/mutated");
    assert.deepEqual(roots.readOnlyRoots, ["/skills", "/mutated"]);
    assert.deepEqual(skillRoots, ["/skills"]);
    assert.deepEqual(roots.privateRoots, []);
  });

  test("a skill root overlapping the workspace is a configuration error", () => {
    // decidePath checks workspaceRoots before readOnlyRoots, so an overlap
    // would silently make the "read-only" root writable — buildRoots refuses
    // instead, in both directions and at equality.
    for (const [skill, ws] of [
      ["/ws/skills", "/ws"], // skill root inside the workspace
      ["/home", "/home/proj"], // workspace inside the skill root
      ["/same", "/same"], // equality
    ]) {
      assert.throws(
        () => buildRoots({ skillRoots: [skill], dataDir: "" }, [ws]),
        /overlaps workspace/,
        `${skill} vs ${ws}`,
      );
    }
  });

  test("real symlinks are followed: a link into the workspace still overlaps", (t) => {
    // The lexical check would pass these two configurations and decidePath
    // would grant read-write to what was promised read-only, because it
    // judges real paths. Skip where symlinks cannot be created
    // (unprivileged Windows), never pretend it was checked.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "skill-links-"));
    const ws = join(home, "project");
    const linkToWs = join(home, "skills-link");
    const linkToSkill = join(home, "workspace-link");
    const skills = join(home, "skills");
    fs.mkdirSync(ws, { recursive: true });
    fs.mkdirSync(skills, { recursive: true });
    try {
      fs.symlinkSync(ws, linkToWs, "junction");
      fs.symlinkSync(skills, linkToSkill, "junction");
    } catch (error) {
      t.skip(`cannot create symlinks here: ${error.code || error.message}`);
      return;
    }
    const resolveReal = (p) => fs.realpathSync.native(p);

    // Skill root is a link INTO the workspace.
    assert.throws(
      () => buildRoots({ skillRoots: [linkToWs], dataDir: "" }, [ws], { resolve: resolveReal }),
      /overlaps workspace/,
    );
    // Workspace is a link INTO the skill root.
    assert.throws(
      () => buildRoots({ skillRoots: [skills], dataDir: "" }, [linkToSkill], { resolve: resolveReal }),
      /overlaps workspace/,
    );
    // A linked skill root next to the workspace is still fine.
    const roots = buildRoots({ skillRoots: [linkToWs], dataDir: "" }, [skills], { resolve: resolveReal });
    assert.deepEqual(roots.readOnlyRoots, [linkToWs]);
  });
});

describe("the four acceptance items, through buildRoots -> decidePath", () => {
  let home, ws, skills, unlisted, dataDir, roots;
  test("setup: a fake home with a listed skills dir and an unlisted sibling", () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "skill-roots-"));
    ws = join(home, "project");
    skills = join(home, "skills");
    unlisted = join(home, "private-notes");
    dataDir = join(home, "bridge-data");
    for (const dir of [ws, skills, unlisted, dataDir]) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(join(skills, "some-skill.md"), "# a skill\n");
    fs.writeFileSync(join(unlisted, "secret.txt"), "not for the agent\n");
    roots = buildRoots({ skillRoots: [skills], dataDir }, [ws]);
  });

  test("1. a file under the skill root is readable", () => {
    const decision = decidePath({ path: join(skills, "some-skill.md"), intent: "read", ...roots }, { resolve: resolveReal });
    assert.deepEqual(decision, { allowed: true, mode: "read-only" });
  });

  test("2. it is not writable, and not executable either (cwd stays workspace-only)", () => {
    for (const intent of ["write", "exec"]) {
      const decision = decidePath({ path: join(skills, "some-skill.md"), intent, ...roots }, { resolve: resolveReal });
      assert.equal(decision.allowed, false, intent);
      assert.match(decision.reason, /read-only root/);
    }
  });

  test("3. an unlisted directory under the same home is denied outright", () => {
    const decision = decidePath({ path: join(unlisted, "secret.txt"), intent: "read", ...roots }, { resolve: resolveReal });
    assert.equal(decision.allowed, false);
  });

  test("4. the data directory is denied even though the layout gives every reason to allow it", () => {
    // Listed verbatim as a skill root AND sitting inside nothing granted —
    // buildRoots sends it to privateRoots, and decidePath checks those first.
    const covered = buildRoots({ skillRoots: [skills, dataDir], dataDir }, [ws]);
    const decision = decidePath({ path: join(dataDir, "credentials.json"), intent: "read", ...covered }, { resolve: resolveReal });
    assert.equal(decision.allowed, false);
    assert.match(decision.reason, /data directory/);
  });
});

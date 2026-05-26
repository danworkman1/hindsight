import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { spawnSync } from "child_process";

const tmpDir = mkdtempSync(join(tmpdir(), "hindsight-surface-test-"));
process.env.HINDSIGHT_CACHE_PATH = join(tmpDir, "test-cache.json");

const { setCachedReview, markSurfaced, getReviewByCommitSha, getCachedReview } = await import("../lib/cache.js");

after(() => rmSync(tmpDir, { recursive: true, force: true }));

test("new cache entries default to surfaced=false", () => {
  setCachedReview("h1", {
    changed: true,
    summary: "x",
    verdict: "worth_refactoring",
    prose: "p",
    files: [],
    suggestions: [],
    branch: "feat/y",
    commitSha: "sha-1",
  });
  assert.equal(getCachedReview("h1").surfaced, false);
});

test("markSurfaced flips the flag", () => {
  markSurfaced("h1");
  assert.equal(getCachedReview("h1").surfaced, true);
});

test("getReviewByCommitSha finds entry by commit", () => {
  const r = getReviewByCommitSha("sha-1");
  assert.equal(r.verdict, "worth_refactoring");
  assert.equal(r.hash, "h1");
});

test("getReviewByCommitSha returns null for unknown sha", () => {
  assert.equal(getReviewByCommitSha("nope"), null);
});

test("surface.js exits 0 when stop_hook_active is true (recursion guard)", () => {
  const repoRoot = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
  const result = spawnSync("node", ["surface.js"], {
    cwd: repoRoot,
    input: JSON.stringify({ stop_hook_active: true }),
    encoding: "utf-8",
  });
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
});

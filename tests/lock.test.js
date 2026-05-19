import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const tmpHome = mkdtempSync(join(tmpdir(), "hindsight-lock-test-"));
process.env.TMPDIR = tmpHome;
process.env.HINDSIGHT_LOG_PATH = join(tmpHome, "test.log");
process.env.HINDSIGHT_CACHE_PATH = join(tmpHome, "test-cache.json");

const { acquireLock, releaseLock, getLockPath, waitForLockClear } = await import("../lib/lock.js");

beforeEach(() => {
  try { rmSync(getLockPath(), { force: true }); } catch {}
});

test("acquireLock writes a lock file and returns true", () => {
  assert.equal(acquireLock(), true);
  assert.ok(existsSync(getLockPath()));
});

test("acquireLock returns false when fresh lock exists", () => {
  acquireLock();
  assert.equal(acquireLock(), false);
});

test("acquireLock reclaims a stale lock (>5min old) and returns true", () => {
  const stale = String(Date.now() - 6 * 60 * 1000);
  writeFileSync(getLockPath(), stale, "utf-8");
  assert.equal(acquireLock(), true);
});

test("releaseLock removes the lock file", () => {
  acquireLock();
  releaseLock();
  assert.equal(existsSync(getLockPath()), false);
});

test("releaseLock is a no-op when file is gone", () => {
  releaseLock();
  releaseLock();
});

test("waitForLockClear resolves true immediately when no lock exists", async () => {
  const start = Date.now();
  const r = await waitForLockClear(1000, 50);
  assert.equal(r, true);
  assert.ok(Date.now() - start < 50);
});

test("waitForLockClear resolves true when lock is released during wait", async () => {
  acquireLock();
  setTimeout(() => releaseLock(), 120);
  const start = Date.now();
  const r = await waitForLockClear(2000, 50);
  assert.equal(r, true);
  assert.ok(Date.now() - start >= 100);
});

test("waitForLockClear resolves false when timeout exceeded", async () => {
  acquireLock();
  const r = await waitForLockClear(150, 50);
  assert.equal(r, false);
  releaseLock();
});

test("waitForLockClear treats a stale lock as cleared", async () => {
  const stale = String(Date.now() - 6 * 60 * 1000);
  writeFileSync(getLockPath(), stale, "utf-8");
  const r = await waitForLockClear(2000, 50);
  assert.equal(r, true);
});

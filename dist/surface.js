#!/usr/bin/env node

// surface.js
import { execSync as execSync2 } from "child_process";
import { readFileSync as readFileSync3 } from "fs";

// lib/cache.js
import { writeFileSync, readFileSync, existsSync, statSync, mkdirSync } from "fs";
import { dirname } from "path";

// lib/paths.js
import { execSync } from "child_process";
import { join } from "path";
function gitRepoRoot() {
  try {
    return execSync("git rev-parse --show-toplevel", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"]
    }).trim();
  } catch {
    return process.cwd();
  }
}
function getProjectRoot() {
  return process.env.HINDSIGHT_PROJECT_ROOT ?? gitRepoRoot();
}
function getLogPath() {
  return process.env.HINDSIGHT_LOG_PATH ?? join(getProjectRoot(), "hindsight-agent-reviews.log");
}
function getCachePath() {
  return process.env.HINDSIGHT_CACHE_PATH ?? join(getProjectRoot(), "hindsight-agent-review-cache.json");
}

// lib/cache.js
var CACHE_VERSION = 3;
var SIZE_THRESHOLD_BYTES = 5 * 1024 * 1024;
var EVICT_KEEP_COUNT = 1e3;
function loadCache() {
  if (!existsSync(getCachePath())) {
    return { version: CACHE_VERSION, entries: {}, branchIndex: {} };
  }
  try {
    const raw = readFileSync(getCachePath(), "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed.version !== CACHE_VERSION) {
      return { version: CACHE_VERSION, entries: {}, branchIndex: {} };
    }
    if (!parsed.branchIndex) parsed.branchIndex = {};
    return parsed;
  } catch {
    return { version: CACHE_VERSION, entries: {}, branchIndex: {} };
  }
}
function saveCache(cache) {
  const cachePath = getCachePath();
  const dir = dirname(cachePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  let currentSize = 0;
  if (existsSync(cachePath)) {
    try {
      currentSize = statSync(cachePath).size;
    } catch {
      currentSize = 0;
    }
  }
  if (currentSize > SIZE_THRESHOLD_BYTES) {
    cache.entries = evictOldest(cache.entries, EVICT_KEEP_COUNT);
    cache.branchIndex = reconcileBranchIndex(cache.branchIndex, cache.entries);
  }
  writeFileSync(cachePath, JSON.stringify(cache, null, 2), "utf-8");
}
function evictOldest(entries, keepCount) {
  const sorted = Object.entries(entries).sort(
    ([, a], [, b]) => new Date(b.reviewedAt) - new Date(a.reviewedAt)
  );
  const kept = sorted.slice(0, keepCount);
  return Object.fromEntries(kept);
}
function reconcileBranchIndex(branchIndex, entries) {
  const result = {};
  for (const [branch, hashes] of Object.entries(branchIndex)) {
    const live = hashes.filter((h) => entries[h] !== void 0);
    if (live.length > 0) result[branch] = live;
  }
  return result;
}
function markSurfaced(hash) {
  if (!hash) return;
  const cache = loadCache();
  if (cache.entries[hash]) {
    cache.entries[hash].surfaced = true;
    saveCache(cache);
  }
}
function getReviewByCommitSha(sha) {
  if (!sha) return null;
  const cache = loadCache();
  for (const [hash, entry] of Object.entries(cache.entries)) {
    if (entry.commitSha === sha) return { hash, ...entry };
  }
  return null;
}

// lib/lock.js
import { existsSync as existsSync3, readFileSync as readFileSync2, writeFileSync as writeFileSync2, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join as join2 } from "path";
import { createHash } from "crypto";

// lib/logger.js
import { appendFileSync, mkdirSync as mkdirSync2, existsSync as existsSync2 } from "fs";
import { dirname as dirname2, basename } from "path";
var DIVIDER = "\u2500".repeat(48);
function projectTag() {
  return basename(process.cwd()) || "unknown";
}
function ensureLogDir() {
  const dir = dirname2(getLogPath());
  if (!existsSync2(dir)) mkdirSync2(dir, { recursive: true });
}
function logSkip(kind, note) {
  ensureLogDir();
  const ts = (/* @__PURE__ */ new Date()).toISOString();
  const line = `[${ts}] [${projectTag()}] [${kind}] ${note}
`;
  appendFileSync(getLogPath(), line);
}

// lib/lock.js
var STALE_AFTER_MS = 5 * 60 * 1e3;
function getLockPath() {
  const repoKey = createHash("sha256").update(process.cwd()).digest("hex").slice(0, 16);
  return join2(tmpdir(), `hindsight-${repoKey}.lock`);
}
async function waitForLockClear(timeoutMs = 2e4, pollMs = 200) {
  const path = getLockPath();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!existsSync3(path)) return true;
    try {
      const age = Date.now() - parseInt(readFileSync2(path, "utf-8") || "0", 10);
      if (age >= STALE_AFTER_MS) return true;
    } catch {
      return true;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return false;
}

// surface.js
function readHookInput() {
  if (process.stdin.isTTY) return {};
  try {
    const raw = readFileSync3(0, "utf-8");
    if (!raw.trim()) return {};
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
function getHeadSha() {
  try {
    return execSync2("git rev-parse HEAD", { encoding: "utf-8" }).trim();
  } catch {
    return "";
  }
}
async function main() {
  const hookInput = readHookInput();
  if (hookInput.stop_hook_active) process.exit(0);
  const sha = getHeadSha();
  if (!sha) process.exit(0);
  await waitForLockClear();
  const review = getReviewByCommitSha(sha);
  if (!review) process.exit(0);
  if (review.verdict !== "worth_refactoring") process.exit(0);
  if (review.surfaced) process.exit(0);
  markSurfaced(review.hash);
  const suggestionLines = (review.suggestions || []).map((s) => `  - ${s.file}${s.lines ? `:${s.lines}` : ""} \u2014 ${s.issue} (fix: ${s.fix})`).join("\n");
  const message = `Hindsight flagged a potential refactor on the latest commit (${sha.slice(0, 7)}):

${review.prose}

` + (suggestionLines ? `Suggestions:
${suggestionLines}

` : "") + `Reply with: \`show\` to see the proposed diff, \`apply\` to implement it, or describe what you'd like to do instead.`;
  process.stderr.write(message + "\n");
  process.exit(2);
}
main().catch((err) => {
  logSkip("surface-error", err.message);
  process.exit(0);
});

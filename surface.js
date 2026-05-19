#!/usr/bin/env node
// surface.js
// Stop-hook entry point. Surfaces an unread `worth_refactoring` review
// for the current HEAD back to Claude Code via exit 2 + stderr.

import { execSync } from "child_process";
import { readFileSync } from "fs";
import { getReviewByCommitSha, markSurfaced } from "./lib/cache.js";
import { waitForLockClear } from "./lib/lock.js";
import { logSkip } from "./lib/logger.js";

function readHookInput() {
  if (process.stdin.isTTY) return {};
  try {
    const raw = readFileSync(0, "utf-8");
    if (!raw.trim()) return {};
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function getHeadSha() {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf-8" }).trim();
  } catch {
    return "";
  }
}

async function main() {
  // Recursion guard: Claude Code re-fires Stop hooks in response to its own
  // reply to a prior Stop hook. Bail when re-entered.
  const hookInput = readHookInput();
  if (hookInput.stop_hook_active) process.exit(0);

  const sha = getHeadSha();
  if (!sha) process.exit(0);

  // The PostToolUse review hook runs async, so the cache entry for the
  // latest commit may not be written yet when this Stop hook fires. Wait
  // for any in-flight review to finish before reading the cache.
  await waitForLockClear();

  const review = getReviewByCommitSha(sha);
  if (!review) process.exit(0);
  if (review.verdict !== "worth_refactoring") process.exit(0);
  if (review.surfaced) process.exit(0);

  markSurfaced(review.hash);

  const suggestionLines = (review.suggestions || [])
    .map((s) => `  - ${s.file}${s.lines ? `:${s.lines}` : ""} — ${s.issue} (fix: ${s.fix})`)
    .join("\n");

  const message =
    `Hindsight flagged a potential refactor on the latest commit (${sha.slice(0, 7)}):\n\n` +
    `${review.prose}\n\n` +
    (suggestionLines ? `Suggestions:\n${suggestionLines}\n\n` : "") +
    `Reply with: \`show\` to see the proposed diff, \`apply\` to implement it, ` +
    `or describe what you'd like to do instead.`;

  process.stderr.write(message + "\n");
  process.exit(2);
}

main().catch((err) => {
  logSkip("surface-error", err.message);
  process.exit(0);
});

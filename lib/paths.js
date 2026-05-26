// lib/paths.js
// Resolves where hindsight-reviews.log and hindsight-review-cache.json live.
// They live at the git repo root so `tail -f hindsight-reviews.log` works from the
// user's project, and the cache survives `npm install` (which would wipe
// node_modules/hindsight/).

import { execSync } from "child_process";
import { join } from "path";

function gitRepoRoot() {
  try {
    return execSync("git rev-parse --show-toplevel", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return process.cwd();
  }
}

export function getProjectRoot() {
  return process.env.HINDSIGHT_PROJECT_ROOT ?? gitRepoRoot();
}

export function getLogPath() {
  return process.env.HINDSIGHT_LOG_PATH ?? join(getProjectRoot(), "hindsight-reviews.log");
}

export function getCachePath() {
  return process.env.HINDSIGHT_CACHE_PATH ?? join(getProjectRoot(), "hindsight-review-cache.json");
}

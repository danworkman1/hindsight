// lib/cache.js
// Caches review verdicts keyed by a hash of the working-tree state.
// Strategy: grow unbounded under normal use; soft cap at 5MB triggers
// eviction down to the 1000 most recent entries. Eviction only runs on writes.

import { createHash } from "crypto";
import { execSync, execFileSync } from "child_process";
import { writeFileSync, readFileSync, existsSync, statSync, mkdirSync } from "fs";
import { dirname } from "path";
import { getCachePath } from "./paths.js";

const CACHE_VERSION = 3;
const SIZE_THRESHOLD_BYTES = 5 * 1024 * 1024; // 5MB
const EVICT_KEEP_COUNT = 1000;

// Doc/text files excluded from the hash so writing a plan.md after a review
// doesn't bust the cache when the underlying code is unchanged.
// Passed to git as exclude pathspecs — git filters in one pass.
const DOC_EXCLUDE_PATHSPECS = [
  ":(exclude,glob)**/*.md",
  ":(exclude,glob)**/*.mdx",
  ":(exclude,glob)**/*.markdown",
  ":(exclude,glob)**/*.txt",
  ":(exclude,glob)**/*.rst",
];

/**
 * Hash a commit range diff (base..HEAD), excluding doc files.
 *
 * @param {string} [base="HEAD~1"] - The base ref to diff against. Pass a branch
 *   name (e.g. "main") to review everything on the current branch at once.
 *
 * Returns:
 *   - { status: "ok", hash, commitSha } when there are non-doc changes
 *   - { status: "no_parent" } for initial commits (no HEAD~1) when using default base
 *   - { status: "no_changes" } when the diff is empty after doc-file exclusion
 *   - { status: "not_a_repo" } when not in a git repo
 */
export function computeCommitRangeHash(base = "HEAD~1") {
  try {
    execSync("git rev-parse --is-inside-work-tree", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    return { status: "not_a_repo" };
  }

  let commitSha = "";
  try {
    commitSha = execSync("git rev-parse HEAD", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return { status: "no_parent" };
  }

  if (base === "HEAD~1") {
    try {
      execSync("git rev-parse HEAD~1", { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    } catch {
      return { status: "no_parent" };
    }
  }

  const range = `${base}..HEAD`;
  let diff = "";
  try {
    diff = execFileSync("git", ["diff", range, "--", ".", ...DOC_EXCLUDE_PATHSPECS], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      // Default 1 MiB maxBuffer makes large branch diffs throw ENOBUFS,
      // which the catch below would misreport as "no changes".
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    diff = "";
  }

  if (diff.trim() === "") {
    return { status: "no_changes" };
  }

  return {
    status: "ok",
    hash: createHash("sha256").update(diff).digest("hex"),
    commitSha,
  };
}

/**
 * Load the cache from disk. Returns a fresh empty cache if missing,
 * malformed, or on a different version.
 */
function loadCache() {
  if (!existsSync(getCachePath())) {
    return { version: CACHE_VERSION, entries: {}, branchIndex: {} };
  }

  try {
    const raw = readFileSync(getCachePath(), "utf-8");
    const parsed = JSON.parse(raw);

    if (parsed.version !== CACHE_VERSION) {
      // Version mismatch — treat as empty, will be overwritten on next save
      return { version: CACHE_VERSION, entries: {}, branchIndex: {} };
    }

    if (!parsed.branchIndex) parsed.branchIndex = {};
    return parsed;
  } catch {
    // Corrupted file — start fresh rather than crashing
    return { version: CACHE_VERSION, entries: {}, branchIndex: {} };
  }
}

/**
 * Save the cache, evicting if file size has grown past the threshold.
 */
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

/**
 * Keep only the N most-recently-reviewed entries.
 */
function evictOldest(entries, keepCount) {
  const sorted = Object.entries(entries).sort(
    ([, a], [, b]) => new Date(b.reviewedAt) - new Date(a.reviewedAt)
  );

  const kept = sorted.slice(0, keepCount);
  return Object.fromEntries(kept);
}

/**
 * Remove hashes from branchIndex that no longer exist in entries.
 * Branches with no remaining live hashes are dropped entirely.
 */
function reconcileBranchIndex(branchIndex, entries) {
  const result = {};
  for (const [branch, hashes] of Object.entries(branchIndex)) {
    const live = hashes.filter((h) => entries[h] !== undefined);
    if (live.length > 0) result[branch] = live;
  }
  return result;
}

/**
 * Look up a previously-cached review for this diff hash.
 * Returns the cached entry or null.
 */
export function getCachedReview(hash) {
  if (!hash) return null;
  const cache = loadCache();
  return cache.entries[hash] || null;
}

/**
 * Store a review result keyed by diff hash.
 */
export function setCachedReview(hash, { changed, summary, verdict, prose, files, suggestions, branch, commitSha }) {
  if (!hash) return;

  const cache = loadCache();
  cache.entries[hash] = {
    changed,
    summary,
    verdict,
    prose,
    files,
    suggestions,
    branch: branch ?? null,
    commitSha: commitSha ?? null,
    surfaced: false,
    reviewedAt: new Date().toISOString(),
    cwd: process.cwd(),
  };
  if (branch) {
    if (!cache.branchIndex[branch]) cache.branchIndex[branch] = [];
    if (!cache.branchIndex[branch].includes(hash)) {
      cache.branchIndex[branch].push(hash);
    }
  }
  saveCache(cache);
}

/**
 * Return the number of cached reviews for a given branch.
 */
export function getBranchReviewCount(branch) {
  if (!branch) return 0;
  const cache = loadCache();
  return (cache.branchIndex[branch] || []).length;
}

/**
 * Return the most-recently cached review entry for a given branch, or null.
 */
export function getLastBranchReview(branch) {
  if (!branch) return null;
  const cache = loadCache();
  const hashes = cache.branchIndex[branch] || [];
  if (hashes.length === 0) return null;
  const hash = hashes[hashes.length - 1];
  const entry = cache.entries[hash];
  if (!entry) return null;
  return { hash, ...entry };
}

export function markSurfaced(hash) {
  if (!hash) return;
  const cache = loadCache();
  if (cache.entries[hash]) {
    cache.entries[hash].surfaced = true;
    saveCache(cache);
  }
}

export function getReviewByCommitSha(sha) {
  if (!sha) return null;
  const cache = loadCache();
  for (const [hash, entry] of Object.entries(cache.entries)) {
    if (entry.commitSha === sha) return { hash, ...entry };
  }
  return null;
}

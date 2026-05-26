#!/usr/bin/env node
// hindsight — post-implementation code review engine.
//
// Two modes:
//   cli  — invoked directly by a human; prints verdict to stdout, no log/cache/skip/cap.
//   auto — invoked by the plugin hook; logs, caches, applies skip rules and branch cap.

import { execSync } from "child_process";
import { runAgent, MODELS } from "./lib/agent-loop.js";
import { tools, createToolHandlers } from "./lib/tools.js";
import { computeCommitRangeHash, getCachedReview, setCachedReview, getBranchReviewCount, getLastBranchReview } from "./lib/cache.js";
import { shouldSkip, REVIEW_CAP } from "./lib/skip-rules.js";
import { formatPriorReviewForPrompt } from "./lib/prior-review.js";
import { logReview, logSkip, logError, logCapHit } from "./lib/logger.js";
import { extractJsonObject } from "./lib/parse.js";
import { acquireLock, releaseLock } from "./lib/lock.js";

// ---------------------------------------------------------------------------
// Commit metadata — branch, message, and SHA of the latest commit.
// ---------------------------------------------------------------------------
function readCommitMetadata(sha) {
  try {
    const branch = execSync("git rev-parse --abbrev-ref HEAD", { encoding: "utf-8" }).trim();
    const message = execSync("git log -1 --pretty=%B", { encoding: "utf-8" }).trim();
    return { branch, message, sha };
  } catch {
    return { branch: "", message: "", sha: "" };
  }
}

// ---------------------------------------------------------------------------
// Phase 1: Triage. Cheap call. Was code added or refactored?
// Returns { changed: boolean, summary: string }
// ---------------------------------------------------------------------------
async function triage(toolHandlers, model = MODELS.HAIKU) {
  const system = `You are a code change detector. Use the available tools to inspect the working tree and determine whether source code was added or refactored.

Your ENTIRE response must be a single JSON object and nothing else. No prose before, no prose after, no markdown fences.

Schema:
{"changed": boolean, "summary": "one-line description"}

Examples of valid responses:
{"changed": true, "summary": "Added new auth middleware in src/auth.ts"}
{"changed": false, "summary": "Only README.md was modified"}

Rules:
- "changed" is true ONLY if source code (functions, components, logic) was added or modified
- Pure documentation, comments, config tweaks, or formatting-only changes are NOT a "change" for our purposes
- If unsure, lean toward false — Phase 2 is expensive`;

  const result = await runAgent({
    system,
    userPrompt:
      "Inspect the working tree. Was source code added or refactored in this session?",
    tools,
    toolHandlers,
    maxIterations: 5,
    model,
  });

  const parsed = extractJsonObject(result);

  if (!parsed) {
    logError("triage", "Could not parse JSON from model response", result);
    return { changed: false, summary: "Could not parse triage output" };
  }

  return {
    changed: Boolean(parsed.changed),
    summary: String(parsed.summary || ""),
  };
}

// ---------------------------------------------------------------------------
// Phase 2: Deep review. Only runs when triage says code changed.
// Returns a structured object { verdict, prose, files, suggestions }
// ---------------------------------------------------------------------------
async function deepReview(triageSummary, priorReview, toolHandlers, model = MODELS.OPUS) {
  const priorContext = formatPriorReviewForPrompt(priorReview);

  const system = `You are a senior engineer doing a post-implementation review. The code WORKS — your job is not to find bugs, but to ask: now that we have a working solution and the full picture, is there a cleaner approach?

Look for:
- Abstractions that became unnecessary once the solution crystallised
- Code that could be simpler, shorter, or more idiomatic
- Patterns that were appropriate mid-flight but redundant in hindsight
- Opportunities to delete code

Be concrete. Reference files and lines. If the solution is already clean, say so plainly — do not invent improvements.

Your ENTIRE response must be a single JSON object and nothing else. No prose before, no prose after, no markdown fences.

Schema:
{
  "verdict": "clean" | "minor" | "worth_refactoring",
  "prose": "string — omit or use empty string for clean verdict",
  "files": ["array of affected file paths — empty for clean"],
  "suggestions": [
    {
      "file": "path/to/file.ts",
      "lines": "45-67",
      "issue": "what the problem is",
      "fix": "what to do instead"
    }
  ]
}

Rules:
- verdict "clean": solution is good. prose = "". files = []. suggestions = [].
- verdict "minor": small notes not worth acting on. prose = full explanation. files = affected files. suggestions = [].
- verdict "worth_refactoring": meaningful improvement available. prose = full explanation. files = affected files. suggestions = one entry per distinct change.
- Line numbers in suggestions are best-effort — prose is authoritative if they conflict.${priorContext}`;

  const raw = await runAgent({
    system,
    userPrompt: `A coding session just completed. Triage summary: ${triageSummary}\n\nReview the changes and assess whether there is a cleaner solution now.`,
    tools,
    toolHandlers,
    maxIterations: 15,
    model,
  });

  const parsed = extractJsonObject(raw);

  if (!parsed || !parsed.verdict) {
    logError("deepReview", "Could not parse JSON from model response", raw);
    // Safe fallback — treat as clean so we don't block or crash
    return { verdict: "clean", prose: "", files: [], suggestions: [] };
  }

  return {
    verdict: parsed.verdict,
    prose: parsed.prose ?? "",
    files: Array.isArray(parsed.files) ? parsed.files : [],
    suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : [],
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function parseModel(name) {
  if (!name) return null;
  const key = name.toLowerCase();
  if (key === "haiku") return MODELS.HAIKU;
  if (key === "sonnet") return MODELS.SONNET;
  if (key === "opus") return MODELS.OPUS;
  // Accept raw model IDs too
  return name;
}

function parseReviewCap(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return null;
  return n;
}

function getArg(argv, flag) {
  const idx = argv.indexOf(flag);
  return idx !== -1 ? argv[idx + 1] : null;
}

function formatVerdictForStdout({ summary, verdict, prose, suggestions }) {
  const lines = [];
  if (verdict === "clean") {
    lines.push(`Verdict: clean`);
    if (summary) lines.push(`\n${summary}`);
  } else {
    lines.push(`Verdict: ${verdict === "worth_refactoring" ? "worth refactoring" : "minor suggestions"}`);
    if (suggestions && suggestions.length > 0) {
      lines.push("");
      for (const s of suggestions) {
        lines.push(`${s.file}${s.lines ? ` (lines ${s.lines})` : ""}`);
        lines.push(`  Issue: ${s.issue}`);
        lines.push(`  Fix:   ${s.fix}`);
        lines.push("");
      }
    }
    if (prose) {
      lines.push(prose);
    }
  }
  return lines.join("\n") + "\n";
}

async function main({ mode, force, base, triageModel, reviewModel, reviewCap }) {
  const isCli = mode === "cli";

  if (!process.env.ANTHROPIC_API_KEY) {
    const msg = "ANTHROPIC_API_KEY not set — set it in your shell environment to enable reviews";
    if (!isCli) logSkip("skip", msg);
    process.stderr.write(`hindsight: ${msg}\n`);
    if (isCli) process.exit(1);
    return;
  }

  const toolHandlers = createToolHandlers(base);

  const diffResult = computeCommitRangeHash(base ?? undefined);
  if (diffResult.status === "not_a_repo") {
    if (!isCli) logSkip("skip", "not a git repo");
    if (isCli) {
      process.stderr.write("hindsight: not a git repository\n");
      process.exit(1);
    }
    return;
  }
  if (diffResult.status === "no_parent") {
    if (!isCli) logSkip("skip", "initial commit has no parent to diff against");
    if (isCli) {
      process.stderr.write("hindsight: initial commit has no parent to diff against\n");
      process.exit(1);
    }
    return;
  }
  if (diffResult.status === "no_changes") {
    if (isCli) {
      process.stderr.write(
        `hindsight: no changes in ${base ?? "main"}..HEAD — ` +
        `if you're on the base branch, pass --base <ref> to specify a different comparison target\n`
      );
      process.exit(1);
    }
    if (!force) {
      logSkip("skip", "commit had no non-doc changes");
      return;
    }
  }

  const meta = readCommitMetadata(diffResult.commitSha);
  if (!meta.branch) {
    if (!isCli) logSkip("skip", "could not read branch");
    if (isCli) {
      process.stderr.write("hindsight: could not determine current branch\n");
      process.exit(1);
    }
    return;
  }

  // Auto-path only: skip rules, cache, branch cap
  if (!isCli) {
    const reviewCount = getBranchReviewCount(meta.branch);

    if (!force) {
      const skipDecision = shouldSkip({
        branch: meta.branch,
        commitMessage: meta.message,
        reviewCount,
        reviewCap,
      });
      if (skipDecision.skip) {
        if (skipDecision.reason.startsWith("branch review cap")) {
          logCapHit(meta.branch, reviewCount, reviewCap);
        } else {
          logSkip("skip", skipDecision.reason);
        }
        return;
      }
    }

    const hash = diffResult.hash;
    const cached = !force ? getCachedReview(hash) : null;
    if (cached) {
      if (cached.changed) {
        logReview({
          summary: cached.summary,
          verdict: cached.verdict,
          prose: cached.prose ?? "",
          files: cached.files ?? [],
          suggestions: cached.suggestions ?? [],
          fromCache: true,
        });
      } else {
        logSkip("cached", `no substantive changes — ${cached.summary}`);
      }
      return;
    }
  }

  let summary;
  if (force) {
    summary = meta.message.split("\n")[0] || `force review of ${base ?? "HEAD"}..HEAD on ${meta.branch}`;
    process.stderr.write(`hindsight: force mode — skipping triage, running deep review on ${meta.branch}\n`);
    if (!isCli) logSkip("force", `bypassing triage and cache — ${summary}`);
  } else {
    process.stderr.write(`hindsight: triaging ${meta.branch}...\n`);
    const triageResult = await triage(toolHandlers, triageModel);
    const triageFailed = triageResult.summary === "Could not parse triage output";

    if (!triageResult.changed) {
      if (!isCli && !triageFailed) {
        setCachedReview(diffResult.hash, {
          changed: false,
          summary: triageResult.summary,
          verdict: "clean",
          prose: "",
          files: [],
          suggestions: [],
          branch: meta.branch,
          commitSha: meta.sha,
        });
      }
      if (!isCli) logSkip("skip", `triage said no — ${triageResult.summary}`);
      if (isCli) {
        process.stdout.write(`Verdict: clean\n\n${triageResult.summary}\n`);
      } else {
        process.stderr.write(`hindsight: skipped — ${triageResult.summary}\n`);
      }
      return;
    }
    summary = triageResult.summary;
  }

  process.stderr.write(`hindsight: running deep review (${reviewModel})...\n`);
  const priorReview = getLastBranchReview(meta.branch);
  const result = await deepReview(summary, priorReview, toolHandlers, reviewModel);

  if (isCli) {
    process.stdout.write(formatVerdictForStdout({ summary, ...result }));
  } else {
    setCachedReview(diffResult.hash, {
      changed: true,
      summary,
      ...result,
      branch: meta.branch,
      commitSha: meta.sha,
    });
    logReview({ summary, ...result });
  }
  process.stderr.write(`hindsight: review complete — verdict: ${result.verdict}\n`);
}

(async () => {
  const argv = process.argv;
  const sub = argv[2];

  if (sub === "--help" || sub === "-h" || sub === "help") {
    process.stdout.write(
      `hindsight — post-implementation code review for Claude Code\n\n` +
        `Usage:\n` +
        `  hindsight                   Review main..HEAD (whole branch) to stdout\n` +
        `  hindsight --base <ref>      Review <ref>..HEAD to stdout\n\n` +
        `Flags:\n` +
        `  --force                     Bypass triage\n` +
        `  --base <ref>                Diff against <ref>..HEAD (default main)\n` +
        `  --path <dir>                Run as if launched in <dir>\n` +
        `  --triage-model <name>       haiku|sonnet|opus or raw model id\n` +
        `  --review-model <name>       haiku|sonnet|opus or raw model id (default opus)\n\n` +
        `Auto-review plugin flags (used only by the plugin hook):\n` +
        `  --auto                      Enable auto-review mode (log, cache, skip rules, branch cap)\n` +
        `  --review-cap <n>            Max auto-reviews per branch before skipping (default 3)\n\n` +
        `Environment variables (used when flags are not set):\n` +
        `  HINDSIGHT_TRIAGE_MODEL      Same values as --triage-model\n` +
        `  HINDSIGHT_REVIEW_MODEL      Same values as --review-model\n` +
        `  HINDSIGHT_REVIEW_CAP        Same values as --review-cap\n\n` +
        `Auto-trigger lives in the Claude Code plugin:\n` +
        `  /plugin marketplace add danworkman1/hindsight\n` +
        `  /plugin install hindsight@danworkman1\n`
    );
    process.exit(0);
  }

  const isAutoMode = argv.includes("--auto");
  const mode = isAutoMode ? "auto" : "cli";
  const force = argv.includes("--force");
  const base = getArg(argv, "--base") ?? (isAutoMode ? null : "main");
  const pathArg = getArg(argv, "--path");
  const triageModel =
    parseModel(getArg(argv, "--triage-model")) ??
    parseModel(process.env.HINDSIGHT_TRIAGE_MODEL) ??
    MODELS.HAIKU;
  const reviewModel =
    parseModel(getArg(argv, "--review-model")) ??
    parseModel(process.env.HINDSIGHT_REVIEW_MODEL) ??
    MODELS.OPUS;
  const reviewCap =
    parseReviewCap(getArg(argv, "--review-cap")) ??
    parseReviewCap(process.env.HINDSIGHT_REVIEW_CAP) ??
    REVIEW_CAP;

  if (pathArg) {
    try {
      process.chdir(pathArg);
    } catch (err) {
      console.error(`hindsight: cannot chdir to ${pathArg}: ${err.message}`);
      process.exit(1);
    }
  }

  if (isAutoMode && !acquireLock()) {
    logSkip("skip", "another hindsight run is in progress");
    process.stderr.write("hindsight: another run is in progress, exiting\n");
    process.exit(0);
  }
  const holdingLock = isAutoMode || acquireLock();
  try {
    await main({ mode, force, base, triageModel, reviewModel, reviewCap });
  } catch (err) {
    if (isAutoMode) logError("fatal", `Reviewer agent failed: ${err.message}`, err.stack);
    process.stderr.write(`hindsight: failed — ${err.message}\n`);
    if (mode === "cli") process.exit(1);
  } finally {
    if (holdingLock) releaseLock();
  }
  process.exit(0);
})();

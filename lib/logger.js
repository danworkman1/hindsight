// lib/logger.js
// Append-only log of every agent run. Each entry is tagged with a project
// name (basename of cwd) so you can grep by project later.

import { appendFileSync, mkdirSync, existsSync } from "fs";
import { dirname, basename } from "path";
import { getLogPath } from "./paths.js";

const DIVIDER = "─".repeat(48);

function projectTag() {
  return basename(process.cwd()) || "unknown";
}

function ensureLogDir() {
  const dir = dirname(getLogPath());
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/**
 * Pure rendering function — exported for testing.
 * Takes all data explicitly so tests can pass controlled values.
 */
export function renderReview({ ts, project, tag, summary, verdict, prose, files, suggestions }) {
  if (verdict === "clean") {
    return `\n[${ts}] [${project}] [${tag}] ${summary} — clean\n`;
  }

  const lines = [
    "",
    `[${ts}] [${project}] [${tag}] ${summary}`,
    "",
    `Verdict: ${verdict === "worth_refactoring" ? "worth refactoring" : "minor suggestions"}`,
  ];

  if (verdict === "worth_refactoring" && suggestions.length > 0) {
    lines.push("");
    for (const s of suggestions) {
      lines.push(`${s.file}${s.lines ? ` (lines ${s.lines})` : ""}`);
      lines.push(`  Issue: ${s.issue}`);
      lines.push(`  Fix:   ${s.fix}`);
      lines.push("");
    }
  }

  if (prose) {
    lines.push(DIVIDER);
    lines.push(prose);
    lines.push(DIVIDER);
  }

  lines.push("");
  return lines.join("\n");
}

/**
 * Log a one-line entry for skip events.
 */
export function logSkip(kind, note) {
  ensureLogDir();
  const ts = new Date().toISOString();
  const line = `[${ts}] [${projectTag()}] [${kind}] ${note}\n`;
  appendFileSync(getLogPath(), line);
}

/**
 * Log an error entry. `detail` is optional raw context (e.g. unparseable
 * model output) that gets fenced in the log for later inspection.
 */
export function logError(kind, message, detail) {
  ensureLogDir();
  const ts = new Date().toISOString();
  const lines = [`[${ts}] [${projectTag()}] [error:${kind}] ${message}`];
  if (detail) {
    lines.push(DIVIDER, String(detail), DIVIDER);
  }
  lines.push("");
  appendFileSync(getLogPath(), lines.join("\n"));
}

/**
 * Log a full review entry.
 *
 * @param {object} opts
 * @param {string} opts.summary
 * @param {string} opts.verdict - "clean" | "minor" | "worth_refactoring"
 * @param {string} opts.prose
 * @param {string[]} opts.files
 * @param {Array} opts.suggestions
 * @param {boolean} [opts.fromCache]
 */
export function logReview({ summary, verdict, prose, files, suggestions, fromCache = false }) {
  ensureLogDir();
  const entry = renderReview({
    ts: new Date().toISOString(),
    project: projectTag(),
    tag: fromCache ? "REVIEW cached" : "REVIEW",
    summary,
    verdict,
    prose,
    files,
    suggestions,
  });
  appendFileSync(getLogPath(), entry);
}

export function logCapHit(branch, count, cap) {
  const msg =
    `branch "${branch}" has hit the review cap (${count}/${cap}). ` +
    `Run \`hindsight --force\` to override, or merge the branch to reset.`;
  logSkip("CAP", msg);
}

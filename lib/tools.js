// lib/tools.js
// Tools the reviewer agent can call to inspect the codebase.

import { readFileSync } from "fs";
import { execSync } from "child_process";

const MAX_DIFF_BYTES = 20000; // cap to keep token usage sane

export const tools = [
  {
    name: "git_diff",
    description:
      "Get the git diff of recent changes in the working tree. Use this to see what code was added or modified in the current session.",
    input_schema: {
      type: "object",
      properties: {
        staged: {
          type: "boolean",
          description:
            "If true, show staged changes only. If false (default), show all working-tree changes vs HEAD.",
        },
      },
    },
  },
  {
    name: "read_file",
    description:
      "Read the full contents of a file. Use this when the diff doesn't give you enough surrounding context to judge a change.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file, relative to cwd" },
      },
      required: ["path"],
    },
  },
  {
    name: "list_changed_files",
    description:
      "List files that have been modified, added, or deleted in the working tree. Useful as a first step to see the scope of changes.",
    input_schema: { type: "object", properties: {} },
  },
];

/**
 * Create tool handlers for the agent loop.
 *
 * @param {string|null} base - When provided (e.g. "main"), diffs against
 *   `${base}..HEAD` so the whole branch is reviewed rather than just HEAD.
 */
export function createToolHandlers(base = null) {
  const range = base ? `${base}..HEAD` : null;

  return {
    git_diff: ({ staged = false }) => {
      let cmd;
      if (staged) cmd = "git diff --staged";
      else if (range) cmd = `git diff ${range}`;
      else cmd = "git diff HEAD";
      try {
        const out = execSync(cmd, { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
        if (out.length > MAX_DIFF_BYTES) {
          return out.slice(0, MAX_DIFF_BYTES) + "\n\n[diff truncated]";
        }
        return out || "(no changes)";
      } catch (err) {
        return `Error running git diff: ${err.message}`;
      }
    },

    read_file: ({ path }) => {
      try {
        return readFileSync(path, "utf-8");
      } catch (err) {
        return `Error reading ${path}: ${err.message}`;
      }
    },

    list_changed_files: () => {
      try {
        const out = range
          ? execSync(`git diff ${range} --name-status`, { encoding: "utf-8" })
          : execSync("git status --porcelain", { encoding: "utf-8" });
        return out || "(no changes)";
      } catch (err) {
        return `Error: ${err.message}`;
      }
    },
  };
}

export const toolHandlers = createToolHandlers();

# hindsight-agent

A post-implementation code review agent for Claude Code. Once Claude finishes a commit, hindsight reviews it with fresh eyes and asks: *now that we have a working solution, is there a cleaner approach?*

Distributed two ways:
- **Claude Code plugin** — auto-fires after every `git commit`, `git commit --amend`, or `git rebase` Claude runs in a session
- **CLI** — `hindsight-agent` you can invoke manually against any commit range

Both surfaces share the same review engine, cache, and log.

## Why?

When Claude Code is mid-task, it makes local decisions to keep the work moving. Abstractions get introduced, helpers get extracted, patterns emerge that made sense in flight. Once the task is done and the solution actually works, those choices often look different. A fresh second pass — done by an agent that never saw the journey, only the destination — catches things the original pass can't.

That's hindsight: a separate agent, with its own system prompt and its own tools, that reviews the *finished* state and tells you whether there's a cleaner version.

## How it works

```
Claude runs `git commit` (or --amend, or rebase)
    │
    ▼
PostToolUse hook fires (async — Claude session never blocks)
    │
    ▼
Resolve range:  commit/amend → HEAD~1..HEAD
                rebase       → ORIG_HEAD..HEAD
    │
    ▼
Skip rules (main branch, WIP, [no-review], cap=3)
    │
    ▼
Hash the diff (doc files excluded)
    │
┌───┴───┐
▼       ▼
cached?  miss?
    │       │
    │       ▼
    │   Phase 1: Triage (Haiku)
    │       │
    │       ▼
    │   Phase 2: Deep review (Sonnet)
    │   with prior review on this branch as context
    │       │
    └───────┴──► Append to hindsight-agent-reviews.log
                 │
                 ▼
            Stop hook surfaces `worth_refactoring`
            verdicts back into the Claude session
```

Every run produces a log entry, even skips. The log is the single source of truth for what the agent has done.

## Requirements

- **Node.js 20+** on PATH
- **An [Anthropic API key](https://console.anthropic.com/settings/keys)** exported as `ANTHROPIC_API_KEY`. Reviews bill against your API account, **not** your Claude.ai subscription
- **Git**
- **Claude Code 2.x**
- **`jq`** (used by the plugin's hook script — almost certainly already on your system)

## Install

In Claude Code:

```
/plugin marketplace add danworkman1/hindsight-agent
/plugin install hindsight-agent@danworkman1
```

Restart Claude Code if prompted. From the next session forward, every commit, amend, or rebase Claude performs triggers an async review, and any `worth_refactoring` verdicts are surfaced back into the session via the Stop hook.

The engine is bundled inside the plugin — no separate install step.

> **`ANTHROPIC_API_KEY` is required.** Reviews are made by a hook subprocess that bills against your **API account**, not your Claude.ai subscription — Anthropic doesn't permit third-party plugins to use subscription auth. Export `ANTHROPIC_API_KEY` in your shell rc (use `~/.zshenv` or `~/.bash_profile` so non-interactive shells inherit it). Without the key the hook logs a `[skip]` line and exits cleanly — your Claude session is never blocked.

### Tail the log (optional)

Reviews stream to `hindsight-agent-reviews.log` in whatever git repo Claude was working in. Tail it in a side terminal if you want to read every entry:

```bash
tail -f hindsight-agent-reviews.log
```

You'll also want to add `hindsight-agent-reviews.log` and `hindsight-agent-review-cache.json` to your `.gitignore`.

## CLI reference

The plugin's engine is also exposed as a CLI (`hindsight-agent`) for one-off reviews outside a Claude Code session. The CLI is not published — to use it, clone this repo and link it locally (see `LOCAL-DEV.md`).

```
hindsight-agent [options]
```

| Flag | Description |
|------|-------------|
| `--path <dir>` | Run against this repo instead of cwd |
| `--base <ref>` | Diff against `<ref>..HEAD` instead of `HEAD~1..HEAD` |
| `--force` | Skip cache, skip-rules, and the no-changes guard |
| `--triage-model <model>` | Phase 1 model. Default: `haiku` |
| `--review-model <model>` | Phase 2 model. Default: `sonnet` |
| `--review-cap <n>` | Max auto-reviews per branch before skipping. Default: `3` |
| `help` | Print usage |

**Model values:** `haiku`, `sonnet`, `opus` (or a raw Anthropic model ID).

### Configuring the plugin

The plugin hook calls the CLI with no flags, so to customize behavior for auto-fired reviews, set environment variables. They take effect for both the plugin and the CLI (flags still win when both are present).

| Env var | Equivalent flag |
|---------|-----------------|
| `HINDSIGHT_TRIAGE_MODEL` | `--triage-model` |
| `HINDSIGHT_REVIEW_MODEL` | `--review-model` |
| `HINDSIGHT_REVIEW_CAP` | `--review-cap` |

Set them in `~/.zshenv` (or `~/.bash_profile`) so non-interactive shells — which is what Claude Code hooks run in — inherit them:

```bash
export HINDSIGHT_REVIEW_MODEL=opus
export HINDSIGHT_REVIEW_CAP=5
```

`~/.zshrc` will not work for the plugin hook because it's only sourced for interactive shells.

### Examples

```bash
# Review the last commit (same as the plugin would after Claude commits)
hindsight-agent

# Force a review of everything on this branch vs main
hindsight-agent --force --base main

# Point at a different repo
hindsight-agent --path ~/coding/my-project --force --base main

# Use Opus for the deep review pass
hindsight-agent --force --base main --review-model opus
```

## Reading the log

```
[2026-05-03T10:25:42Z] [my-project] [REVIEW] Added auth middleware in src/auth.ts

**Verdict: clean**
The implementation is straightforward and well-scoped...

[2026-05-03T10:31:08Z] [my-project] [REVIEW] Refactored user fetching into a hook

**Verdict: worth refactoring**
The new `useUserData` hook duplicates logic that already lives in
`useAuth`. Consider consolidating...
```

- `[skip]` lines — agent ran, nothing to review (no code changes, doc-only commit, etc.)
- `[REVIEW] ... clean` — code looks good, no action needed
- `[REVIEW] ... worth refactoring` — read this one; the agent thinks there's a cleaner approach

When the plugin is installed, `worth_refactoring` reviews are also surfaced directly back into the active Claude Code session via the Stop hook — you don't have to be tailing the log to see them.

### Useful log commands

```bash
grep -A30 "\[REVIEW\]" hindsight-agent-reviews.log        # substantive reviews only
grep "\[my-project\]" hindsight-agent-reviews.log         # one project
grep "$(date -u +%Y-%m-%d)" hindsight-agent-reviews.log   # today
```

## Resetting

```bash
rm hindsight-agent-review-cache.json    # forces re-review of every diff
> hindsight-agent-reviews.log           # clear the log
```

## Behaviour notes

- **Async** — the plugin hook returns immediately; reviews never block your Claude session
- **Exits 0 on errors** — a failed review never blocks Claude or your commits
- **Cache** grows unbounded under normal use; soft cap at 5MB triggers eviction down to the 1000 most recent entries
- **Untracked files** are included in the hash and the review (uncommitted new files would otherwise be invisible to `git diff`)
- **Branch cap**: 3 reviews per branch by default (configurable via `--review-cap` or `HINDSIGHT_REVIEW_CAP`). After that, runs log a `[CAP]` line and skip the model call. Use `--force` to override
- **Skipped commit messages**: `wip`, `WIP`, `[no-review]`
- **Skipped branches**: `main`, `master` (squash-merges and CI commits don't burn reviews)
- **Prior review context**: when re-reviewing a branch, the prior verdict and suggestions are fed into the prompt so the model reassesses rather than repeating itself
- **Rebases** review the entire `ORIG_HEAD..HEAD` range as one pass, not per-commit
- **Amends** review `HEAD~1..HEAD`; if the diff hash is unchanged from the original commit, the cached verdict is replayed (no API call)

## Costs

Rough per-run costs at current Anthropic pricing:

- Skip path / cache hit: **$0**
- Triage only, no code changes: **fractions of a cent** (Haiku)
- Triage + deep review: **a few cents** depending on diff size

The diff-hash cache means you only pay for unique working-tree states. Set a monthly spending cap in the [Anthropic Console](https://console.anthropic.com/settings/limits) while you're getting comfortable.

## Feedback mode (Stop hook internals)

`surface.js` is the plugin's Stop-hook entry point. When the review pipeline lands a `worth_refactoring` verdict for the current HEAD, surface writes it to stderr and exits 2 — Claude Code's protocol for injecting a prompt back into the conversation. Each review is surfaced at most once (tracked via the `surfaced` flag in the cache). The hook respects `stop_hook_active` so it can't recurse on its own output.

## Contributing

Issues and PRs welcome. Particularly interested in:

- Better triage prompts (the model occasionally over- or under-reports)
- Additional tools the deep review could benefit from (e.g. running tests, viewing recent commit history)
- A "defer to worktree" surface mode for `worth_refactoring` verdicts

## License

MIT

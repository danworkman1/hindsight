# hindsight

Post-implementation code review for Claude Code. Once a branch is done, hindsight reviews it with fresh eyes and asks: *now that we have a working solution, is there a cleaner approach?*

## Why?

When Claude Code is mid-task, it makes local decisions to keep the work moving. Abstractions get introduced, helpers get extracted, patterns emerge that made sense in flight. Once the task is done and the solution actually works, those choices often look different. A fresh second pass — done by an agent that never saw the journey, only the destination — catches things the original pass can't.

That's hindsight: a separate agent, with its own system prompt and its own tools, that reviews the *finished* state and tells you whether there's a cleaner version.

## Quick start

```bash
# Install globally (or use npx)
npm install -g hindsight

# Export your Anthropic API key
export ANTHROPIC_API_KEY=sk-ant-...

# Finish your branch, then:
hindsight
```

The verdict prints to stdout. That's it.

## How it works

```
Finish a branch
    │
    ▼
Run `hindsight` (defaults to main..HEAD)
    │
    ▼
Phase 1: Triage (Haiku) — was code actually changed?
    │
    ▼
Phase 2: Deep review (Opus) — is there a cleaner solution?
    │
    ▼
Verdict prints to stdout
```

## Requirements

- **Node.js 20+**
- **An [Anthropic API key](https://console.anthropic.com/settings/keys)** exported as `ANTHROPIC_API_KEY`. Reviews bill against your **API account**, not your Claude.ai subscription
- **Git**

## CLI reference

```
hindsight [options]
```

| Flag | Description |
|------|-------------|
| `--base <ref>` | Diff against `<ref>..HEAD` instead of `main..HEAD` |
| `--force` | Skip triage — go straight to deep review |
| `--path <dir>` | Run against this repo instead of cwd |
| `--triage-model <model>` | Phase 1 model. Default: `haiku` |
| `--review-model <model>` | Phase 2 model. Default: `opus` |
| `help` | Print usage |

**Model values:** `haiku`, `sonnet`, `opus` (or a raw Anthropic model ID).

### Environment variables

| Env var | Equivalent flag |
|---------|-----------------|
| `HINDSIGHT_TRIAGE_MODEL` | `--triage-model` |
| `HINDSIGHT_REVIEW_MODEL` | `--review-model` |

Flags always win over env vars.

### Examples

```bash
# Review the whole branch against main (default)
hindsight

# Review against a different base
hindsight --base develop

# Force a deep review (skip triage)
hindsight --force

# Point at a different repo
hindsight --path ~/coding/my-project

# Use Sonnet instead of Opus for the deep review
hindsight --review-model sonnet
```

### Edge cases

- **On `main` with no `--base`**: `main..HEAD` is empty — hindsight prints a message telling you to pass `--base` and exits non-zero.
- **No code changes**: if triage finds only doc/config changes, the verdict is `clean` and printed to stdout.

## Reading the verdict

```
Verdict: clean
Added auth middleware in src/auth.ts

Verdict: worth refactoring
src/hooks/useUserData.ts (lines 12-45)
  Issue: duplicates logic already in useAuth
  Fix:   consolidate into useAuth and re-export

The new useUserData hook duplicates logic that already lives in useAuth...
```

- **clean** — code looks good, no action needed
- **minor suggestions** — small notes, not worth acting on
- **worth refactoring** — the agent thinks there's a meaningfully cleaner approach

## Costs

Rough per-run costs at current Anthropic pricing:

- Triage only, no code changes: **fractions of a cent** (Haiku)
- Triage + deep review: **a few cents** depending on diff size (Opus)

Set a monthly spending cap in the [Anthropic Console](https://console.anthropic.com/settings/limits) while you're getting comfortable.

---

## Automated reviews (optional)

hindsight also ships as a **Claude Code plugin** that auto-fires a review after every `git commit`, `git commit --amend`, or `git rebase` Claude runs in a session. This is the "set and forget" mode — you don't run anything manually.

### Plugin install

In Claude Code:

```
/plugin marketplace add danworkman1/hindsight
/plugin install hindsight@danworkman1
```

Restart Claude Code if prompted. From the next session forward, every commit, amend, or rebase Claude performs triggers an async review.

> **`ANTHROPIC_API_KEY` is required.** Reviews are made by a hook subprocess that bills against your **API account**, not your Claude.ai subscription — Anthropic doesn't permit third-party plugins to use subscription auth. Export `ANTHROPIC_API_KEY` in your shell rc (use `~/.zshenv` or `~/.bash_profile` so non-interactive shells inherit it). Without the key the hook logs a `[skip]` line and exits cleanly — your Claude session is never blocked.

### Plugin requirements

Everything the CLI needs, plus:

- **Claude Code 2.x**
- **`jq`** (used by the plugin's hook script — almost certainly already on your system)

### How the plugin works

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
    │   Phase 2: Deep review (Opus)
    │   with prior review on this branch as context
    │       │
    └───────┴──► Append to hindsight-reviews.log
                 │
                 ▼
            Stop hook surfaces `worth_refactoring`
            verdicts back into the Claude session
```

Every run produces a log entry, even skips. The log is the single source of truth for what the plugin has done.

### Tail the log

Reviews stream to `hindsight-reviews.log` in whatever git repo Claude was working in:

```bash
tail -f hindsight-reviews.log
```

Add `hindsight-reviews.log` and `hindsight-review-cache.json` to your `.gitignore`.

### Configuring the plugin

Set environment variables in `~/.zshenv` (or `~/.bash_profile`) so non-interactive shells — which is what Claude Code hooks run in — inherit them:

```bash
export HINDSIGHT_REVIEW_MODEL=sonnet   # override deep-review model
export HINDSIGHT_REVIEW_CAP=5          # override branch cap (default 3)
```

| Env var | Equivalent flag |
|---------|-----------------|
| `HINDSIGHT_TRIAGE_MODEL` | `--triage-model` |
| `HINDSIGHT_REVIEW_MODEL` | `--review-model` |
| `HINDSIGHT_REVIEW_CAP` | `--review-cap` |

`~/.zshrc` will not work for the plugin hook because it's only sourced for interactive shells.

### Useful log commands

```bash
grep -A30 "\[REVIEW\]" hindsight-reviews.log        # substantive reviews only
grep "\[my-project\]" hindsight-reviews.log         # one project
grep "$(date -u +%Y-%m-%d)" hindsight-reviews.log   # today
```

### Resetting

```bash
rm hindsight-review-cache.json    # forces re-review of every diff
> hindsight-reviews.log           # clear the log
```

### Plugin behaviour notes

- **Async** — the plugin hook returns immediately; reviews never block your Claude session
- **Exits 0 on errors** — a failed review never blocks Claude or your commits
- **Cache** grows unbounded under normal use; soft cap at 5MB triggers eviction down to the 1000 most recent entries
- **Untracked files** are included in the hash and the review (uncommitted new files would otherwise be invisible to `git diff`)
- **Branch cap**: 3 reviews per branch by default (configurable via `HINDSIGHT_REVIEW_CAP`). After that, runs log a `[CAP]` line and skip the model call. Use `--force` to override
- **Skipped commit messages**: `wip`, `WIP`, `[no-review]`
- **Skipped branches**: `main`, `master` (squash-merges and CI commits don't burn reviews)
- **Prior review context**: when re-reviewing a branch, the prior verdict and suggestions are fed into the prompt so the model reassesses rather than repeating itself
- **Rebases** review the entire `ORIG_HEAD..HEAD` range as one pass, not per-commit
- **Amends** review `HEAD~1..HEAD`; if the diff hash is unchanged from the original commit, the cached verdict is replayed (no API call)

### Feedback mode (Stop hook)

`surface.js` is the plugin's Stop-hook entry point. When the review pipeline lands a `worth_refactoring` verdict for the current HEAD, surface writes it to stderr and exits 2 — Claude Code's protocol for injecting a prompt back into the conversation. Each review is surfaced at most once (tracked via the `surfaced` flag in the cache). The hook respects `stop_hook_active` so it can't recurse on its own output.

## Contributing

Issues and PRs welcome. Particularly interested in:

- Better triage prompts (the model occasionally over- or under-reports)
- Additional tools the deep review could benefit from (e.g. running tests, viewing recent commit history)
- A "defer to worktree" surface mode for `worth_refactoring` verdicts

## License

MIT

#!/usr/bin/env bash
# PostToolUse hook for the Bash tool. Fires after every Bash command Claude runs.
# Filters for successful git commit/amend/rebase invocations and triggers a
# hindsight review against the appropriate range.

set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

payload=$(cat)

cmd=$(printf '%s' "$payload"      | jq -r '.tool_input.command // ""')
interrupted=$(printf '%s' "$payload" | jq -r '.tool_response.interrupted // false')
cwd=$(printf '%s' "$payload"       | jq -r '.cwd // ""')

[[ "$interrupted" == "false" ]] || exit 0
[[ -n "$cwd" ]] || exit 0
cd "$cwd"

# Match `git commit` and `git -C /path commit` (with optional chaining via &&/;)
if printf '%s' "$cmd" | grep -qE 'git(\s+-C\s+\S+)?\s+rebase\b'; then
  git rev-parse ORIG_HEAD >/dev/null 2>&1 || exit 0
  base="ORIG_HEAD"
elif printf '%s' "$cmd" | grep -qE 'git(\s+-C\s+\S+)?\s+commit\b'; then
  base="HEAD~1"
else
  exit 0
fi

exec "$PLUGIN_ROOT/bin/run-with-node.sh" "$PLUGIN_ROOT/dist/index.js" --auto --base "$base"

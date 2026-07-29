#!/usr/bin/env bash
# Printed after `npm install`. This package is a Bash launcher plus an agent
# definition; it bundles no runtime and npm installs none of the tools below.
# Report what is present so a missing prerequisite is obvious now rather than at
# first dispatch.
#
# Never fails the npm install. Informational only.

set -u

have() { command -v "$1" > /dev/null 2>&1; }

printf '\nclaude-code-codex-subagent: external prerequisites (npm does not install these)\n\n'

if have codex; then
  printf '  present  codex CLI  %s\n' "$(codex --version 2>/dev/null | head -1)"
else
  printf '  MISSING  codex CLI        npm install -g @openai/codex\n'
fi

if [ -f "${CODEX_HOME:-$HOME/.codex}/auth.json" ]; then
  printf '  present  codex auth\n'
else
  printf '  MISSING  codex auth       run: codex  (sign in once)\n'
fi

if have setsid; then
  printf '  present  setsid\n'
else
  printf '  MISSING  setsid           util-linux; on macOS: brew install util-linux\n'
fi

if have claude; then
  printf '  present  Claude Code %s\n' "$(claude --version 2>/dev/null | head -1)"
else
  printf '  MISSING  Claude Code      https://claude.com/claude-code\n'
fi

printf '\n  Next:  codex-subagent install     (writes the agent, then restart Claude Code)\n'
printf '  Check: codex-subagent check       (re-run this report at any time)\n\n'

exit 0

#!/usr/bin/env bash
# Install the `codex` subagent into Claude Code.
#
# Writes ~/.claude/agents/codex.md with this checkout's absolute paths baked in,
# so the agent works regardless of where you cloned it or what is on PATH.
#
# Usage:
#   ./install.sh            install or update
#   ./install.sh --check    verify prerequisites only
#   ./install.sh --uninstall

set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAUNCHER="$REPO/bin/codex-subagent"
SCHEMAS="$REPO/schemas"
SOURCE_AGENT="$REPO/agents/codex.md"
TARGET_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/agents"
TARGET="$TARGET_DIR/codex.md"

ok()   { printf '  ok    %s\n' "$1"; }
warn() { printf '  warn  %s\n' "$1"; }
bad()  { printf '  FAIL  %s\n' "$1"; }
die()  { printf 'install: %s\n' "$1" >&2; exit 1; }

check() {
  local failed=0
  echo "Checking prerequisites:"

  if command -v codex > /dev/null 2>&1; then
    ok "codex CLI: $(codex --version 2>/dev/null | head -1)"
  else
    bad "codex CLI not on PATH. Install: npm install -g @openai/codex"
    failed=1
  fi

  if command -v setsid > /dev/null 2>&1; then
    ok "setsid available (needed to detach runs)"
  else
    bad "setsid not found. It ships with util-linux; runs cannot be detached without it."
    failed=1
  fi

  if [ -x "$LAUNCHER" ]; then
    ok "launcher executable"
  else
    bad "launcher missing or not executable: $LAUNCHER"
    failed=1
  fi

  if [ -f "$HOME/.codex/auth.json" ]; then
    ok "codex appears authenticated"
  else
    warn "no ~/.codex/auth.json found; run 'codex' once to sign in"
  fi

  return "$failed"
}

uninstall() {
  if [ -e "$TARGET" ] || [ -L "$TARGET" ]; then
    rm -f "$TARGET" && echo "Removed $TARGET"
  else
    echo "Nothing to remove at $TARGET"
  fi
  echo "Note: run directories under ~/.cache/codex-subagent are left in place."
}

install_agent() {
  [ -f "$SOURCE_AGENT" ] || die "missing $SOURCE_AGENT"
  mkdir -p "$TARGET_DIR" || die "cannot create $TARGET_DIR"

  # A previous version of this project symlinked the target. Replace any symlink
  # with a real file so the path substitution below actually takes effect.
  [ -L "$TARGET" ] && rm -f "$TARGET"

  sed -e "s|@@LAUNCHER@@|$LAUNCHER|g" \
      -e "s|@@SCHEMAS@@|$SCHEMAS|g" \
      "$SOURCE_AGENT" > "$TARGET.tmp" || die "failed to render agent"

  if grep -q '@@' "$TARGET.tmp"; then
    rm -f "$TARGET.tmp"
    die "unsubstituted placeholder remains in rendered agent"
  fi

  mv -f "$TARGET.tmp" "$TARGET" || die "failed to write $TARGET"
  chmod +x "$LAUNCHER" 2>/dev/null || true
  echo "Installed $TARGET"
}

case "${1:-}" in
  --check)
    check
    exit $?
    ;;
  --uninstall)
    uninstall
    exit 0
    ;;
  "")
    check || echo
    install_agent
    echo
    echo "Restart Claude Code (or run /reload-plugins) so the agent registry picks it up."
    echo "Then dispatch it with:  Agent(subagent_type: \"codex\", prompt: \"...\")"
    ;;
  *)
    die "unknown option: $1"
    ;;
esac

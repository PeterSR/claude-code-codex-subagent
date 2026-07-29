#!/usr/bin/env bash
# Install the `codex` subagent into Claude Code.
#
# Renders agents/codex.md into ~/.claude/agents/codex.md with this checkout's
# absolute paths baked in, so the agent works regardless of where you cloned it
# or what is on PATH.
#
# Usage:
#   ./install.sh              install or update
#   ./install.sh --status     show what is installed and whether it still works
#   ./install.sh --check      verify prerequisites only
#   ./install.sh --uninstall  remove the agent (keeps run directories)
#   ./install.sh --purge      remove the agent and all run directories
#
# Add --force to overwrite or remove a codex.md this installer does not own.

set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAUNCHER="$REPO/bin/codex-subagent"
SCHEMAS="$REPO/schemas"
SOURCE_AGENT="$REPO/agents/codex.md"
TARGET_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/agents"
TARGET="$TARGET_DIR/codex.md"
RUNS="${XDG_CACHE_HOME:-$HOME/.cache}/codex-subagent"

# Ownership marker. Written into the rendered file so uninstall can tell our
# file from one the user wrote by hand, and so --status can find the source.
MARKER="installed-by: claude-code-codex-subagent"

FORCE=0

ok()   { printf '  ok    %s\n' "$1"; }
warn() { printf '  warn  %s\n' "$1"; }
bad()  { printf '  FAIL  %s\n' "$1"; }
die()  { printf 'install: %s\n' "$1" >&2; exit 1; }

owns_target() { [ -f "$TARGET" ] && grep -qF "$MARKER" "$TARGET"; }
target_source() { sed -n 's/^<!-- '"$MARKER"' from \(.*\) -->$/\1/p' "$TARGET" 2>/dev/null | head -1; }

check() {
  local failed=0
  echo "Prerequisites:"

  if command -v codex > /dev/null 2>&1; then
    ok "codex CLI: $(codex --version 2>/dev/null | head -1)"
  else
    bad "codex CLI not on PATH. Install: npm install -g @openai/codex"
    failed=1
  fi

  if command -v setsid > /dev/null 2>&1; then
    ok "setsid available (needed to detach runs)"
  else
    bad "setsid not found. Ships with util-linux; on macOS: brew install util-linux"
    failed=1
  fi

  if [ -x "$LAUNCHER" ]; then
    ok "launcher executable"
  else
    bad "launcher missing or not executable: $LAUNCHER"
    failed=1
  fi

  if [ -f "${CODEX_HOME:-$HOME/.codex}/auth.json" ]; then
    ok "codex appears authenticated"
  else
    warn "no codex auth found; run 'codex' once to sign in"
  fi

  return "$failed"
}

status() {
  echo "Agent:"
  if [ ! -e "$TARGET" ] && [ ! -L "$TARGET" ]; then
    warn "not installed ($TARGET)"
  elif owns_target; then
    local src; src="$(target_source)"
    ok "installed at $TARGET"
    if [ -n "$src" ]; then
      if [ "$src" = "$REPO" ]; then
        ok "installed from this checkout"
      else
        warn "installed from a DIFFERENT checkout: $src"
      fi
      if [ -x "$src/bin/codex-subagent" ]; then
        ok "launcher it points at still exists"
      else
        bad "launcher is GONE: $src/bin/codex-subagent (was the repo moved or deleted?)"
        echo "        fix: re-run ./install.sh from the current checkout"
      fi
    fi
  else
    warn "a codex.md exists but this installer did not create it: $TARGET"
    echo "        install/uninstall will not touch it without --force"
  fi

  echo "Runs:"
  if [ -d "$RUNS" ]; then
    local n sz
    n=$(find "$RUNS" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')
    sz=$(du -sh "$RUNS" 2>/dev/null | cut -f1)
    ok "$n run director$([ "$n" = 1 ] && echo y || echo ies), ${sz:-unknown} in $RUNS"
  else
    ok "no run directories yet"
  fi
}

remove_agent() {
  if [ ! -e "$TARGET" ] && [ ! -L "$TARGET" ]; then
    echo "Agent not installed, nothing to remove."
    return 0
  fi
  # A symlink is how an early version of this project installed; always ours.
  if [ -L "$TARGET" ] || owns_target || [ "$FORCE" = 1 ]; then
    rm -f "$TARGET" && echo "Removed $TARGET"
  else
    die "$TARGET was not created by this installer. Re-run with --force to remove it anyway."
  fi
}

remove_runs() {
  if [ ! -d "$RUNS" ]; then
    echo "No run directories to remove."
    return 0
  fi
  local n; n=$(find "$RUNS" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')
  rm -rf "${RUNS:?}" && echo "Removed $n run director$([ "$n" = 1 ] && echo y || echo ies) from $RUNS"
}

install_agent() {
  [ -f "$SOURCE_AGENT" ] || die "missing $SOURCE_AGENT"
  mkdir -p "$TARGET_DIR" || die "cannot create $TARGET_DIR"

  # Refuse to clobber someone else's agent, but keep a backup if forced.
  if [ -f "$TARGET" ] && ! owns_target && [ ! -L "$TARGET" ]; then
    if [ "$FORCE" = 1 ]; then
      local backup
      backup="$TARGET.bak.$(date +%Y%m%d-%H%M%S)"
      cp "$TARGET" "$backup" && warn "backed up existing agent to $backup"
    else
      die "$TARGET exists and was not created by this installer.
     Re-run with --force to back it up and replace it."
    fi
  fi
  # Early versions symlinked the target; replace so substitution takes effect.
  [ -L "$TARGET" ] && rm -f "$TARGET"

  # Pure bash substitution. sed would break on a checkout path containing
  # characters it treats specially, such as | or &.
  local body
  body="$(cat "$SOURCE_AGENT")" || die "cannot read $SOURCE_AGENT"
  body="${body//@@LAUNCHER@@/$LAUNCHER}"
  body="${body//@@SCHEMAS@@/$SCHEMAS}"

  case "$body" in
    *@@*) die "unsubstituted placeholder remains in rendered agent" ;;
  esac

  local tmp="$TARGET.tmp.$$"
  {
    printf '%s\n' "$body"
    printf '\n<!-- %s from %s -->\n' "$MARKER" "$REPO"
  } > "$tmp" || { rm -f "$tmp"; die "failed to write $tmp"; }

  mv -f "$tmp" "$TARGET" || { rm -f "$tmp"; die "failed to install $TARGET"; }
  chmod +x "$LAUNCHER" 2>/dev/null || true
  echo "Installed $TARGET"
}

ACTION="install"
while [ $# -gt 0 ]; do
  case "$1" in
    --status)    ACTION="status"; shift ;;
    --check)     ACTION="check"; shift ;;
    --uninstall) ACTION="uninstall"; shift ;;
    --purge)     ACTION="purge"; shift ;;
    --force)     FORCE=1; shift ;;
    -h|--help)   sed -n '2,16p' "$0"; exit 0 ;;
    *)           die "unknown option: $1" ;;
  esac
done

case "$ACTION" in
  status)    status ;;
  check)     check; exit $? ;;
  uninstall) remove_agent ;;
  purge)     remove_agent; remove_runs ;;
  install)
    if ! check; then
      echo
      warn "prerequisites above failed; installing anyway, but fix them before first use"
    fi
    echo
    install_agent
    echo
    echo "Restart Claude Code so the agent registry picks it up."
    echo "Then dispatch it with:  Agent(subagent_type: \"codex\", prompt: \"...\")"
    echo
    echo "If you later move or delete this checkout, re-run ./install.sh."
    ;;
esac

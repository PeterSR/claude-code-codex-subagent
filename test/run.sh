#!/usr/bin/env bash
# Regression tests. No network and no Codex CLI required: every case here
# exercises argument handling, the run-state machine, or the install lifecycle.
#
# Usage: bash test/run.sh

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LAUNCHER="$ROOT/bin/codex-subagent"
INSTALLER="$ROOT/install.sh"

PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); printf '  ok    %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf '  FAIL  %s\n     -> %s\n' "$1" "${2:-}"; }
eq()   { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1" "expected '$3', got '$2'"; fi; }
# ok_if <status> <description> [detail]  -- status 0 passes
ok_if() { if [ "$1" -eq 0 ]; then pass "$2"; else fail "$2" "${3:-}"; fi; }

TMP="$(mktemp -d)"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

echo "argument validation"
# A trailing flag with no value used to spin forever, since `shift 2` fails and
# `set -e` is deliberately not enabled.
timeout 8 "$LAUNCHER" wait "$TMP" --timeout-sec > /dev/null 2>&1
eq "wait --timeout-sec with no value exits 64" "$?" "64"

timeout 8 "$LAUNCHER" wait "$TMP" --timeout-sec abc > /dev/null 2>&1
eq "non-numeric timeout rejected" "$?" "64"

echo x | timeout 8 "$LAUNCHER" start --resume --last > /dev/null 2>&1
eq "option is not swallowed as a value" "$?" "64"

echo x | timeout 8 "$LAUNCHER" start --model > /dev/null 2>&1
eq "missing value exits 64 not 1" "$?" "64"

echo x | timeout 8 "$LAUNCHER" start --sandbox nonsense > /dev/null 2>&1
eq "invalid sandbox rejected" "$?" "64"

timeout 8 "$LAUNCHER" bogus-subcommand > /dev/null 2>&1
eq "unknown subcommand rejected" "$?" "64"

echo "run state machine"
DEAD="$TMP/dead"; mkdir -p "$DEAD"; echo 999999 > "$DEAD/pid"
out="$(timeout 25 "$LAUNCHER" wait "$DEAD" --timeout-sec 10 2>&1)"
eq "run that died without a marker exits 70" "$?" "70"
case "$out" in *"RUN DIED"*) pass "and explains why" ;; *) fail "explains why" "no RUN DIED line" ;; esac

LIVE="$TMP/with space"; mkdir -p "$LIVE"
sleep 30 & LIVE_PID=$!; echo "$LIVE_PID" > "$LIVE/pid"
START=$(date +%s)
out="$(timeout 25 "$LAUNCHER" wait "$LIVE" --timeout-sec 2 2>&1)"
rc=$?; ELAPSED=$(( $(date +%s) - START ))
kill "$LIVE_PID" 2>/dev/null
eq "live run not yet finished exits 75" "$rc" "75"
if [ "$ELAPSED" -le 4 ]; then pass "honours a short timeout (${ELAPSED}s)"
else fail "honours a short timeout" "took ${ELAPSED}s for --timeout-sec 2"; fi
case "$out" in *"Call again"*\\*|*"Call again"*\'*) pass "retry hint is shell-quoted" ;;
                *) fail "retry hint is shell-quoted" "$(printf '%s' "$out" | grep 'Call again')" ;; esac

DONE="$TMP/done"; mkdir -p "$DONE"; printf '0' > "$DONE/exit"; printf 'hello\n' > "$DONE/answer.md"
out="$(timeout 8 "$LAUNCHER" wait "$DONE" --timeout-sec 1 2>&1)"
eq "finished run returns its exit code" "$?" "0"
case "$out" in *hello*) pass "and prints the answer" ;; *) fail "prints the answer" "missing" ;; esac

REUSE="$TMP/reuse"; mkdir -p "$REUSE"; : > "$REUSE/exit"
echo x | timeout 8 "$LAUNCHER" start --run-dir "$REUSE" > /dev/null 2>&1
eq "refuses to reuse a run dir" "$?" "64"

echo "install lifecycle"
export CLAUDE_CONFIG_DIR="$TMP/claude"
AGENT="$CLAUDE_CONFIG_DIR/agents/codex.md"

bash "$INSTALLER" > /dev/null 2>&1
if [ -f "$AGENT" ]; then pass "install writes the agent"
else fail "install writes the agent" "missing"; fi
grep -qF "installed-by: claude-code-codex-subagent" "$AGENT"; ok_if $? "ownership marker written" "absent"
! grep -q 'CLAUDE_PLUGIN_ROOT' "$AGENT"; ok_if $? "plugin-root token substituted" "token survived"
grep -qF "$ROOT/bin/codex-subagent" "$AGENT"; ok_if $? "launcher path baked in" "not found"

bash "$INSTALLER" > /dev/null 2>&1
eq "reinstall is idempotent" "$(grep -cF 'installed-by' "$AGENT")" "1"

bash "$INSTALLER" --status > /dev/null 2>&1
eq "status succeeds when installed" "$?" "0"

printf 'hand written\n' > "$AGENT"
bash "$INSTALLER" > /dev/null 2>&1
eq "install refuses to clobber a foreign agent" "$?" "1"
bash "$INSTALLER" --uninstall > /dev/null 2>&1
eq "uninstall refuses to delete a foreign agent" "$?" "1"
grep -q "hand written" "$AGENT"; ok_if $? "foreign agent left intact" "modified"

bash "$INSTALLER" --force > /dev/null 2>&1
eq "--force installs over it" "$?" "0"
ls "$CLAUDE_CONFIG_DIR/agents/"codex.md.bak.* > /dev/null 2>&1; ok_if $? "and backs the old one up" "no backup"

bash "$INSTALLER" --uninstall > /dev/null 2>&1
if [ ! -f "$AGENT" ]; then pass "uninstall removes its own agent"
else fail "uninstall removes its own agent" "still present"; fi
bash "$INSTALLER" --uninstall 2>&1 | grep -qi "nothing to remove"; ok_if $? "uninstall is idempotent" "unexpected output"

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]

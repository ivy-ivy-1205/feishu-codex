#!/bin/sh
# Forced command for the Space auto-submit SSH key (change sheet 2026-10-20, T2).
# authorized_keys: restrict,command="/opt/feishu-codex/bin/space-submit.sh" ssh-ed25519 ... feishu-space-submit
# The key can do exactly one thing: hand one page read to `space-auto-submit` inside the Bridge.
# Accepted command: submit <projectKey> <updatedAt> <base64 title>, page Markdown on stdin.
# Only projects listed in config/space-submit-allowlist are accepted. Page text is never logged.
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd)
CONTAINER=feishu-codex-bridge
MAX_BYTES=1000000
WORK=$ROOT/space-submit
LOG=$ROOT/logs/space-submit.log
IN=
NAME=
mkdir -p "$WORK" "$ROOT/logs" && chmod 700 "$WORK"
say(){ printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$LOG"; }
cleanup(){
  [ -n "$NAME" ] && docker exec -u 0 "$CONTAINER" rm -f "/tmp/$NAME" >/dev/null 2>&1
  [ -n "$IN" ] && rm -f "$IN"
}
trap cleanup EXIT
reject(){ say "REJECT $1"; echo "$1" >&2; exit 2; }

set -f
# shellcheck disable=SC2086 # split on spaces only; globbing is off
set -- ${SSH_ORIGINAL_COMMAND:-}
set +f
[ "$#" -eq 4 ] && [ "$1" = submit ] || reject SPACE_SUBMIT_COMMAND_INVALID
KEY=$2 UPDATED=$3 TITLE_B64=$4
printf '%s' "$KEY" | grep -Eqx '[a-z0-9-]{1,64}' || reject SPACE_SUBMIT_COMMAND_INVALID
grep -Fqx -- "$KEY" "$ROOT/config/space-submit-allowlist" 2>/dev/null || reject SPACE_SUBMIT_PROJECT_NOT_ALLOWED
printf '%s' "$UPDATED" | grep -Eqx '[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})' ||
  reject SPACE_SUBMIT_UPDATED_AT_INVALID
[ "${#TITLE_B64}" -le 400 ] && printf '%s' "$TITLE_B64" | grep -Eqx '[A-Za-z0-9+/]{4,}={0,2}' || reject SPACE_SUBMIT_TITLE_INVALID
TITLE=$(printf '%s' "$TITLE_B64" | base64 -d 2>/dev/null) || reject SPACE_SUBMIT_TITLE_INVALID
case "$TITLE" in ''|*'
'*) reject SPACE_SUBMIT_TITLE_INVALID;; esac

IN=$(mktemp "$WORK/page.XXXXXXXX") || reject SPACE_SUBMIT_TEMP_FAILED
head -c $((MAX_BYTES + 1)) > "$IN"
SIZE=$(wc -c < "$IN" | tr -d ' ')
[ "$SIZE" -le "$MAX_BYTES" ] || reject SPACE_SUBMIT_TOO_LARGE
[ "$SIZE" -gt 0 ] || reject SPACE_SUBMIT_EMPTY

NAME=space-submit-$(basename "$IN").md
docker cp "$IN" "$CONTAINER:/tmp/$NAME" >/dev/null 2>&1 && docker exec -u 0 "$CONTAINER" chmod 644 "/tmp/$NAME" >/dev/null 2>&1 ||
  { say "FAIL key=$KEY SPACE_SUBMIT_COPY_FAILED"; echo SPACE_SUBMIT_COPY_FAILED >&2; exit 1; }
OUT=$(docker exec "$CONTAINER" node dist/cli/space-auto-submit.js --project-key "$KEY" --markdown "/tmp/$NAME" \
  "--title=$TITLE" --updated-at "$UPDATED" 2>&1)
RC=$?
OUT=$(printf '%s' "$OUT" | tr '\n' ' ' | cut -c1-400)
if [ "$RC" -eq 0 ]; then say "OK key=$KEY bytes=$SIZE $OUT"; echo "$OUT"; exit 0; fi
say "FAIL key=$KEY bytes=$SIZE rc=$RC $OUT"; echo "$OUT" >&2; exit 1

#!/usr/bin/env bash

set -euo pipefail

readonly DATABASE="/opt/feishu-codex/data/bridge.sqlite"
readonly BACKUP_DIR="/opt/feishu-codex/backups"
readonly RETAIN_COUNT=14

timestamp="$(date -u +'%Y%m%dT%H%M%SZ')"
temporary_backup="${BACKUP_DIR}/.bridge-${timestamp}.sqlite.tmp"
final_backup="${BACKUP_DIR}/bridge-${timestamp}.sqlite"

cleanup() {
  rm -f -- "${temporary_backup}"
}
trap cleanup EXIT

command -v sqlite3 >/dev/null
test -f "${DATABASE}"
install -d -m 700 "${BACKUP_DIR}"

sqlite3 "${DATABASE}" ".backup '${temporary_backup}'"
test -s "${temporary_backup}"
mv -- "${temporary_backup}" "${final_backup}"
chmod 600 "${final_backup}"

mapfile -t backups < <(
  find "${BACKUP_DIR}" -maxdepth 1 -type f -name 'bridge-*.sqlite' \
    -printf '%T@ %p\n' |
    sort -rn |
    cut -d' ' -f2-
)

for ((index = RETAIN_COUNT; index < ${#backups[@]}; index++)); do
  rm -f -- "${backups[index]}"
done

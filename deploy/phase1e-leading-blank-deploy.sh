#!/usr/bin/env bash
set -Eeuo pipefail

if [[ ${DEPLOY_TEST_MODE:-0} == 1 ]]; then
  BASE=${BASE:?}
  EXPECTED_ARCHIVE_SHA=${EXPECTED_ARCHIVE_SHA:?}
  OLD_COMMIT=${OLD_COMMIT:?}
  OLD_IMAGE=${OLD_IMAGE:?}
  NEW_COMMIT=${NEW_COMMIT:?}
  STAMP=${DEPLOY_STAMP:?}
else
  BASE=/opt/feishu-codex
  EXPECTED_ARCHIVE_SHA=e3fc433cbb6426713b3e3a36afae624fcc5b07297ecb8f7e36a304f4a8bfc041
  OLD_COMMIT=b33b38fae00f41b5d6c817968c09d593d122fb02
  OLD_IMAGE=sha256:726b5b763b02345dbb092b1651234a13f7ae1c503a81b630413f7d451fd9ebad
  NEW_COMMIT=8f08d0859de1650e098313e2b4bd56b5d89e4380
  STAMP=$(date -u +%Y%m%dT%H%M%SZ)
fi
CONTAINER_NAME=feishu-codex-bridge
DB="$BASE/data/bridge.sqlite"
ENV_FILE="$BASE/secrets/bridge.env"
APP="$BASE/app"
ARCHIVE="$BASE/uploads/phase1e-leading-blank-8f08d08.tar.xz"
DEPLOY_STARTED=$(date -u +%Y-%m-%dT%H:%M:%SZ)
LOG="$BASE/logs/leading-blank-fix-$STAMP.log"
STATUS="$BASE/logs/leading-blank-fix-$STAMP.status"
STAGE_FILE="$BASE/logs/leading-blank-fix-$STAMP.stage"
RESULT_FILE="$BASE/logs/leading-blank-fix-$STAMP.result"
RELEASE="$BASE/releases/leading-blank-$NEW_COMMIT-$STAMP"
APP_CHECKPOINT="$BASE/app.pre-leading-blank-$NEW_COMMIT-$STAMP"
FAILED_APP="$BASE/app.failed-leading-blank-$NEW_COMMIT-$STAMP"
DB_BACKUP="$BASE/backups/bridge-pre-leading-blank-$NEW_COMMIT-$STAMP.sqlite"
ENV_BACKUP="$BASE/backups/bridge.env.pre-leading-blank-$NEW_COMMIT-$STAMP"
ROLLBACK_TAG="aijia/feishu-codex-bridge:rollback-leading-blank-$STAMP"
CANDIDATE_TAG="aijia/feishu-codex-bridge:leading-blank-$NEW_COMMIT-$STAMP"
ROLLBACK_ATTEMPTED=0

require_equal() {
  local actual=$1 expected=$2 label=$3
  if [[ "$actual" != "$expected" ]]; then
    printf '%s: expected %s, got %s\n' "$label" "$expected" "$actual" >&2
    return 1
  fi
}

query_scalar() {
  local sql=$1 value
  value=$(sqlite3 "$DB" "$sql") || return $?
  printf '%s' "$value"
}

require_query_equals() {
  local sql=$1 expected=$2 label=$3 actual
  actual=$(query_scalar "$sql") || return $?
  require_equal "$actual" "$expected" "$label"
}

require_no_query_rows() {
  local sql=$1 label=$2 rows
  rows=$(sqlite3 "$DB" "$sql") || return $?
  if [[ -n "$rows" ]]; then
    printf '%s: expected no rows\n' "$label" >&2
    return 1
  fi
}

verify_context_jobs_empty() {
  require_query_equals \
    "SELECT COUNT(*) FROM batch_jobs WHERE type='extract_context_candidates';" \
    0 context_job_count
}

verify_job_queue_empty() {
  verify_context_jobs_empty
  require_query_equals \
    "SELECT COUNT(*) FROM batch_jobs WHERE status IN ('queued','retry','processing');" \
    0 active_job_count
}

verify_job_invariants() {
  verify_job_queue_empty
  require_query_equals \
    "SELECT COUNT(*) FROM batch_jobs WHERE id IN ('minute:obcnam782s7dgo3i76enp9cn','minute:obcnaqhi3341z2m449s27351') AND status='failed';" \
    2 locked_failed_job_count
}

verify_flags_off() {
  local key host_value runtime_value
  for key in CONTEXT_CANDIDATES_ENABLED CONTEXT_REVIEW_ENABLED PROJECT_CONTEXT_SYNC_ENABLED; do
    host_value=$(awk -F= -v key="$key" '$1==key {print $2}' "$ENV_FILE") || return $?
    require_equal "$host_value" false "${key}_host"
    runtime_value=$(docker exec "$CONTAINER_NAME" printenv "$key") || return $?
    require_equal "$runtime_value" false "${key}_runtime"
  done
}

verify_database_state() {
  local integrity
  integrity=$(query_scalar 'PRAGMA integrity_check;') || return $?
  require_equal "$integrity" ok database_integrity
  require_no_query_rows 'PRAGMA foreign_key_check;' foreign_key_check
  require_query_equals \
    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';" \
    27 table_count
  verify_job_invariants
  require_query_equals \
    "SELECT (SELECT COUNT(*) FROM feishu_events)||','||(SELECT COUNT(*) FROM batch_jobs)||','||(SELECT COUNT(*) FROM meeting_minutes)||','||(SELECT COUNT(*) FROM meeting_summaries)||','||(SELECT COUNT(*) FROM outbox);" \
    '12,8,8,5,5' business_counts
  require_query_equals \
    "SELECT (SELECT COUNT(*) FROM context_sources)+(SELECT COUNT(*) FROM context_evidence)+(SELECT COUNT(*) FROM context_candidates)+(SELECT COUNT(*) FROM context_reviews)+(SELECT COUNT(*) FROM context_records)+(SELECT COUNT(*) FROM context_record_versions);" \
    0 context_business_count
  require_query_equals 'SELECT COUNT(*) FROM meeting_summaries;' 5 meeting_summary_count
  require_query_equals 'SELECT COUNT(*) FROM meeting_todos;' 18 meeting_todo_count
  require_query_equals 'SELECT COUNT(*) FROM outbox;' 5 outbox_count
}

verify_predeploy() {
  local containers status health restart image revision archive_line archive_sha runtime_uid_gid
  containers=$(docker ps -a --filter "name=^/$CONTAINER_NAME$" --format '{{.Names}}') || return $?
  require_equal "$containers" "$CONTAINER_NAME" container_identity
  status=$(docker inspect -f '{{.State.Status}}' "$CONTAINER_NAME") || return $?
  require_equal "$status" running container_status
  health=$(docker inspect -f '{{.State.Health.Status}}' "$CONTAINER_NAME") || return $?
  require_equal "$health" healthy container_health
  restart=$(docker inspect -f '{{.RestartCount}}' "$CONTAINER_NAME") || return $?
  require_equal "$restart" 0 container_restart_count
  image=$(docker inspect -f '{{.Image}}' "$CONTAINER_NAME") || return $?
  require_equal "$image" "$OLD_IMAGE" old_image
  revision=$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$OLD_IMAGE") || return $?
  require_equal "$revision" "$OLD_COMMIT" old_revision
  archive_line=$(sha256sum "$ARCHIVE") || return $?
  archive_sha=${archive_line%% *}
  require_equal "$archive_sha" "$EXPECTED_ARCHIVE_SHA" archive_sha256
  require_equal "$(stat -c '%a' "$BASE/data")" 700 data_directory_mode
  require_equal "$(stat -c '%u:%g' "$BASE/data")" 1000:1000 data_directory_owner
  require_equal "$(stat -c '%a' "$DB")" 600 database_mode
  require_equal "$(stat -c '%u:%g' "$DB")" 1000:1000 database_owner
  require_equal "$(stat -c '%a' "$ENV_FILE")" 600 environment_mode
  runtime_uid_gid=$(docker exec "$CONTAINER_NAME" sh -lc 'id -u; id -g' | paste -sd: -) || return $?
  require_equal "$runtime_uid_gid" 1000:1000 runtime_uid_gid
  verify_flags_off
  verify_database_state
}

mark_stage() {
  printf '%s\n' "$1" > "$STAGE_FILE"
  chmod 600 "$STAGE_FILE"
}

create_rollback_assets_and_switch() {
  local backup_integrity db_backup_sha db_backup_size env_backup_sha env_backup_size rollback_image
  install -d -m 700 "$BASE/backups"
  require_equal "$(stat -c '%a' "$BASE/backups")" 700 backup_directory_mode

  mark_stage STOP_REQUESTED
  docker stop "$CONTAINER_NAME" >/dev/null
  mark_stage STOPPED

  sqlite3 "$DB" ".backup '$DB_BACKUP'"
  chmod 600 "$DB_BACKUP"
  [[ -s "$DB_BACKUP" ]]
  require_equal "$(stat -c '%a' "$DB_BACKUP")" 600 database_backup_mode
  backup_integrity=$(sqlite3 "$DB_BACKUP" 'PRAGMA integrity_check;') || return $?
  require_equal "$backup_integrity" ok database_backup_integrity
  require_no_backup_query_rows 'PRAGMA foreign_key_check;' foreign_key_backup_check
  db_backup_sha=$(sha256sum "$DB_BACKUP") || return $?
  db_backup_sha=${db_backup_sha%% *}
  db_backup_size=$(stat -c '%s' "$DB_BACKUP") || return $?

  install -m 600 "$ENV_FILE" "$ENV_BACKUP"
  [[ -s "$ENV_BACKUP" ]]
  require_equal "$(stat -c '%a' "$ENV_BACKUP")" 600 environment_backup_mode
  env_backup_sha=$(sha256sum "$ENV_BACKUP") || return $?
  env_backup_sha=${env_backup_sha%% *}
  env_backup_size=$(stat -c '%s' "$ENV_BACKUP") || return $?

  docker tag "$OLD_IMAGE" "$ROLLBACK_TAG"
  rollback_image=$(docker image inspect -f '{{.Id}}' "$ROLLBACK_TAG") || return $?
  require_equal "$rollback_image" "$OLD_IMAGE" rollback_image
  mark_stage APP_SWITCHING
  mv "$APP" "$APP_CHECKPOINT"
  mark_stage APP_SWITCHED

  mkdir -p "$RELEASE"
  tar -xJf "$ARCHIVE" -C "$RELEASE"
  [[ -f "$RELEASE/app/Dockerfile" ]]
  docker build --label "org.opencontainers.image.revision=$NEW_COMMIT" -t "$CANDIDATE_TAG" "$RELEASE/app"
  mv "$RELEASE/app" "$APP"
  docker tag "$CANDIDATE_TAG" aijia/feishu-codex-bridge:local
  docker compose -f "$APP/deploy/docker-compose.production.yml" up -d --no-build --force-recreate bridge

  printf 'DB_BACKUP=%s\nDB_BACKUP_SIZE=%s\nDB_BACKUP_SHA256=%s\nDB_BACKUP_INTEGRITY=ok\nDB_BACKUP_FK_VIOLATIONS=0\nENV_BACKUP=%s\nENV_BACKUP_SIZE=%s\nENV_BACKUP_SHA256=%s\nAPP_CHECKPOINT=%s\nROLLBACK_TAG=%s\nOLD_IMAGE=%s\n' \
    "$DB_BACKUP" "$db_backup_size" "$db_backup_sha" "$ENV_BACKUP" "$env_backup_size" "$env_backup_sha" \
    "$APP_CHECKPOINT" "$ROLLBACK_TAG" "$OLD_IMAGE" > "$RESULT_FILE"
  chmod 600 "$RESULT_FILE"
}

require_no_backup_query_rows() {
  local sql=$1 label=$2 rows
  rows=$(sqlite3 "$DB_BACKUP" "$sql") || return $?
  if [[ -n "$rows" ]]; then
    printf '%s: expected no rows\n' "$label" >&2
    return 1
  fi
}

wait_for_healthy_container() {
  local attempt=0 health=''
  while (( attempt < 60 )); do
    if health=$(docker inspect -f '{{.State.Health.Status}}' "$CONTAINER_NAME" 2>/dev/null); then
      [[ "$health" == healthy ]] && return 0
    fi
    sleep 2
    attempt=$((attempt + 1))
  done
  printf 'container did not become healthy; last status=%s\n' "$health" >&2
  return 1
}

verify_postdeploy() {
  local status health restart new_image revision
  wait_for_healthy_container
  status=$(docker inspect -f '{{.State.Status}}' "$CONTAINER_NAME") || return $?
  require_equal "$status" running container_status
  health=$(docker inspect -f '{{.State.Health.Status}}' "$CONTAINER_NAME") || return $?
  require_equal "$health" healthy container_health
  restart=$(docker inspect -f '{{.RestartCount}}' "$CONTAINER_NAME") || return $?
  require_equal "$restart" 0 container_restart_count
  new_image=$(docker inspect -f '{{.Image}}' "$CONTAINER_NAME") || return $?
  revision=$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$new_image") || return $?
  require_equal "$revision" "$NEW_COMMIT" new_revision
  verify_flags_off
  require_equal "$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:3010/health)" 200 health_endpoint
  require_equal "$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:3010/ready)" 200 ready_endpoint
  require_equal "$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:3010/diag/projects)" 200 projects_diagnostic
  require_equal "$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:3010/diag/context)" 404 context_diagnostic
  verify_database_state
  printf 'NEW_IMAGE=%s\nNEW_COMMIT=%s\n' "$new_image" "$NEW_COMMIT" >> "$RESULT_FILE"
}

run_deployment() {
  verify_predeploy
  create_rollback_assets_and_switch
  verify_postdeploy
}

path_kind() {
  local path=$1
  if [[ -L "$path" ]]; then
    printf 'symlink'
  elif [[ -d "$path" ]]; then
    printf 'directory'
  elif [[ -e "$path" ]]; then
    printf 'other'
  else
    printf 'missing'
  fi
}

rollback_application() {
  local stage=$1 app_kind checkpoint_kind failed_app_kind
  ROLLBACK_ATTEMPTED=1
  app_kind=$(path_kind "$APP")
  checkpoint_kind=$(path_kind "$APP_CHECKPOINT")
  failed_app_kind=$(path_kind "$FAILED_APP")

  if [[ "$stage" == APP_SWITCHING && "$app_kind" == directory && \
    ( "$checkpoint_kind" == missing || "$checkpoint_kind" == other ) && \
    "$failed_app_kind" == missing ]]; then
    printf 'rollback preserving existing app: app=%s checkpoint=%s failed_app=%s\n' \
      "$app_kind" "$checkpoint_kind" "$failed_app_kind"
    docker tag "$ROLLBACK_TAG" aijia/feishu-codex-bridge:local || return $?
    docker compose -f "$APP/deploy/docker-compose.production.yml" up -d --no-build bridge || return $?
  elif [[ "$stage" == APP_SWITCHING || "$stage" == APP_SWITCHED ]]; then
    if [[ "$checkpoint_kind" != directory || \
      ( "$stage" == APP_SWITCHING && "$app_kind" == directory ) || \
      ( "$app_kind" != directory && "$app_kind" != missing ) || \
      "$failed_app_kind" != missing ]]; then
      printf 'rollback directory state unsafe: stage=%s app=%s checkpoint=%s failed_app=%s\n' \
        "$stage" "$app_kind" "$checkpoint_kind" "$failed_app_kind" >&2
      return 1
    fi
    if [[ "$app_kind" == directory ]]; then
      docker compose -f "$APP/deploy/docker-compose.production.yml" down >/dev/null 2>&1 || return $?
      mv "$APP" "$FAILED_APP" || return $?
    fi
    mv "$APP_CHECKPOINT" "$APP" || return $?
    docker tag "$ROLLBACK_TAG" aijia/feishu-codex-bridge:local || return $?
    docker compose -f "$APP/deploy/docker-compose.production.yml" up -d --no-build bridge || return $?
  elif [[ "$stage" == STOP_REQUESTED || "$stage" == STOPPED ]]; then
    docker start "$CONTAINER_NAME" >/dev/null || return $?
  else
    printf 'rollback stage unknown: %s\n' "$stage" >&2
    return 1
  fi
}

emit_success() {
  local finished payload temporary_status="$STATUS.success.tmp"
  finished=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  payload=$(cat "$RESULT_FILE") || return $?
  printf '%s\nDEPLOY_STARTED=%s\nDEPLOY_FINISHED=%s\nRESULT=DEPLOYED_FLAGS_OFF\nEXIT_STATUS=0\n' \
    "$payload" "$DEPLOY_STARTED" "$finished" > "$temporary_status" || return $?
  chmod 600 "$temporary_status" || return $?
  mv "$temporary_status" "$STATUS" || return $?
  cat "$STATUS" || return $?
}

emit_failure() {
  local exit_code=$1 result=$2 finished
  finished=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  printf 'EXIT_STATUS=%s\nRESULT=%s\nROLLBACK_ATTEMPTS=%s\nDEPLOY_FINISHED=%s\n' \
    "$exit_code" "$result" "$ROLLBACK_ATTEMPTED" "$finished" > "$STATUS"
  chmod 600 "$STATUS"
  cat "$STATUS"
}

main() {
  local run_status tee_status success_status failure_status stage=NONE
  local -a pipeline_status
  printf 'STATUS=RUNNING\nDEPLOY_STARTED=%s\n' "$DEPLOY_STARTED" > "$STATUS"
  chmod 600 "$STATUS"

  set +e
  ( set -Eeuo pipefail; run_deployment ) 2>&1 | tee -a "$LOG"
  pipeline_status=("${PIPESTATUS[@]}")
  run_status=${pipeline_status[0]}
  tee_status=${pipeline_status[1]}
  set -e

  if (( run_status == 0 && tee_status == 0 )); then
    set +e
    emit_success
    success_status=$?
    set -e
    if (( success_status == 0 )); then
      return 0
    fi
    failure_status=$success_status
  else
    failure_status=$run_status
    (( failure_status == 0 )) && failure_status=74
  fi

  if [[ -f "$STAGE_FILE" ]]; then
    if ! stage=$(cat "$STAGE_FILE"); then stage=UNKNOWN; fi
  fi
  if [[ "$stage" != NONE ]]; then
    if rollback_application "$stage"; then
      emit_failure "$failure_status" ROLLED_BACK_REAL_FEISHU_SRT_FIX_DEPLOYMENT
    else
      failure_status=75
      emit_failure 75 ROLLBACK_FAILED
    fi
  else
    emit_failure "$failure_status" DEPLOYMENT_FAILED
  fi
  return "$failure_status"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi

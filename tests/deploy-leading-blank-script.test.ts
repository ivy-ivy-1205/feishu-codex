import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { migrateDatabase } from '../src/db/migrate.js';

const scriptPath = resolve('deploy/phase1e-leading-blank-deploy.sh');
const oldImage = 'sha256:726b5b763b02345dbb092b1651234a13f7ae1c503a81b630413f7d451fd9ebad';
const newImage = 'sha256:0279e8ee05749953ccbb9cea0a3dba321cb78c4fcb125e4d446d1f095155febc';
const oldCommit = 'b33b38fae00f41b5d6c817968c09d593d122fb02';
const newCommit = '8f08d0859de1650e098313e2b4bd56b5d89e4380';
const deploymentCaseTimeoutMs = 15_000;
const workspaces: string[] = [];

afterEach(() => {
  for (const workspace of workspaces.splice(0)) rmSync(workspace, { recursive: true, force: true });
});

describe('controlled leading-blank deployment script', () => {
  it('Case A: emits success once and never rolls back after every required step passes', () => {
    const harness = createHarness();
    const result = harness.run();

    expect(result.status, result.output).toBe(0);
    expect(occurrences(result.output, 'DEPLOYED_FLAGS_OFF')).toBe(1);
    expect(harness.rollbackCount()).toBe(0);
  }, deploymentCaseTimeoutMs);

  it('Case B: propagates a post-switch SQLite schema error and rolls back exactly once', () => {
    const harness = createHarness({ FAKE_BREAK_SCHEMA_AFTER_SWITCH: '1' });
    const result = harness.run();

    expect(result.status).toBe(1);
    expect(result.output, result.output).toContain('no such column: type');
    expect(result.output).not.toContain('DEPLOYED_FLAGS_OFF');
    expect(harness.rollbackCount()).toBe(1);
  }, deploymentCaseTimeoutMs);

  it('Case C: propagates a command-substitution failure to the outer script', () => {
    const harness = createHarness({ FAKE_COMMAND_SUBSTITUTION_FAIL: '1' });
    const result = harness.run();

    expect(result.status).toBe(43);
    expect(result.output).toContain('RESULT=DEPLOYMENT_FAILED');
    expect(result.output).toContain('forced sha failure');
    expect(result.output).not.toContain('DEPLOYED_FLAGS_OFF');
    expect(harness.rollbackCount()).toBe(0);
  }, deploymentCaseTimeoutMs);

  it('Case D: propagates an intermediate pipeline failure', () => {
    const harness = createHarness({ FAKE_PIPELINE_FAIL: '1' });
    const result = harness.run();

    expect(result.status).toBe(42);
    expect(result.output).toContain('RESULT=DEPLOYMENT_FAILED');
    expect(result.output).toContain('forced pipeline failure');
    expect(result.output).not.toContain('DEPLOYED_FLAGS_OFF');
    expect(harness.rollbackCount()).toBe(0);
  }, deploymentCaseTimeoutMs);

  it('Case E: rolls back once and never emits success when health verification fails', () => {
    const harness = createHarness({ FAKE_HEALTH_FAIL: '1' });
    const result = harness.run();

    expect(result.status).toBe(1);
    expect(result.output, result.output).toContain('ROLLED_BACK_REAL_FEISHU_SRT_FIX_DEPLOYMENT');
    expect(result.output).not.toContain('DEPLOYED_FLAGS_OFF');
    expect(harness.rollbackCount()).toBe(1);
  }, deploymentCaseTimeoutMs);

  it('Case F: reports rollback failure without recursion or a success status', () => {
    const harness = createHarness({ FAKE_HEALTH_FAIL: '1', FAKE_ROLLBACK_FAIL: '1' });
    const result = harness.run();

    expect(result.status).toBe(75);
    expect(result.output).toContain('ROLLBACK_FAILED');
    expect(result.output).not.toContain('DEPLOYED_FLAGS_OFF');
    expect(harness.rollbackCount()).toBe(1);
    expect(harness.composeCalls()).toEqual([
      `-f ${harness.appPath}/deploy/docker-compose.production.yml up -d --no-build --force-recreate bridge`,
      `-f ${harness.appPath}/deploy/docker-compose.production.yml down`
    ]);
  }, deploymentCaseTimeoutMs);

  it('Case H: preserves and restarts the old app when moving it to the checkpoint fails', () => {
    const restored = createHarness({}, { checkpointConflict: true });
    const restoredResult = restored.run();

    expect(restoredResult.status, restoredResult.output).toBe(1);
    expect(restoredResult.output).toContain('ROLLED_BACK_REAL_FEISHU_SRT_FIX_DEPLOYMENT');
    expect(restoredResult.output).not.toContain('DEPLOYED_FLAGS_OFF');
    expect(restored.rollbackCount()).toBe(1);
    expect(statSync(restored.appPath).isDirectory()).toBe(true);
    expect(existsSync(restored.failedAppPath)).toBe(false);
    expect(readFileSync(restored.checkpointPath, 'utf8')).toBe('checkpoint-conflict\n');
    expect(restored.composeCalls()).toEqual([
      `-f ${restored.appPath}/deploy/docker-compose.production.yml up -d --no-build bridge`
    ]);

    const restartFailed = createHarness(
      { FAKE_OLD_COMPOSE_UP_FAIL: '1' },
      { checkpointConflict: true }
    );
    const failedResult = restartFailed.run();

    expect(failedResult.status, failedResult.output).toBe(75);
    expect(failedResult.output).toContain('ROLLBACK_FAILED');
    expect(failedResult.output).not.toContain('DEPLOYED_FLAGS_OFF');
    expect(restartFailed.rollbackCount()).toBe(1);
    expect(statSync(restartFailed.appPath).isDirectory()).toBe(true);
    expect(existsSync(restartFailed.failedAppPath)).toBe(false);
    expect(readFileSync(restartFailed.checkpointPath, 'utf8')).toBe('checkpoint-conflict\n');
    expect(restartFailed.composeCalls()).toEqual([
      `-f ${restartFailed.appPath}/deploy/docker-compose.production.yml up -d --no-build bridge`
    ]);
  }, deploymentCaseTimeoutMs);

  it('Case I: fails closed without moving directories when APP_SWITCHING state is ambiguous', () => {
    const bothDirectories = createHarness();
    mkdirSync(bothDirectories.checkpointPath);
    const bothResult = bothDirectories.runRollback('APP_SWITCHING');

    expect(bothResult.status, bothResult.output).toBe(1);
    expect(bothResult.output).toContain('rollback directory state unsafe');
    expect(bothDirectories.rollbackCount()).toBe(0);
    expect(bothDirectories.composeCalls()).toEqual([]);
    expect(statSync(bothDirectories.appPath).isDirectory()).toBe(true);
    expect(statSync(bothDirectories.checkpointPath).isDirectory()).toBe(true);
    expect(existsSync(bothDirectories.failedAppPath)).toBe(false);

    const bothMissing = createHarness();
    rmSync(bothMissing.appPath, { recursive: true });
    const missingResult = bothMissing.runRollback('APP_SWITCHING');

    expect(missingResult.status, missingResult.output).toBe(1);
    expect(missingResult.output).toContain('rollback directory state unsafe');
    expect(bothMissing.rollbackCount()).toBe(0);
    expect(bothMissing.composeCalls()).toEqual([]);
    expect(existsSync(bothMissing.appPath)).toBe(false);
    expect(existsSync(bothMissing.checkpointPath)).toBe(false);
    expect(existsSync(bothMissing.failedAppPath)).toBe(false);
  }, deploymentCaseTimeoutMs);

  it('Case G: queries the real schema, distinguishes active/context jobs, and fails closed on SQL errors', () => {
    const workspace = makeWorkspace();
    const databasePath = join(workspace, 'jobs.sqlite');
    const database = new Database(databasePath);
    migrateDatabase(database);
    database.close();

    expect(runJobVerification(databasePath).status).toBe(0);

    const withJob = new Database(databasePath);
    withJob.prepare(`INSERT INTO batch_jobs
      (id, type, stable_key, payload, status, created_at, updated_at)
      VALUES ('context-1', 'extract_context_candidates', 'context-1', '{}', 'queued', '2026-08-09', '2026-08-09')`).run();
    withJob.close();
    const active = runJobVerification(databasePath);
    expect(active.status).toBe(1);
    expect(active.output).not.toContain('DEPLOYED_FLAGS_OFF');

    const invalidPath = join(workspace, 'invalid.sqlite');
    const invalid = new Database(invalidPath);
    invalid.exec(`CREATE TABLE batch_jobs (
      id TEXT PRIMARY KEY, stable_key TEXT NOT NULL, payload TEXT NOT NULL,
      status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`);
    invalid.close();
    const schemaError = runJobVerification(invalidPath);
    expect(schemaError.status).toBe(1);
    expect(schemaError.output).toContain('no such column: type');
  });
});

function createHarness(
  extraEnv: Record<string, string> = {},
  options: { checkpointConflict?: boolean } = {}
) {
  const workspace = makeWorkspace();
  const base = join(workspace, 'base');
  const fakeBin = join(workspace, 'bin');
  const state = join(workspace, 'state');
  const databasePath = join(base, 'data', 'bridge.sqlite');
  const appPath = join(base, 'app');
  const checkpointPath = join(base, `app.pre-leading-blank-${newCommit}-test`);
  const failedAppPath = join(base, `app.failed-leading-blank-${newCommit}-test`);
  for (const directory of [fakeBin, state, join(base, 'data'), join(base, 'logs'), join(base, 'secrets'),
    join(base, 'uploads'), join(base, 'backups'), join(base, 'releases'), join(base, 'app', 'deploy')]) {
    mkdirSync(directory, { recursive: true });
  }
  chmodSync(join(base, 'data'), 0o700);
  chmodSync(join(base, 'backups'), 0o700);
  writeFileSync(join(base, 'secrets', 'bridge.env'), [
    'CONTEXT_CANDIDATES_ENABLED=false',
    'CONTEXT_REVIEW_ENABLED=false',
    'PROJECT_CONTEXT_SYNC_ENABLED=false',
    ''
  ].join('\n'), { mode: 0o600 });
  writeFileSync(join(base, 'app', 'deploy', 'docker-compose.production.yml'), 'services: {}\n');
  if (options.checkpointConflict) writeFileSync(checkpointPath, 'checkpoint-conflict\n');
  createFixtureDatabase(databasePath);
  createReleaseArchive(workspace, join(base, 'uploads', 'phase1e-leading-blank-8f08d08.tar.xz'));
  createFakeCommands(fakeBin);
  writeFileSync(join(state, 'image'), `${oldImage}\n`);
  writeFileSync(join(state, 'revision'), `${oldCommit}\n`);
  writeFileSync(join(state, 'local_image'), `${oldImage}\n`);
  writeFileSync(join(state, 'local_revision'), `${oldCommit}\n`);
  writeFileSync(join(state, 'status'), 'running\n');
  writeFileSync(join(state, 'health'), 'healthy\n');
  writeFileSync(join(state, 'restart'), '0\n');

  const env = {
    ...process.env,
    PATH: `${fakeBin}:/usr/bin:/bin:/usr/sbin:/sbin`,
    DEPLOY_TEST_MODE: '1',
    BASE: base,
    DEPLOY_STAMP: 'test',
    EXPECTED_ARCHIVE_SHA: 'fixture-archive-sha',
    FAKE_ARCHIVE_SHA: 'fixture-archive-sha',
    FAKE_STATE_DIR: state,
    TEST_DB: databasePath,
    OLD_IMAGE: oldImage,
    NEW_COMMIT: newCommit,
    OLD_COMMIT: oldCommit,
    FAKE_NEW_IMAGE: newImage,
    ...extraEnv
  };
  return {
    run: () => runBash([scriptPath], env),
    runRollback: (stage: string) => runBash(
      ['-c', 'source "$1"; rollback_application "$2"', 'bash', scriptPath, stage],
      env
    ),
    rollbackCount: () => Number(readOptional(join(state, 'rollback_calls')) || '0'),
    composeCalls: () => readLines(join(state, 'compose_calls')),
    appPath,
    checkpointPath,
    failedAppPath
  };
}

function createFixtureDatabase(path: string): void {
  const database = new Database(path);
  database.exec(`
    CREATE TABLE batch_jobs (id TEXT PRIMARY KEY, type TEXT NOT NULL, stable_key TEXT NOT NULL,
      payload TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE feishu_events (id TEXT); CREATE TABLE meeting_minutes (id TEXT);
    CREATE TABLE meeting_summaries (id TEXT); CREATE TABLE meeting_todos (id TEXT);
    CREATE TABLE outbox (id TEXT);
    ${contextTableNames.map((name) => `CREATE TABLE ${name} (id TEXT);`).join('\n')}
    ${Array.from({ length: 6 }, (_, index) => `CREATE TABLE fixture_extra_${index} (id TEXT);`).join('\n')}
  `);
  const insertRows = (table: string, count: number) => {
    const statement = database.prepare(`INSERT INTO ${table} (id) VALUES (?)`);
    for (let index = 0; index < count; index += 1) statement.run(`${table}-${index}`);
  };
  insertRows('feishu_events', 12); insertRows('meeting_minutes', 8);
  insertRows('meeting_summaries', 5); insertRows('meeting_todos', 18); insertRows('outbox', 5);
  const insertJob = database.prepare(`INSERT INTO batch_jobs VALUES (?, ?, ?, '{}', ?, '2026-08-09', '2026-08-09')`);
  insertJob.run('minute:obcnam782s7dgo3i76enp9cn', 'process_minute', 'minute:obcnam782s7dgo3i76enp9cn', 'failed');
  insertJob.run('minute:obcnaqhi3341z2m449s27351', 'process_minute', 'minute:obcnaqhi3341z2m449s27351', 'failed');
  for (let index = 0; index < 6; index += 1) insertJob.run(`completed-${index}`, 'process_minute', `completed-${index}`, 'completed');
  database.close();
  chmodSync(path, 0o600);
}

function createReleaseArchive(workspace: string, archive: string): void {
  const release = join(workspace, 'release', 'app');
  mkdirSync(join(release, 'deploy'), { recursive: true });
  writeFileSync(join(release, 'Dockerfile'), 'FROM scratch\n');
  writeFileSync(join(release, 'deploy', 'docker-compose.production.yml'), 'services: {}\n');
  const result = spawnSync('tar', ['-cJf', archive, '-C', dirname(release), 'app'], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
}

function createFakeCommands(fakeBin: string): void {
  writeExecutable(fakeBin, 'docker', dockerFake);
  writeExecutable(fakeBin, 'stat', statFake);
  writeExecutable(fakeBin, 'sha256sum', sha256Fake);
  writeExecutable(fakeBin, 'curl', curlFake);
  writeExecutable(fakeBin, 'sleep', '#!/usr/bin/env bash\nexit 0\n');
}

function runJobVerification(databasePath: string) {
  return runBash(['-c', 'source "$1"; DB="$2"; verify_job_queue_empty', 'bash', scriptPath, databasePath], process.env);
}

function runBash(args: string[], env: NodeJS.ProcessEnv) {
  const result = spawnSync('/bin/bash', args, { encoding: 'utf8', env });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

function makeWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), 'leading-blank-deploy-test-'));
  workspaces.push(workspace);
  return workspace;
}

function writeExecutable(directory: string, name: string, content: string): void {
  const path = join(directory, name); writeFileSync(path, content); chmodSync(path, 0o700);
}

function readOptional(path: string): string {
  try { return readFileSync(path, 'utf8').trim(); } catch { return ''; }
}

function readLines(path: string): string[] {
  const value = readOptional(path);
  return value ? value.split('\n') : [];
}

function occurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

const contextTableNames = [
  'context_candidate_evidence', 'context_candidate_projects', 'context_candidate_record_relations',
  'context_candidates', 'context_evidence', 'context_extraction_run_sources', 'context_extraction_runs',
  'context_record_evidence', 'context_record_projects', 'context_record_relations',
  'context_record_versions', 'context_records', 'context_reviews', 'context_source_relations', 'context_sources'
];

const dockerFake = `#!/usr/bin/env bash
set -u
state=\${FAKE_STATE_DIR:?}
read_state() { cat "$state/$1"; }
write_state() { printf '%s\\n' "$2" > "$state/$1"; }
command=\${1:?}; shift
case "$command" in
  ps) printf 'feishu-codex-bridge\\n' ;;
  inspect)
    format=; while [[ \${1:-} == -* ]]; do [[ $1 == -f ]] && { format=$2; shift 2; } || shift; done
    case "$format" in
      *State.Status*) read_state status ;;
      *State.Health.Status*) read_state health ;;
      *RestartCount*) read_state restart ;;
      *'.Image'*) read_state image ;;
      *) exit 64 ;;
    esac ;;
  image)
    [[ \${1:-} == inspect ]] || exit 64; shift
    format=; [[ \${1:-} == -f ]] && { format=$2; shift 2; }; target=\${1:?}
    if [[ $target == *rollback-leading-blank* || $target == "$OLD_IMAGE" ]]; then image=$OLD_IMAGE; revision=$OLD_COMMIT;
    else image=$FAKE_NEW_IMAGE; revision=$NEW_COMMIT; fi
    [[ $format == *'.Id'* ]] && printf '%s\\n' "$image" || printf '%s\\n' "$revision" ;;
  exec)
    shift
    if [[ \${1:-} == sh ]]; then
      [[ \${FAKE_PIPELINE_FAIL:-0} == 1 ]] && { printf 'forced pipeline failure\\n' >&2; exit 42; }
      printf '1000\\n1000\\n'
    elif [[ \${1:-} == printenv ]]; then printf 'false\\n'; else exit 64; fi ;;
  stop) write_state status stopped ;;
  start) write_state status running; write_state health healthy; write_state image "$OLD_IMAGE"; write_state revision "$OLD_COMMIT" ;;
  build) : ;;
  tag)
    source=\${1:?}; target=\${2:?}
    if [[ $target == aijia/feishu-codex-bridge:local ]]; then
      if [[ $source == *rollback-leading-blank* ]]; then
        count=0; [[ -f $state/rollback_calls ]] && count=\$(read_state rollback_calls)
        write_state rollback_calls $((count + 1))
        [[ \${FAKE_ROLLBACK_FAIL:-0} == 1 ]] && exit 91
        write_state local_image "$OLD_IMAGE"; write_state local_revision "$OLD_COMMIT"
      else
        write_state local_image "$FAKE_NEW_IMAGE"; write_state local_revision "$NEW_COMMIT"
      fi
    fi ;;
  compose)
    printf '%s\\n' "$*" >> "$state/compose_calls"
    compose_file=; previous=; for argument in "$@"; do
      [[ $previous == -f ]] && compose_file=$argument
      previous=$argument
    done
    [[ -n $compose_file && -f $compose_file ]] || { printf 'compose file missing: %s\\n' "$compose_file" >&2; exit 93; }
    action=; for argument in "$@"; do [[ $argument == down || $argument == up ]] && action=$argument; done
    if [[ $action == down ]]; then write_state status stopped; exit 0; fi
    [[ $action == up ]] || exit 64
    image=\$(read_state local_image); revision=\$(read_state local_revision)
    [[ $image == "$OLD_IMAGE" && \${FAKE_OLD_COMPOSE_UP_FAIL:-0} == 1 ]] && exit 92
    write_state image "$image"; write_state revision "$revision"; write_state status running; write_state health healthy; write_state restart 0
    if [[ $image == "$FAKE_NEW_IMAGE" && \${FAKE_BREAK_SCHEMA_AFTER_SWITCH:-0} == 1 && ! -f $state/schema_broken ]]; then
      /usr/bin/sqlite3 "$TEST_DB" 'ALTER TABLE batch_jobs RENAME COLUMN type TO removed_type;'
      touch "$state/schema_broken"
    fi
    [[ $image == "$FAKE_NEW_IMAGE" && \${FAKE_HEALTH_FAIL:-0} == 1 ]] && write_state health unhealthy
    exit 0 ;;
  *) exit 64 ;;
esac
`;

const statFake = `#!/usr/bin/env bash
set -u
[[ \${1:-} == -c ]] || exit 64
format=$2; path=$3
case "$format" in
  %a) [[ $path == */data || $path == */backups ]] && printf '700\\n' || printf '600\\n' ;;
  %u:%g) printf '1000:1000\\n' ;;
  %s) /usr/bin/stat -f '%z' "$path" ;;
  *) exit 64 ;;
esac
`;

const sha256Fake = `#!/usr/bin/env bash
set -u
path=\${1:?}
if [[ \${FAKE_COMMAND_SUBSTITUTION_FAIL:-0} == 1 && $path == *phase1e-leading-blank-8f08d08.tar.xz ]]; then
  printf 'forced sha failure\\n' >&2; exit 43
fi
if [[ $path == *phase1e-leading-blank-8f08d08.tar.xz ]]; then hash=$FAKE_ARCHIVE_SHA;
else hash=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa; fi
printf '%s  %s\\n' "$hash" "$path"
`;

const curlFake = `#!/usr/bin/env bash
set -u
url=\${!#}
if [[ $url == */health && \${FAKE_HEALTH_FAIL:-0} == 1 ]]; then printf '500'; else
  case "$url" in */diag/context) printf '404' ;; *) printf '200' ;; esac
fi
`;

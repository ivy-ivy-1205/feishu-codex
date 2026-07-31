import type Database from 'better-sqlite3';
import {
  normalizeProcessMinuteJobPayload
} from '../repositories/job-repository.js';
import {
  initialProjectDefinitions,
  initialProjectMappingRules
} from '../services/project-registry-seed.js';

const migrationSql = `
  CREATE TABLE IF NOT EXISTS feishu_events (
    event_id TEXT PRIMARY KEY,
    minute_id TEXT NOT NULL,
    received_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS meeting_minutes (
    minute_id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL REFERENCES feishu_events(event_id),
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS meeting_summaries (
    id TEXT PRIMARY KEY,
    minute_id TEXT NOT NULL REFERENCES meeting_minutes(minute_id),
    summary_message_id TEXT NOT NULL UNIQUE,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE UNIQUE INDEX IF NOT EXISTS meeting_summaries_minute_id_unique
    ON meeting_summaries(minute_id);

  CREATE TABLE IF NOT EXISTS meeting_todos (
    id TEXT PRIMARY KEY,
    summary_id TEXT NOT NULL REFERENCES meeting_summaries(id),
    displayed_number INTEGER NOT NULL CONSTRAINT meeting_todos_displayed_number_positive CHECK(displayed_number > 0),
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    risk TEXT NOT NULL CONSTRAINT meeting_todos_risk_allowed CHECK(risk IN ('low', 'high')),
    capability TEXT NOT NULL DEFAULT 'unknown' CONSTRAINT meeting_todos_capability_allowed CHECK(capability IN ('unknown', 'content_draft', 'code_write', 'external_message', 'deploy', 'delete', 'production_access')),
    status TEXT NOT NULL DEFAULT 'proposed' CONSTRAINT meeting_todos_status_allowed CHECK(status IN ('proposed', 'authorized', 'running', 'completed', 'failed', 'needs_confirmation')),
    created_at TEXT NOT NULL,
    UNIQUE(summary_id, displayed_number)
  );

  CREATE TABLE IF NOT EXISTS batch_jobs (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    stable_key TEXT NOT NULL,
    payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE UNIQUE INDEX IF NOT EXISTS batch_jobs_stable_key_unique
    ON batch_jobs(stable_key);

  CREATE TABLE IF NOT EXISTS outbox (
    id TEXT PRIMARY KEY,
    destination TEXT NOT NULL,
    payload TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL,
    delivered_at TEXT
  );

  CREATE TABLE IF NOT EXISTS approval_actions (
    id TEXT PRIMARY KEY,
    todo_id TEXT NOT NULL REFERENCES meeting_todos(id),
    approver_open_id TEXT NOT NULL,
    action TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS projects (
    project_key TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    aliases TEXT NOT NULL,
    local_path_hint TEXT,
    repo_url TEXT,
    default_branch TEXT,
    status TEXT NOT NULL CONSTRAINT projects_status_allowed CHECK(status IN ('active', 'archived')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS project_mapping_rules (
    id TEXT PRIMARY KEY,
    pattern TEXT NOT NULL,
    pattern_kind TEXT NOT NULL CONSTRAINT project_mapping_rules_pattern_kind_allowed CHECK(pattern_kind IN ('keyword', 'exact', 'regex')),
    project_key TEXT NOT NULL REFERENCES projects(project_key),
    subproject_key TEXT,
    confidence_hint TEXT NOT NULL CONSTRAINT project_mapping_rules_confidence_allowed CHECK(confidence_hint IN ('high', 'medium', 'low')),
    priority INTEGER NOT NULL,
    source TEXT NOT NULL CONSTRAINT project_mapping_rules_source_allowed CHECK(source IN ('system', 'ivy_correction')),
    active INTEGER NOT NULL CONSTRAINT project_mapping_rules_active_allowed CHECK(active IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS project_context_snapshots (
    id TEXT PRIMARY KEY,
    project_key TEXT REFERENCES projects(project_key),
    source_kind TEXT NOT NULL,
    source_ref TEXT NOT NULL,
    content TEXT NOT NULL,
    digest TEXT NOT NULL,
    captured_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS project_mapping_conflicts (
    id TEXT PRIMARY KEY,
    todo_id TEXT REFERENCES meeting_todos(id),
    candidate_project_key TEXT,
    existing_project_key TEXT,
    evidence TEXT NOT NULL,
    status TEXT NOT NULL CONSTRAINT project_mapping_conflicts_status_allowed CHECK(status IN ('open', 'resolved')),
    created_at TEXT NOT NULL,
    resolved_at TEXT
  );

  CREATE TABLE IF NOT EXISTS feishu_user_oauth_tokens (
    open_id TEXT PRIMARY KEY,
    user_access_token_ciphertext TEXT NOT NULL,
    refresh_token_ciphertext TEXT NOT NULL,
    access_token_expires_at TEXT NOT NULL,
    refresh_token_expires_at TEXT NOT NULL,
    authorization_status TEXT NOT NULL
      CONSTRAINT feishu_user_oauth_tokens_authorization_status_allowed
      CHECK(authorization_status IN ('valid', 'invalid')),
    subscription_status TEXT NOT NULL,
    last_event_at TEXT,
    updated_at TEXT NOT NULL
  );
`;

export function migrateDatabase(client: Database.Database): void {
  migrateLegacyBatchJobs(client);
  client.exec(migrationSql);
  migrateProcessMinuteRetryPayloads(client);
  migrateOutboxDeliveryColumn(client);
  migrateTodoCapabilityColumn(client);
  migrateTodoProjectColumns(client);
  seedProjectRegistry(client);
}

function migrateProcessMinuteRetryPayloads(client: Database.Database): void {
  const rows = client.prepare(`
    SELECT stable_key, payload, status
    FROM batch_jobs
    WHERE type = 'process_minute'
  `).all() as Array<{ stable_key: string; payload: string; status: string }>;
  const update = client.prepare(`
    UPDATE batch_jobs SET status = ?, payload = ? WHERE stable_key = ?
  `);

  client.transaction(() => {
    for (const row of rows) {
      const normalized = normalizeProcessMinuteJobPayload(row.payload);
      if (!normalized) {
        update.run(
          'failed',
          JSON.stringify({ failureReason: 'JOB_PAYLOAD_INVALID' }),
          row.stable_key
        );
        continue;
      }
      update.run(row.status, JSON.stringify(normalized), row.stable_key);
    }
  })();
}

function migrateTodoCapabilityColumn(client: Database.Database): void {
  const columns = client.prepare('PRAGMA table_info(meeting_todos)').all() as TableColumn[];
  if (columns.some((column) => column.name === 'capability')) {
    return;
  }
  client.exec(`
    ALTER TABLE meeting_todos
    ADD COLUMN capability TEXT NOT NULL DEFAULT 'unknown'
      CONSTRAINT meeting_todos_capability_allowed
      CHECK(capability IN ('unknown', 'content_draft', 'code_write', 'external_message', 'deploy', 'delete', 'production_access'))
  `);
}

function migrateTodoProjectColumns(client: Database.Database): void {
  const columns = client.prepare('PRAGMA table_info(meeting_todos)').all() as TableColumn[];
  const additions = [
    ['project_key', 'TEXT DEFAULT NULL'],
    ['subproject_key', 'TEXT DEFAULT NULL'],
    ['project_confidence', "TEXT NOT NULL DEFAULT 'low'"],
    ['project_evidence', "TEXT NOT NULL DEFAULT ''"],
    ['project_mapping_status', "TEXT NOT NULL DEFAULT 'unmapped'"],
    ['project_prompt', "TEXT NOT NULL DEFAULT ''"]
  ] as const;

  for (const [name, definition] of additions) {
    if (!columns.some((column) => column.name === name)) {
      client.exec(`ALTER TABLE meeting_todos ADD COLUMN ${name} ${definition}`);
    }
  }
}

function seedProjectRegistry(client: Database.Database): void {
  const now = new Date().toISOString();
  const insertProject = client.prepare(`
    INSERT INTO projects (
      project_key, display_name, aliases, local_path_hint, repo_url, default_branch, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(project_key) DO UPDATE SET
      display_name = excluded.display_name,
      aliases = excluded.aliases,
      local_path_hint = excluded.local_path_hint,
      repo_url = excluded.repo_url,
      default_branch = excluded.default_branch,
      status = excluded.status,
      updated_at = excluded.updated_at
  `);
  const insertRule = client.prepare(`
    INSERT INTO project_mapping_rules (
      id, pattern, pattern_kind, project_key, subproject_key, confidence_hint, priority, source, active, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      pattern = excluded.pattern,
      pattern_kind = excluded.pattern_kind,
      project_key = excluded.project_key,
      subproject_key = excluded.subproject_key,
      confidence_hint = excluded.confidence_hint,
      priority = excluded.priority,
      source = excluded.source,
      active = excluded.active,
      updated_at = excluded.updated_at
  `);

  client.transaction(() => {
    for (const project of initialProjectDefinitions) {
      insertProject.run(project.projectKey, project.displayName, JSON.stringify(project.aliases), project.localPathHint, project.repoUrl, project.defaultBranch, project.status, now, now);
    }
    for (const rule of initialProjectMappingRules) {
      insertRule.run(rule.id, rule.pattern, rule.patternKind, rule.projectKey, rule.subprojectKey, rule.confidenceHint, rule.priority, rule.source, Number(rule.active), now, now);
    }
  })();
}

function migrateOutboxDeliveryColumn(client: Database.Database): void {
  const columns = client.prepare('PRAGMA table_info(outbox)').all() as TableColumn[];
  if (columns.some((column) => column.name === 'delivered_at')) {
    return;
  }
  client.exec('ALTER TABLE outbox ADD COLUMN delivered_at TEXT');
}

function migrateLegacyBatchJobs(client: Database.Database): void {
  const table = client.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name = 'batch_jobs'
  `).get();
  if (!table) {
    return;
  }

  const columns = client.prepare('PRAGMA table_info(batch_jobs)').all() as TableColumn[];
  if (columns.some((column) => column.name === 'stable_key')) {
    return;
  }

  client.transaction(() => {
    client.exec(`
      ALTER TABLE batch_jobs RENAME TO batch_jobs_legacy;

      CREATE TABLE batch_jobs (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        stable_key TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      INSERT INTO batch_jobs (
        id, type, stable_key, payload, status, created_at, updated_at
      )
      SELECT id, type, 'legacy:' || id, payload, status, created_at, updated_at
      FROM batch_jobs_legacy;

      DROP TABLE batch_jobs_legacy;
    `);
  })();
}

interface TableColumn {
  name: string;
}

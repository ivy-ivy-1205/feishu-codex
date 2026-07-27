import type Database from 'better-sqlite3';
import {
  normalizeProcessMinuteJobPayload
} from '../repositories/job-repository.js';

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

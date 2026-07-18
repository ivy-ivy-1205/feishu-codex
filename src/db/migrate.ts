import type Database from 'better-sqlite3';

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
`;

export function migrateDatabase(client: Database.Database): void {
  migrateLegacyBatchJobs(client);
  client.exec(migrationSql);
  migrateOutboxDeliveryColumn(client);
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

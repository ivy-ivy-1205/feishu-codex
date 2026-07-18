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

  CREATE TABLE IF NOT EXISTS meeting_todos (
    id TEXT PRIMARY KEY,
    summary_id TEXT NOT NULL REFERENCES meeting_summaries(id),
    displayed_number INTEGER NOT NULL CHECK(displayed_number > 0),
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    risk TEXT NOT NULL CHECK(risk IN ('low', 'high')),
    status TEXT NOT NULL DEFAULT 'proposed' CHECK(status IN ('proposed', 'authorized', 'running', 'completed', 'failed', 'needs_confirmation')),
    created_at TEXT NOT NULL,
    UNIQUE(summary_id, displayed_number)
  );

  CREATE TABLE IF NOT EXISTS batch_jobs (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS outbox (
    id TEXT PRIMARY KEY,
    destination TEXT NOT NULL,
    payload TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL
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
  client.exec(migrationSql);
}

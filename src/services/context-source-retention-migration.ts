import type Database from 'better-sqlite3';

interface TableColumn {
  cid: number;
  name: string;
  type: string;
  notnull: 0 | 1;
  dflt_value: string | null;
  pk: 0 | 1;
}

export interface RetentionColumnState {
  rawTextExpiresAt: boolean;
  contentState: boolean;
  redactedAt: boolean;
}

export interface ContextSourceRetentionMigrationResult {
  migrationApplied: boolean;
  before: RetentionColumnState;
  after: RetentionColumnState;
}

interface MigrationOptions {
  executeStatement?: (sql: string, index: number) => void;
}

const baseColumns: ReadonlyArray<Omit<TableColumn, 'cid'>> = [
  { name: 'id', type: 'TEXT', notnull: 0, dflt_value: null, pk: 1 },
  { name: 'source_system', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
  { name: 'source_type', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
  { name: 'external_id', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
  { name: 'logical_key', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
  { name: 'source_version', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 0 },
  { name: 'occurred_at', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
  { name: 'authors_json', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
  { name: 'locator_uri', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
  { name: 'content_format', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
  { name: 'content_text', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
  { name: 'metadata_json', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
  { name: 'content_hash', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
  { name: 'availability_status', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
  { name: 'captured_at', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 }
];

const retentionColumns: ReadonlyArray<Omit<TableColumn, 'cid'>> = [
  { name: 'raw_text_expires_at', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
  { name: 'content_state', type: 'TEXT', notnull: 1, dflt_value: "'cleartext'", pk: 0 },
  { name: 'redacted_at', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 }
];

const additions = [
  'ALTER TABLE context_sources ADD COLUMN raw_text_expires_at TEXT',
  "ALTER TABLE context_sources ADD COLUMN content_state TEXT NOT NULL DEFAULT 'cleartext' CHECK(content_state IN ('cleartext', 'redacted'))",
  'ALTER TABLE context_sources ADD COLUMN redacted_at TEXT'
] as const;

function readColumns(client: Database.Database): TableColumn[] {
  return client.prepare('PRAGMA table_info(context_sources)').all() as TableColumn[];
}

function retentionState(columns: TableColumn[]): RetentionColumnState {
  const names = new Set(columns.map((column) => column.name));
  return {
    rawTextExpiresAt: names.has('raw_text_expires_at'),
    contentState: names.has('content_state'),
    redactedAt: names.has('redacted_at')
  };
}

function matchesColumns(actual: TableColumn[], expected: ReadonlyArray<Omit<TableColumn, 'cid'>>): boolean {
  return actual.length === expected.length && actual.every((column, index) => {
    const wanted = expected[index];
    return wanted !== undefined && column.cid === index && column.name === wanted.name &&
      column.type.toUpperCase() === wanted.type && column.notnull === wanted.notnull &&
      column.dflt_value === wanted.dflt_value && column.pk === wanted.pk;
  });
}

function hasExpectedBaseConstraints(client: Database.Database): boolean {
  const row = client.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'context_sources'`)
    .get() as { sql: string | null } | undefined;
  const sql = row?.sql?.toLowerCase().replace(/\s+/gu, ' ') ?? '';
  return sql.includes('check(source_version > 0)') &&
    sql.includes("check(availability_status in ('available', 'deleted', 'permission_lost', 'unknown'))") &&
    sql.includes('unique(logical_key, content_hash)') &&
    sql.includes('unique(logical_key, source_version)');
}

function assertExpectedSchema(client: Database.Database, columns: TableColumn[]): void {
  const state = retentionState(columns);
  const presentCount = Object.values(state).filter(Boolean).length;
  if (presentCount > 0 && presentCount < retentionColumns.length) {
    throw new Error('CONTEXT_SOURCE_RETENTION_MIGRATION_PARTIAL');
  }
  const expected = presentCount === retentionColumns.length ? [...baseColumns, ...retentionColumns] : baseColumns;
  if (!matchesColumns(columns, expected) || !hasExpectedBaseConstraints(client)) {
    throw new Error('CONTEXT_SOURCE_RETENTION_BASE_SCHEMA_INVALID');
  }
  if (presentCount === retentionColumns.length) {
    const row = client.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'context_sources'`)
      .get() as { sql: string | null } | undefined;
    const sql = row?.sql?.toLowerCase().replace(/\s+/gu, ' ') ?? '';
    if (!sql.includes("check(content_state in ('cleartext', 'redacted'))")) {
      throw new Error('CONTEXT_SOURCE_RETENTION_BASE_SCHEMA_INVALID');
    }
  }
}

export function applyContextSourceRetentionMigration(
  client: Database.Database,
  options: MigrationOptions = {}
): ContextSourceRetentionMigrationResult {
  const beforeColumns = readColumns(client);
  assertExpectedSchema(client, beforeColumns);
  const before = retentionState(beforeColumns);
  if (Object.values(before).every(Boolean)) {
    return { migrationApplied: false, before, after: before };
  }

  const executeStatement = options.executeStatement ?? ((sql: string) => client.exec(sql));
  const migrate = client.transaction(() => {
    additions.forEach((sql, index) => executeStatement(sql, index));
    const afterColumns = readColumns(client);
    assertExpectedSchema(client, afterColumns);
    return afterColumns;
  });
  const afterColumns = migrate.immediate();
  return { migrationApplied: true, before, after: retentionState(afterColumns) };
}

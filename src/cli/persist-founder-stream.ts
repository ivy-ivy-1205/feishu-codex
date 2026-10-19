import { pathToFileURL } from 'node:url';
import type Database from 'better-sqlite3';
import { createFeishuSdkClient, FeishuSdkContextClient } from '../adapters/feishu-sdk.js';
import { createSqliteDatabase } from '../db/client.js';
import { ContextSourceRepository } from '../repositories/context-source-repository.js';
import { JobRepository } from '../repositories/job-repository.js';
import { parseBackfillArguments, runBackfillCli } from './backfill-founder-stream.js';
import { resolveMigrationDatabasePath } from './migrate-context-source-retention.js';

const requiredColumns = {
  context_sources: [
    'id', 'source_system', 'source_type', 'external_id', 'logical_key', 'source_version',
    'occurred_at', 'authors_json', 'locator_uri', 'content_format', 'content_text',
    'metadata_json', 'content_hash', 'availability_status', 'captured_at',
    'raw_text_expires_at', 'content_state', 'redacted_at'
  ],
  batch_jobs: ['id', 'type', 'stable_key', 'payload', 'status', 'created_at', 'updated_at']
} as const;

export function assertFounderStreamPersistSchema(client: Database.Database): void {
  for (const [table, expected] of Object.entries(requiredColumns)) {
    const columns = (client.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string; notnull: number; dflt_value: string | null;
    }>);
    if (columns.map((column) => column.name).join('\0') !== expected.join('\0')) {
      throw new Error('FOUNDER_STREAM_PERSIST_SCHEMA_INVALID');
    }
    if (table === 'context_sources') {
      const state = columns.find((column) => column.name === 'content_state');
      if (state?.notnull !== 1 || state.dflt_value !== "'cleartext'") {
        throw new Error('FOUNDER_STREAM_PERSIST_SCHEMA_INVALID');
      }
    }
  }
  const stableKeyIndex = client.prepare(`
    SELECT 1 FROM sqlite_master
    WHERE type = 'index' AND name = 'batch_jobs_stable_key_unique'
  `).get();
  if (!stableKeyIndex) throw new Error('FOUNDER_STREAM_PERSIST_SCHEMA_INVALID');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const options = parseBackfillArguments(args);
  if (options.dryRun) throw new Error('Persist mode required');
  const appId = process.env.FEISHU_APP_ID?.trim();
  const appSecret = process.env.FEISHU_APP_SECRET?.trim();
  if (!appId || !appSecret) throw new Error('Feishu app configuration required');
  const databasePath = resolveMigrationDatabasePath(process.env.DATABASE_URL);
  const database = createSqliteDatabase(databasePath);
  try {
    assertFounderStreamPersistSchema(database.client);
    await runBackfillCli(args, {
      now: new Date(),
      feishu: new FeishuSdkContextClient(createFeishuSdkClient({ appId, appSecret })),
      sourceRepository: new ContextSourceRepository(database.client),
      jobRepository: new JobRepository(database.client),
      write: (line) => process.stdout.write(`${line}\n`)
    });
  } finally {
    database.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(() => {
    process.stderr.write('Founder stream persist failed. No message content logged.\n');
    process.exitCode = 1;
  });
}

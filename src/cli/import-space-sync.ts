import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import type Database from 'better-sqlite3';
import { createSqliteDatabase } from '../db/client.js';
import { spaceSyncEnvelopeV1Schema } from '../domain/space-sync.js';
import { ContextSourceRepository } from '../repositories/context-source-repository.js';
import { SpaceSyncRepository } from '../repositories/space-sync-repository.js';
import { ingestSpaceSyncEnvelope } from '../services/space-sync-ingestion.js';

export interface ImportSpaceSyncCliOptions {
  envelopePath: string;
  maxBlocks: number;
  maxComments: number;
}

export interface ImportSpaceSyncCliDependencies {
  readFile: (path: string) => string;
  client: Database.Database;
  spaceSyncRepository: SpaceSyncRepository;
  contextSourceRepository: ContextSourceRepository;
  now: () => Date;
  write: (line: string) => void;
}

/**
 * This is the only sanctioned entry point for manual Space-sync compensation (T3):
 * it parses the same SpaceSyncEnvelopeV1 contract and calls the same transactional
 * ingestion service as the HTTP route, so a manual run gets the same idempotency and
 * audit trail as a real producer call. It never writes to the database directly.
 */
export function parseImportSpaceSyncArguments(args: string[]): ImportSpaceSyncCliOptions {
  const { values } = parseArgs({
    args: args[0] === '--' ? args.slice(1) : args,
    strict: true,
    options: {
      envelope: { type: 'string' },
      'max-blocks': { type: 'string' },
      'max-comments': { type: 'string' }
    }
  });
  const envelopePath = values.envelope?.trim();
  const maxBlocks = Number(values['max-blocks'] ?? '500');
  const maxComments = Number(values['max-comments'] ?? '2000');
  if (!envelopePath || !Number.isInteger(maxBlocks) || maxBlocks <= 0 ||
    !Number.isInteger(maxComments) || maxComments <= 0) {
    throw new Error('SPACE_SYNC_IMPORT_ARGUMENTS_INVALID');
  }
  return { envelopePath, maxBlocks, maxComments };
}

export function runImportSpaceSyncCli(args: string[], dependencies: ImportSpaceSyncCliDependencies): void {
  const options = parseImportSpaceSyncArguments(args);
  const parsedJson = JSON.parse(dependencies.readFile(options.envelopePath)) as unknown;
  const envelope = spaceSyncEnvelopeV1Schema.parse(parsedJson);
  const result = ingestSpaceSyncEnvelope(envelope, {
    client: dependencies.client,
    spaceSyncRepository: dependencies.spaceSyncRepository,
    contextSourceRepository: dependencies.contextSourceRepository,
    limits: { maxBlocks: options.maxBlocks, maxComments: options.maxComments },
    now: dependencies.now
  });
  dependencies.write(JSON.stringify({
    syncId: result.syncId,
    replay: result.replay,
    pageSourceCreated: result.run.pageSourceCreated,
    commentSourcesCreated: result.run.commentSourcesCreated,
    coveragePageComplete: result.run.coveragePageComplete,
    coverageCommentsComplete: result.run.coverageCommentsComplete,
    gapCount: result.run.gapCount
  }));
}

function main(): void {
  const databasePath = process.env.DATABASE_URL?.trim();
  if (!databasePath || /^postgres(?:ql)?:/u.test(databasePath)) {
    throw new Error('SQLite database path required');
  }
  const database = createSqliteDatabase(databasePath);
  try {
    runImportSpaceSyncCli(process.argv.slice(2), {
      readFile: (path) => readFileSync(path, 'utf8'),
      client: database.client,
      spaceSyncRepository: new SpaceSyncRepository(database.client),
      contextSourceRepository: new ContextSourceRepository(database.client),
      now: () => new Date(),
      write: (line) => process.stdout.write(`${line}\n`)
    });
  } finally {
    database.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch {
    process.stderr.write('Space sync import failed. No source content logged.\n');
    process.exitCode = 1;
  }
}

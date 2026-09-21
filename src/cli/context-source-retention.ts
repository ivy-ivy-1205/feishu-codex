import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createSqliteDatabase } from '../db/client.js';
import { ContextSourceRepository } from '../repositories/context-source-repository.js';

interface RetentionCliOptions {
  mode: 'preview' | 'execute';
  asOf: Date;
  sourceIds: string[];
}

interface RetentionCliDependencies {
  repository: ContextSourceRepository;
  now: () => Date;
  write: (line: string) => void;
}

export function parseContextSourceRetentionArguments(args: string[]): RetentionCliOptions {
  const { values } = parseArgs({
    args: args[0] === '--' ? args.slice(1) : args,
    strict: true,
    options: {
      preview: { type: 'boolean' },
      execute: { type: 'boolean' },
      'as-of': { type: 'string' },
      'source-id': { type: 'string', multiple: true }
    }
  });
  const sourceIds = (values['source-id'] ?? []).map((id) => id.trim()).filter(Boolean);
  const asOf = new Date(values['as-of'] ?? '');
  if (Boolean(values.preview) === Boolean(values.execute) || !Number.isFinite(asOf.getTime()) ||
    sourceIds.length === 0 || new Set(sourceIds).size !== sourceIds.length) {
    throw new Error('CONTEXT_SOURCE_RETENTION_ARGUMENTS_INVALID');
  }
  return { mode: values.preview ? 'preview' : 'execute', asOf, sourceIds };
}

export function runContextSourceRetentionCli(args: string[], dependencies: RetentionCliDependencies): void {
  const options = parseContextSourceRetentionArguments(args);
  if (options.mode === 'preview') {
    const sources = dependencies.repository.previewExpiredRawText({
      sourceIds: options.sourceIds,
      asOf: options.asOf
    });
    if (sources.length !== options.sourceIds.length) {
      throw new Error('CONTEXT_SOURCE_RETENTION_PREVIEW_MISMATCH');
    }
    dependencies.write(JSON.stringify({
      mode: 'preview', requested: options.sourceIds.length, eligible: sources.length, sources
    }));
    return;
  }
  const result = dependencies.repository.redactExpiredRawText({
    sourceIds: options.sourceIds,
    asOf: options.asOf,
    redactedAt: dependencies.now()
  });
  dependencies.write(JSON.stringify({
    mode: 'execute', requested: options.sourceIds.length, redacted: result.redactedSourceIds.length
  }));
}

function main(): void {
  const databasePath = process.env.DATABASE_URL?.trim();
  if (!databasePath || /^postgres(?:ql)?:/u.test(databasePath)) {
    throw new Error('SQLite database path required');
  }
  const database = createSqliteDatabase(databasePath);
  try {
    runContextSourceRetentionCli(process.argv.slice(2), {
      repository: new ContextSourceRepository(database.client),
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
    process.stderr.write('Context source retention failed. No source content logged.\n');
    process.exitCode = 1;
  }
}

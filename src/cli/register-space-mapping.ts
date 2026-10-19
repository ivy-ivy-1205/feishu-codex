import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import type Database from 'better-sqlite3';
import { createSqliteDatabase } from '../db/client.js';
import { applySpaceMapping, previewSpaceMapping, SpaceMappingRejectedError } from '../services/space-mapping-registration.js';

export interface RegisterSpaceMappingDependencies {
  readFile: (path: string) => string;
  client: Database.Database;
  now: () => Date;
  write: (line: string) => void;
}

/**
 * Human registration of Space page → project → work-map topic, and Space account → founder.
 * Preview is the default and writes nothing; --apply needs a change-sheet reference.
 */
export function runRegisterSpaceMappingCli(args: string[], dependencies: RegisterSpaceMappingDependencies): number {
  const { values } = parseArgs({ args: args[0] === '--' ? args.slice(1) : args, strict: true,
    options: { plan: { type: 'string' }, apply: { type: 'boolean' }, 'change-ref': { type: 'string' } } });
  const planPath = values.plan?.trim();
  if (!planPath) throw new Error('SPACE_MAPPING_ARGUMENTS_INVALID');
  const plan = JSON.parse(dependencies.readFile(planPath)) as unknown;
  if (!values.apply) {
    const preview = previewSpaceMapping(dependencies.client, plan);
    dependencies.write(JSON.stringify({ mode: 'preview', ...preview }, null, 2));
    return preview.ok ? 0 : 2;
  }
  try {
    const preview = applySpaceMapping(dependencies.client, plan, { changeReference: values['change-ref'] ?? '', at: dependencies.now() });
    dependencies.write(JSON.stringify({ mode: 'applied', ...preview }, null, 2));
    return 0;
  } catch (error) {
    if (!(error instanceof SpaceMappingRejectedError)) throw error;
    dependencies.write(JSON.stringify({ mode: 'rejected', ...error.preview }, null, 2));
    return 2;
  }
}

function main(): void {
  const databasePath = process.env.DATABASE_URL?.trim();
  if (!databasePath || /^postgres(?:ql)?:/u.test(databasePath)) throw new Error('SQLite database path required');
  const database = createSqliteDatabase(databasePath);
  try {
    process.exitCode = runRegisterSpaceMappingCli(process.argv.slice(2), { readFile: (path) => readFileSync(path, 'utf8'),
      client: database.client, now: () => new Date(), write: (line) => process.stdout.write(`${line}\n`) });
  } finally {
    database.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (error) {
    process.stderr.write(`Space mapping registration failed: ${error instanceof Error ? error.message.slice(0, 200) : 'unknown'}\n`);
    process.exitCode = 1;
  }
}

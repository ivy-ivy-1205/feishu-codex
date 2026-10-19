import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createFeishuSdkClient, FeishuSdkContextClient } from '../adapters/feishu-sdk.js';
import { createSqliteDatabase } from '../db/client.js';
import { migrateDatabase } from '../db/migrate.js';
import { ContextSourceRepository } from '../repositories/context-source-repository.js';
import { JobRepository } from '../repositories/job-repository.js';
import { runFounderStreamBackfill, validateFounderStreamWindow,
  type FounderStreamBackfillInput } from '../services/founder-stream-backfill.js';

export function parseBackfillArguments(args: string[]): { chatId: string; since: string; until?: string; dryRun: boolean;enqueueAnalysis:boolean } {
  const { values } = parseArgs({ args: args[0] === '--' ? args.slice(1) : args, strict: true,
    options: { 'chat-id': { type: 'string' }, since: { type: 'string' }, until: { type: 'string' }, 'dry-run': { type: 'boolean' },
      persist: { type: 'boolean' },'persist-sources-only':{type:'boolean'} } });
  const modes=[values['dry-run'],values.persist,values['persist-sources-only']].filter(Boolean).length;
  if (!values['chat-id'] || !values.since || modes!==1) {
    throw new Error('require --chat-id <approved-id> --since <ISO> and exactly one explicit mode');
  }
  if (values.until !== undefined) {
    validateFounderStreamWindow(values['chat-id'], values.until, new Date(values.until));
    validateFounderStreamWindow(values['chat-id'], values.since, new Date(values.until));
    if (Date.parse(values.until) <= Date.parse(values.since)) throw new Error('FOUNDER_STREAM_RANGE_INVALID');
  }
  return { chatId: values['chat-id'], since: values.since, ...(values.until === undefined ? {} : { until: values.until }),
    dryRun: values['dry-run'] === true,enqueueAnalysis:values.persist===true };
}

type CliDependencies = Omit<FounderStreamBackfillInput, 'chatId' | 'since' | 'dryRun'> & { write: (line: string) => void };

export async function runBackfillCli(args: string[], dependencies: CliDependencies): Promise<void> {
  const options = parseBackfillArguments(args);
  const report = await runFounderStreamBackfill({ ...dependencies, ...options });
  const gapsByCode: Record<string, number> = {};
  const readFailuresByCategory: Record<string, number> = {};
  const feishuErrorCodes: Record<string, number> = {};
  const httpStatuses: Record<string, number> = {};
  for (const gap of report.gaps) {
    gapsByCode[gap.code] = (gapsByCode[gap.code] ?? 0) + 1;
    if (!gap.diagnostic) continue;
    readFailuresByCategory[gap.diagnostic.category] = (readFailuresByCategory[gap.diagnostic.category] ?? 0) + 1;
    if (gap.diagnostic.feishuCode !== null) {
      const code = String(gap.diagnostic.feishuCode);
      feishuErrorCodes[code] = (feishuErrorCodes[code] ?? 0) + 1;
    }
    if (gap.diagnostic.httpStatus !== null) {
      const status = String(gap.diagnostic.httpStatus);
      httpStatuses[status] = (httpStatuses[status] ?? 0) + 1;
    }
  }
  // Explicit whitelist: never serialize raw report, messages, IDs, cursors, errors or sources.
  dependencies.write(JSON.stringify({ dryRun: report.dryRun,enqueueAnalysis:options.enqueueAnalysis,requestedRange: report.requestedRange,
    coverageStatus: report.coverageStatus, coverage: report.coverage,
    messagesRead: report.messagesRead, sourcesCaptured: report.sourcesCaptured,
    sourcesCreated: report.sourcesCreated, jobsEnqueued: report.jobsEnqueued,
    filesRead: report.filesRead, filesUnreadable: report.filesUnreadable,
    mediaSkipped: report.mediaSkipped, voiceTextMissing: report.voiceTextMissing, gapsByCode,
    readFailuresByCategory, feishuErrorCodes, httpStatuses }));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const options = parseBackfillArguments(args);
  const now = new Date();
  validateFounderStreamWindow(options.chatId, options.since, now);
  if (options.until) validateFounderStreamWindow(options.chatId, options.until, now);
  const appId = process.env.FEISHU_APP_ID?.trim();
  const appSecret = process.env.FEISHU_APP_SECRET?.trim();
  if (!appId || !appSecret) throw new Error('Feishu app configuration required');
  const databasePath = process.env.DATABASE_URL?.trim();
  if (!options.dryRun && (!databasePath || /^postgres(?:ql)?:/u.test(databasePath))) throw new Error('SQLite database path required for persist');
  // Dry-run never opens or migrates a database and never starts a worker.
  const database = options.dryRun ? undefined : createSqliteDatabase(databasePath!);
  try {
    if (database) migrateDatabase(database.client);
    await runBackfillCli(args, { now,
      feishu: new FeishuSdkContextClient(createFeishuSdkClient({ appId, appSecret })),
      ...(database ? { sourceRepository: new ContextSourceRepository(database.client), jobRepository: new JobRepository(database.client) } : {}),
      write: (line) => process.stdout.write(`${line}\n`) });
  } finally { database?.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(() => {
    process.stderr.write('Founder stream backfill failed. Check explicit chat, ISO range, mode and runtime configuration. No message content logged.\n');
    process.exitCode = 1;
  });
}

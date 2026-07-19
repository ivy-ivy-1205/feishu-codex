import { buildApp } from './app.js';
import { CodexAuthProbe, NodeCodexProcessRunner } from './adapters/codex-cli.js';
import { createFeishuIntegration } from './composition/feishu.js';
import { createMeetingSummarizer } from './composition/meeting-summarizer.js';
import { createWorkerRuntime } from './composition/worker-runtime.js';
import { loadConfig } from './config.js';
import { createSqliteDatabase } from './db/client.js';
import { migrateDatabase } from './db/migrate.js';
import { JobRepository } from './repositories/job-repository.js';
import { MeetingRepository } from './repositories/meeting-repository.js';
import { OutboxRepository } from './repositories/outbox-repository.js';
import { createServiceReadiness } from './routes/health.js';
import { ingestMinuteGenerated } from './services/minute-ingestion.js';
import { routeReply } from './services/reply-router.js';

const config = loadConfig(process.env);
if (config.database.kind !== 'sqlite') {
  throw new Error('Phase 1A server supports SQLite only');
}

const database = createSqliteDatabase(config.database.url);
migrateDatabase(database.client);
const meetingRepository = new MeetingRepository(database.client);
const jobRepository = new JobRepository(database.client, {
  leaseDurationMs: config.worker.leaseSeconds * 1_000
});
const outboxRepository = new OutboxRepository(database.client);
const meetingSummarizer = createMeetingSummarizer({ config });
const feishuIntegration = createFeishuIntegration({ config });
const codexAuthProbe = new CodexAuthProbe({
  command: config.codex.command,
  workdir: config.codex.workdir,
  timeoutMs: config.codex.timeoutSeconds * 1_000,
  baseEnv: process.env,
  runner: new NodeCodexProcessRunner()
});
const workerRuntime = createWorkerRuntime(
  config.worker.enabled
    ? {
      enabled: true,
      meetingRepository,
      jobRepository,
      outboxRepository,
      reader: feishuIntegration.reader,
      summarizer: meetingSummarizer,
      delivery: feishuIntegration.delivery,
      targetChatId: config.feishu.ivyPrivateChatId,
      intervalMs: config.worker.pollIntervalMs
    }
    : {
      enabled: false
    }
);
workerRuntime.start();

const app = buildApp({
  readiness: createServiceReadiness({
    checkDatabase: () => database.client.prepare('SELECT 1').get(),
    isFeishuReaderAvailable: () => config.worker.enabled,
    isFeishuDeliveryAvailable: () => config.worker.enabled,
    isWorkerConsumptionAvailable: () => workerRuntime.isConsumptionAvailable(),
    isCodexAuthAvailable: async () =>
      config.codex.summarizerMode === 'codex' && await codexAuthProbe.isAvailable()
  }),
  verificationToken: config.feishu.verificationToken,
  encryptKey: config.feishu.encryptKey,
  ingestMinute: (event) => ingestMinuteGenerated(event, {
    meetingRepository,
    jobRepository
  }),
  routeReply: (input) => routeReply(input, {
    meetingRepository,
    ivyPrivateChatId: config.feishu.ivyPrivateChatId,
    approverOpenIds: config.feishu.approverOpenIds
  }),
  sendTextMessage: (input) => feishuIntegration.delivery.sendTextMessage(input)
});

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  await workerRuntime.stop();
  await app.close();
  database.close();
}

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());

try {
  await app.listen({ port: config.port, host: config.host });
} catch (error) {
  app.log.error({ err: error }, 'Server failed to start');
  await shutdown();
  process.exitCode = 1;
}

import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createSqliteDatabase } from './db/client.js';
import { migrateDatabase } from './db/migrate.js';
import { JobRepository } from './repositories/job-repository.js';
import { MeetingRepository } from './repositories/meeting-repository.js';
import { ingestMinuteGenerated } from './services/minute-ingestion.js';
import { routeReply } from './services/reply-router.js';

const config = loadConfig(process.env);
if (config.database.kind !== 'sqlite') {
  throw new Error('Phase 1A server supports SQLite only');
}

const database = createSqliteDatabase(config.database.url);
migrateDatabase(database.client);
const meetingRepository = new MeetingRepository(database.client);
const jobRepository = new JobRepository(database.client);

const app = buildApp({
  readiness: () => ({ ready: true }),
  verificationToken: config.feishu.verificationToken,
  ingestMinute: (event) => ingestMinuteGenerated(event, {
    meetingRepository,
    jobRepository
  }),
  routeReply: (input) => routeReply(input, {
    meetingRepository,
    ivyPrivateChatId: config.feishu.ivyPrivateChatId,
    approverOpenIds: config.feishu.approverOpenIds
  })
});

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  await app.close();
  database.close();
}

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());

try {
  await app.listen({ port: config.port, host: '0.0.0.0' });
} catch (error) {
  app.log.error({ err: error }, 'Server failed to start');
  await shutdown();
  process.exitCode = 1;
}

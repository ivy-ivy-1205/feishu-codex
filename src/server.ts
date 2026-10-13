import { readFileSync } from 'node:fs';
import { buildApp } from './app.js';
import { CodexAuthProbe, CodexCliAdapter, NodeCodexProcessRunner } from './adapters/codex-cli.js';
import { createFounderAnalysisAdapters } from './composition/founder-stream-analysis.js';
import { createFounderStreamRuntime } from './services/founder-stream-worker.js';
import { FeishuOAuthHttpClient, type FeishuOAuthSdkClientLike } from './adapters/feishu-oauth-client.js';
import { createFeishuSdkClient } from './adapters/feishu-sdk.js';
import { createFeishuWhiteboardGateway, type FeishuWhiteboardSdkLike } from './adapters/feishu-whiteboard.js';
import { createFeishuIntegration } from './composition/feishu.js';
import { createMeetingSummarizer } from './composition/meeting-summarizer.js';
import { createWorkerRuntime } from './composition/worker-runtime.js';
import { createContextRuntime } from './composition/context-runtime.js';
import { loadConfig } from './config.js';
import { createSqliteDatabase } from './db/client.js';
import { migrateDatabase } from './db/migrate.js';
import { JobRepository } from './repositories/job-repository.js';
import { MeetingRepository } from './repositories/meeting-repository.js';
import { OAuthTokenRepository } from './repositories/oauth-token-repository.js';
import { OutboxRepository } from './repositories/outbox-repository.js';
import { ProjectRepository } from './repositories/project-repository.js';
import { ContextSourceRepository } from './repositories/context-source-repository.js';
import { createPipelineReadiness } from './routes/health.js';
import { FeishuOAuthService, InMemoryOAuthStateStore } from './services/feishu-oauth.js';
import { ingestMinuteGenerated } from './services/minute-ingestion.js';
import { TokenCrypto } from './services/oauth-token-crypto.js';
import { routeReply } from './services/reply-router.js';
import { runFounderStreamBackfill } from './services/founder-stream-backfill.js';
import { publishFounderWhiteboard, selectFounderPalette } from './services/founder-whiteboard.js';

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
const projectRepository = new ProjectRepository(database.client);
const meetingSummarizer = createMeetingSummarizer({
  config,
  projectRepository
});
const contextRuntime = config.context.candidatesEnabled
  ? createContextRuntime({
    client: database.client,
    jobRepository,
    outboxRepository,
    projectRepository,
    targetChatId: config.feishu.ivyPrivateChatId,
    reviewEnabled: config.context.reviewEnabled,
    sourceMaxBytes: config.context.sourceMaxBytes,
    sourceMaxSegments: config.context.sourceMaxSegments,
    extractorMaxBytes: config.context.extractorMaxBytes,
    extractorMaxSegments: config.context.extractorMaxSegments,
    codex: config.codex,
    env: process.env
  })
  : null;
let oauth: FeishuOAuthService | undefined;
const feishuIntegration = createFeishuIntegration({
  config,
  userAccessTokenResolver: {
    async resolveUserAccessToken(input) {
      return oauth
        ? oauth.resolveUserAccessToken(input)
        : { status: 'unavailable', reason: 'oauth_disabled' };
    }
  }
});
oauth = config.feishu.oauth.enabled
  ? new FeishuOAuthService({
    appId: config.feishu.appId,
    redirectUri: config.feishu.oauth.redirectUri!,
    scopes: config.feishu.oauth.scopes,
    stateStore: new InMemoryOAuthStateStore(),
    tokenRepository: new OAuthTokenRepository(
      database.client,
      new TokenCrypto(readFileSync(config.feishu.oauth.tokenKeyFile!, 'utf8').trim())
    ),
    client: new FeishuOAuthHttpClient({
      appId: config.feishu.appId,
      appSecret: config.feishu.appSecret,
      sdkClient: createFeishuSdkClient({
        appId: config.feishu.appId,
        appSecret: config.feishu.appSecret
      }) as unknown as FeishuOAuthSdkClientLike
    }),
    ivyPrivateChatId: config.feishu.ivyPrivateChatId,
    sendReauthorizationCard: async (input) => {
      try {
        return await feishuIntegration.delivery.sendInteractiveCard({
          chatId: input.chatId,
          card: input.card
        });
      } catch (error) {
        console.warn('Feishu reauthorization card delivery failed; falling back to text', error);
        return feishuIntegration.delivery.sendTextMessage({
          chatId: input.chatId,
          text: input.fallbackText
        });
      }
    },
    staleEventMs: config.feishu.oauth.staleEventHours * 60 * 60 * 1_000
  })
  : undefined;
const codexAuthProbe = new CodexAuthProbe({
  command: config.codex.command,
  workdir: config.codex.workdir,
  timeoutMs: config.codex.timeoutSeconds * 1_000,
  baseEnv: process.env,
  runner: new NodeCodexProcessRunner()
});
const founderAnalysis = config.founderStream.analysisEnabled ? createFounderAnalysisAdapters({
  codex: new CodexCliAdapter({ command: config.codex.command, workdir: config.codex.workdir,
    timeoutMs: config.codex.timeoutSeconds * 1000, model: config.codex.model,
    reasoningEffort: config.codex.reasoningEffort, baseEnv: process.env, runner: new NodeCodexProcessRunner() })
}) : undefined;
const founderWhiteboardGateway = config.founderStream.whiteboardEnabled
  ? createFeishuWhiteboardGateway(createFeishuSdkClient({
    appId:config.feishu.appId,appSecret:config.feishu.appSecret
  }) as unknown as FeishuWhiteboardSdkLike)
  : undefined;
const founderRuntime = createFounderStreamRuntime({
  client: database.client, jobRepository, flags: config.founderStream,
  approvedChatIds: config.projectContext.approvedChatIds, ivyPrivateChatId: config.feishu.ivyPrivateChatId,
  intervalMs: config.worker.pollIntervalMs, delivery: feishuIntegration.delivery,attachmentReader:feishuIntegration.attachmentReader,
  ...(config.founderStream.dailyReconciliationEnabled?{dailyReconciliation:{
    bootstrapSince:config.founderStream.reconciliationBootstrapSince!,async run(window:{since:string;until:string;now:Date}){
    await runFounderStreamBackfill({chatId:config.projectContext.approvedChatIds[0]!,since:window.since,until:window.until,
      now:window.now,feishu:feishuIntegration.contextClient,sourceRepository:new ContextSourceRepository(database.client),
      jobRepository,dryRun:false,enqueueAnalysis:config.founderStream.analysisEnabled,syncPurpose:'daily_reconciliation'});
  }}}:{}),
  ...(founderWhiteboardGateway?{whiteboardPublisher:{async publish(input:{title:string;chatId:string;
    cards:readonly Record<string,unknown>[];previousPaletteId?:string|null}){
    const palette=selectFounderPalette(input.previousPaletteId);
    return publishFounderWhiteboard({...input,paletteId:palette.id},founderWhiteboardGateway);
  }}}:{}),
  ...(founderAnalysis ?? {})
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
      intervalMs: config.worker.pollIntervalMs,
      founder: founderRuntime,
      ...(contextRuntime
        ? { context: { capture: contextRuntime.capture, worker: contextRuntime.worker } }
        : {})
    }
    : {
      enabled: false
    }
);
workerRuntime.start();
if (!config.worker.enabled) founderRuntime.start();

const app = buildApp({
  readiness: createPipelineReadiness({
    checkDatabase: () => database.client.prepare('SELECT 1').get(),
    meetingEnabled: config.worker.enabled,
    founderFlags: config.founderStream,
    meetingConsumerAvailable: () => workerRuntime.isConsumptionAvailable(),
    founderConsumerAvailable: () => founderRuntime.isConsumptionAvailable(),
    meetingCodexRequired: config.codex.summarizerMode === 'codex' || config.context.candidatesEnabled,
    isCodexAuthAvailable: () => codexAuthProbe.isAvailable()
  }),
  founderStreamDiagnostics: { client: database.client },
  projectRepository,
  ...(contextRuntime ? {
    context: {
      client: database.client,
      ...(config.context.reviewEnabled ? {
        review: {
          ivyPrivateChatId: config.feishu.ivyPrivateChatId,
          approverOpenIds: config.feishu.approverOpenIds,
          outboxRepository,
          recordRepository: contextRuntime.recordRepository
        }
      } : {})
    }
  } : {}),
  verificationToken: config.feishu.verificationToken,
  founderStream: founderRuntime.route,
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
  sendTextMessage: (input) => feishuIntegration.delivery.sendTextMessage(input),
  oauth
});

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  await workerRuntime.stop();
  await founderRuntime.stop();
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

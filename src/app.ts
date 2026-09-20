import fastify, {
  type FastifyInstance,
  type FastifyServerOptions
} from 'fastify';
import type Database from 'better-sqlite3';
import type { ReplyDecision } from './domain/authorization.js';
import {
  registerFeishuEventRoutes,
  type FounderFeedbackRouteDependencies
} from './routes/feishu-events.js';
import {
  registerFeishuOAuthRoutes
} from './routes/feishu-oauth.js';
import {
  registerHealthRoutes,
  type ReadinessCheck
} from './routes/health.js';
import type { FeishuOAuthService } from './services/feishu-oauth.js';
import type { IngestionResult } from './services/minute-ingestion.js';
import type { ProjectRepository } from './repositories/project-repository.js';
import { registerProjectDiagnosticsRoute } from './routes/project-diagnostics.js';
import { registerContextDiagnosticsRoute } from './routes/context-diagnostics.js';
import { registerContextReviewActionRoutes } from './routes/context-review-actions.js';
import type { OutboxRepository } from './repositories/outbox-repository.js';
import type { ContextRecordRepository } from './repositories/context-record-repository.js';
import type { FounderStreamRoute } from './services/founder-stream-worker.js';
import { registerFounderStreamDiagnosticsRoute } from './routes/founder-stream-diagnostics.js';

type LoggerOption = FastifyServerOptions['logger'];

export interface AppDependencies {
  readiness: ReadinessCheck;
  verificationToken: string;
  encryptKey: string;
  ingestMinute(event: unknown): IngestionResult;
  routeReply(input: unknown): ReplyDecision;
  founderFeedback?: FounderFeedbackRouteDependencies;
  founderStream?: FounderStreamRoute;
  founderStreamDiagnostics?: { client: Database.Database };
  sendTextMessage?(input: { chatId: string; text: string }): Promise<{ messageId: string }>;
  oauth?: FeishuOAuthService;
  projectRepository?: ProjectRepository;
  context?: {
    client: Database.Database;
    review?: {
      ivyPrivateChatId: string;
      approverOpenIds: readonly string[];
      outboxRepository: OutboxRepository;
      recordRepository: ContextRecordRepository;
    };
  };
  logger?: LoggerOption;
}

export function buildApp(dependencies: AppDependencies): FastifyInstance {
  const app = fastify({
    logger: safeLoggerOptions(dependencies.logger)
  });

  registerHealthRoutes(app, dependencies.readiness);
  registerFeishuEventRoutes(app, {
    verificationToken: dependencies.verificationToken,
    encryptKey: dependencies.encryptKey,
    ingestMinute: dependencies.ingestMinute,
    routeReply: dependencies.routeReply,
    founderFeedback: dependencies.founderFeedback,
    founderStream: dependencies.founderStream,
    sendTextMessage: dependencies.sendTextMessage,
    recordOAuthRevocation: dependencies.oauth
      ? (openId) => dependencies.oauth!.recordRevocation(openId)
      : undefined,
    recordMinuteEvent: dependencies.oauth
      ? (event) => dependencies.oauth!.recordMinuteEvent(event)
      : undefined
  });
  registerContextReviewActionRoutes(app, {
    verificationToken: dependencies.verificationToken,
    encryptKey: dependencies.encryptKey,
    ...(dependencies.context?.review ? { review: dependencies.context.review } : {})
  });
  if (dependencies.oauth) {
    registerFeishuOAuthRoutes(app, { oauth: dependencies.oauth });
  }
  if (dependencies.projectRepository) {
    registerProjectDiagnosticsRoute(app, dependencies.projectRepository);
  }
  if (dependencies.context) {
    registerContextDiagnosticsRoute(app, dependencies.context.client);
  }
  if (dependencies.founderStreamDiagnostics) {
    registerFounderStreamDiagnosticsRoute(app, dependencies.founderStreamDiagnostics.client);
  }

  return app;
}

function safeLoggerOptions(logger: LoggerOption): LoggerOption {
  if (logger === false) {
    return false;
  }
  const overrides = typeof logger === 'object' ? logger : {};
  return {
    ...overrides,
    hooks: {
      ...overrides.hooks,
      streamWrite(serialized) {
        try {
          const parsed = JSON.parse(serialized) as Record<string, unknown>;
          return `${JSON.stringify(sanitizeLogObject(parsed))}\n`;
        } catch {
          return '{"level":50,"msg":"[Unserializable log redacted]"}\n';
        }
      }
    },
    redact: {
      paths: [
        'token',
        '*.token',
        'secret',
        '*.secret',
        'appSecret',
        '*.appSecret',
        'encryptKey',
        '*.encryptKey',
        'transcriptText',
        '*.transcriptText',
        'body',
        '*.body',
        'rawBody',
        '*.rawBody',
        'req.body',
        'req.rawBody',
        'req.headers.authorization',
        'headers.authorization'
      ],
      censor: '[Redacted]'
    },
    serializers: {
      req(request) {
        const rawUrl = typeof request.url === 'string'
          ? request.url
          : request.raw.url ?? '';
        return {
          method: request.method,
          url: request.routeOptions?.url ?? rawUrl.split('?', 1)[0],
          remoteAddress: request.ip
        };
      },
      res(response) {
        return { statusCode: response.statusCode };
      },
      err(error) {
        return {
          type: error.name,
          message: '[Redacted]',
          stack: '[Redacted]',
          code: error.code
        };
      }
    }
  };
}

function sanitizeLogObject(object: Record<string, unknown>): Record<string, unknown> {
  return sanitizeLogValue(object, new WeakSet<object>()) as Record<string, unknown>;
}

function sanitizeLogValue(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (value instanceof Date || Buffer.isBuffer(value)) {
    return value;
  }
  if (value instanceof Error) {
    return {
      type: value.name,
      message: '[Redacted]',
      stack: '[Redacted]'
    };
  }
  if (seen.has(value)) {
    return '[Circular]';
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeLogValue(item, seen));
  }

  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key,
    isSensitiveLogKey(key) ? '[Redacted]' : sanitizeLogValue(child, seen)
  ]));
}

function isSensitiveLogKey(key: string): boolean {
  const canonical = key.replace(/[^a-z0-9]/giu, '').toLowerCase();
  return canonical.endsWith('token') ||
    canonical.endsWith('secret') ||
    canonical.endsWith('authorization') ||
    canonical.includes('encryptkey') ||
    canonical.includes('transcripttext') ||
    canonical === 'body' ||
    canonical.endsWith('rawbody') ||
    canonical.endsWith('requestbody') ||
    canonical.endsWith('eventbody');
}

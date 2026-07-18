import fastify, {
  type FastifyInstance,
  type FastifyServerOptions
} from 'fastify';
import type { ReplyDecision } from './domain/authorization.js';
import {
  registerFeishuEventRoutes
} from './routes/feishu-events.js';
import {
  registerHealthRoutes,
  type ReadinessCheck
} from './routes/health.js';
import type { IngestionResult } from './services/minute-ingestion.js';

type LoggerOption = FastifyServerOptions['logger'];

export interface AppDependencies {
  readiness: ReadinessCheck;
  verificationToken: string;
  ingestMinute(event: unknown): IngestionResult;
  routeReply(input: unknown): ReplyDecision;
  logger?: LoggerOption;
}

export function buildApp(dependencies: AppDependencies): FastifyInstance {
  const app = fastify({
    logger: safeLoggerOptions(dependencies.logger)
  });

  registerHealthRoutes(app, dependencies.readiness);
  registerFeishuEventRoutes(app, {
    verificationToken: dependencies.verificationToken,
    ingestMinute: dependencies.ingestMinute,
    routeReply: dependencies.routeReply
  });

  return app;
}

function safeLoggerOptions(logger: LoggerOption): LoggerOption {
  if (logger === false) {
    return false;
  }
  const overrides = typeof logger === 'object' ? logger : {};
  return {
    ...overrides,
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
        return {
          method: request.method,
          url: request.url,
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

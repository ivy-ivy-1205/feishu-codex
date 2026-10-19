import type { FastifyInstance } from 'fastify';

export type ReadinessStatus =
  | { ready: true }
  | { ready: false; reason: string; blockers?: ReadinessBlocker[] };

export type ReadinessBlocker =
  | 'FEISHU_READER_UNAVAILABLE'
  | 'FEISHU_DELIVERY_UNAVAILABLE'
  | 'WORKER_CONSUMER_UNAVAILABLE'
  | 'CODEX_AUTH_UNAVAILABLE';

export type ReadinessCheck = () => ReadinessStatus | Promise<ReadinessStatus>;

export interface ServiceReadinessDependencies {
  checkDatabase(): unknown | Promise<unknown>;
  isWorkerConsumptionAvailable(): boolean | Promise<boolean>;
  isFeishuReaderAvailable?: () => boolean | Promise<boolean>;
  isFeishuDeliveryAvailable?: () => boolean | Promise<boolean>;
  isCodexAuthAvailable?: () => boolean | Promise<boolean>;
}

export function createPipelineReadiness(input: {
  checkDatabase(): unknown | Promise<unknown>;
  meetingEnabled: boolean;
  founderFlags: { captureEnabled: boolean; analysisEnabled: boolean; groupDeliveryEnabled: boolean };
  meetingConsumerAvailable(): boolean | Promise<boolean>;
  founderConsumerAvailable(): boolean | Promise<boolean>;
  meetingCodexRequired: boolean;
  isCodexAuthAvailable(): boolean | Promise<boolean>;
}): ReadinessCheck {
  const founderOnly = !input.meetingEnabled && input.founderFlags.captureEnabled;
  return createServiceReadiness({
    checkDatabase: input.checkDatabase,
    // Founder capture consumes stored events; it does not require the Minutes reader.
    isFeishuReaderAvailable: () => input.meetingEnabled || founderOnly,
    isFeishuDeliveryAvailable: () => input.meetingEnabled || founderOnly,
    isWorkerConsumptionAvailable: () => input.meetingEnabled ? input.meetingConsumerAvailable()
      : founderOnly ? input.founderConsumerAvailable() : false,
    isCodexAuthAvailable: () => founderOnly && !input.founderFlags.analysisEnabled ? true
      : (input.meetingCodexRequired || input.founderFlags.analysisEnabled) ? input.isCodexAuthAvailable() : false
  });
}

export function createServiceReadiness(
  dependencies: ServiceReadinessDependencies
): ReadinessCheck {
  return async () => {
    try {
      await dependencies.checkDatabase();
    } catch {
      return { ready: false, reason: 'DATABASE_UNAVAILABLE' };
    }

    const blockers: ReadinessBlocker[] = [];
    if (!await probe(dependencies.isFeishuReaderAvailable)) {
      blockers.push('FEISHU_READER_UNAVAILABLE');
    }
    if (!await probe(dependencies.isFeishuDeliveryAvailable)) {
      blockers.push('FEISHU_DELIVERY_UNAVAILABLE');
    }
    if (!await probe(dependencies.isWorkerConsumptionAvailable)) {
      blockers.push('WORKER_CONSUMER_UNAVAILABLE');
    }
    if (!await probe(dependencies.isCodexAuthAvailable)) {
      blockers.push('CODEX_AUTH_UNAVAILABLE');
    }

    if (blockers.length > 0) {
      return {
        ready: false,
        reason: 'READINESS_BLOCKED',
        blockers
      };
    }
    return { ready: true };
  };
}

async function probe(check: (() => boolean | Promise<boolean>) | undefined): Promise<boolean> {
  if (!check) {
    return true;
  }
  try {
    return await check();
  } catch {
    return false;
  }
}

export function registerHealthRoutes(
  app: FastifyInstance,
  readiness: ReadinessCheck
): void {
  app.get('/health', async () => ({ status: 'ok' }));

  app.get('/ready', async (_request, reply) => {
    try {
      const status = await readiness();
      if (!status.ready) {
        return reply.code(503).send(status);
      }
      return status;
    } catch {
      return reply.code(503).send({
        ready: false,
        reason: 'DEPENDENCY_CHECK_FAILED'
      });
    }
  });
}

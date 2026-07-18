import type { FastifyInstance } from 'fastify';

export type ReadinessStatus =
  | { ready: true }
  | { ready: false; reason: string };

export type ReadinessCheck = () => ReadinessStatus | Promise<ReadinessStatus>;

export interface ServiceReadinessDependencies {
  checkDatabase(): unknown | Promise<unknown>;
  isWorkerConsumptionAvailable(): boolean | Promise<boolean>;
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

    try {
      if (!await dependencies.isWorkerConsumptionAvailable()) {
        return { ready: false, reason: 'WORKER_UNAVAILABLE' };
      }
    } catch {
      return { ready: false, reason: 'WORKER_UNAVAILABLE' };
    }
    return { ready: true };
  };
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

import type { FastifyInstance } from 'fastify';

export type ReadinessStatus =
  | { ready: true }
  | { ready: false; reason: string };

export type ReadinessCheck = () => ReadinessStatus | Promise<ReadinessStatus>;

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

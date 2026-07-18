import { describe, expect, it } from 'vitest';
import { buildApp, type AppDependencies } from '../src/app.js';

describe('health routes', () => {
  it('keeps liveness independent from dependency readiness', async () => {
    const app = buildApp(createDependencies({ ready: false, reason: 'CODEX_AUTH_REQUIRED' }));

    const health = await app.inject({ method: 'GET', url: '/health' });
    const ready = await app.inject({ method: 'GET', url: '/ready' });

    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: 'ok' });
    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toEqual({ ready: false, reason: 'CODEX_AUTH_REQUIRED' });
    await app.close();
  });

  it('reports readiness only when the dependency gate passes', async () => {
    const app = buildApp(createDependencies({ ready: true }));

    const response = await app.inject({ method: 'GET', url: '/ready' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ready: true });
    await app.close();
  });

  it('fails readiness closed when the dependency check throws', async () => {
    const dependencies = createDependencies({ ready: true });
    dependencies.readiness = () => {
      throw new Error('database secret must not escape');
    };
    const app = buildApp(dependencies);

    const response = await app.inject({ method: 'GET', url: '/ready' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ ready: false, reason: 'DEPENDENCY_CHECK_FAILED' });
    expect(response.body).not.toContain('database secret');
    await app.close();
  });
});

function createDependencies(
  readiness: { ready: true } | { ready: false; reason: string }
): AppDependencies {
  return {
    readiness: () => readiness,
    verificationToken: 'verify-test-token',
    ingestMinute: () => ({ status: 'ignored' }),
    routeReply: () => ({ kind: 'reject', reason: 'invalid_input' }),
    logger: false
  };
}

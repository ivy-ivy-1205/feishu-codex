import { describe, expect, it } from 'vitest';
import { buildApp, type AppDependencies } from '../src/app.js';
import { ProjectRepository } from '../src/repositories/project-repository.js';
import { createTestMeetingRepository } from './helpers/test-db.js';

describe('/diag/projects', () => {
  it('returns registry counts and open conflicts without secrets', async () => {
    const database = createTestMeetingRepository();
    const app = buildApp(testDependenciesWithSeededProjects(new ProjectRepository(database.client)));

    const response = await app.inject({ method: 'GET', url: '/diag/projects' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      projects: { active: 9 },
      rules: { active: expect.any(Number) },
      contextSnapshots: { total: expect.any(Number) },
      conflicts: { open: expect.any(Number) }
    });
    expect(response.body).not.toContain('user_access_token');
    expect(response.body).not.toContain('FEISHU_APP_SECRET');
    await app.close();
  });
});

function testDependenciesWithSeededProjects(projectRepository: ProjectRepository): AppDependencies {
  return {
    readiness: () => ({ ready: true }),
    verificationToken: 'verify-test-token',
    encryptKey: 'encrypt-test-key',
    ingestMinute: () => ({ status: 'ignored' }),
    routeReply: () => ({ kind: 'reject', reason: 'invalid_input' }),
    projectRepository,
    logger: false
  };
}

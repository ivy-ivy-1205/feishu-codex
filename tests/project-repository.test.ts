import { describe, expect, it } from 'vitest';
import { createTestMeetingRepository } from './helpers/test-db.js';
import { ProjectRepository } from '../src/repositories/project-repository.js';

describe('ProjectRepository', () => {
  it('lists seeded active projects and rules after migration', () => {
    const database = createTestMeetingRepository();
    const repo = new ProjectRepository(database.client);

    expect(repo.listActiveProjects().map((project) => project.projectKey))
      .toContain('realagent-ai-cc');
    expect(repo.listActiveRules().map((rule) => rule.id))
      .toContain('system:compass');
  });

  it('records Ivy corrections as higher-priority long-lived rules', () => {
    const database = createTestMeetingRepository();
    const repo = new ProjectRepository(database.client);

    const rule = repo.recordIvyCorrection({
      pattern: 'Hero 区',
      patternKind: 'keyword',
      projectKey: 'aijia-landingpage',
      subprojectKey: null,
      confidenceHint: 'high',
      createdAt: new Date('2026-07-31T10:00:00.000Z')
    });

    expect(rule).toMatchObject({
      source: 'ivy_correction',
      projectKey: 'aijia-landingpage',
      priority: 1000,
      active: true
    });
  });

  it('creates a persistent correction rule for an active project', () => {
    const database = createTestMeetingRepository();
    const repo = new ProjectRepository(database.client);

    expect(repo.createCorrectionRule({
      pattern: 'B-roll',
      patternKind: 'keyword',
      projectKey: 'openmontage',
      subprojectKey: null,
      confidenceHint: 'high',
      createdAt: new Date('2026-07-31T10:00:00.000Z')
    })).toMatchObject({
      pattern: 'B-roll',
      projectKey: 'openmontage',
      source: 'ivy_correction'
    });
  });

  it('deactivates the previous same-pattern correction while preserving its audit row', () => {
    const database = createTestMeetingRepository();
    const repo = new ProjectRepository(database.client);
    const first = repo.createCorrectionRule({
      pattern: 'B-roll',
      patternKind: 'keyword',
      projectKey: 'openmontage',
      subprojectKey: null,
      confidenceHint: 'high',
      createdAt: new Date('2026-07-31T10:00:00.000Z')
    });
    const replacement = repo.createCorrectionRule({
      pattern: '  b-ROLL  ',
      patternKind: 'keyword',
      projectKey: 'aijia-landingpage',
      subprojectKey: null,
      confidenceHint: 'high',
      createdAt: new Date('2026-07-31T11:00:00.000Z')
    });

    expect(repo.listActiveRules().filter((rule) => (
      rule.source === 'ivy_correction' && rule.pattern.toLowerCase().includes('b-roll')
    ))).toEqual([expect.objectContaining({
      id: replacement.id,
      projectKey: 'aijia-landingpage',
      active: true
    })]);
    expect(database.client.prepare(`
      SELECT id, project_key, active FROM project_mapping_rules
      WHERE source = 'ivy_correction' ORDER BY created_at ASC
    `).all()).toEqual([
      { id: first.id, project_key: 'openmontage', active: 0 },
      { id: replacement.id, project_key: 'aijia-landingpage', active: 1 }
    ]);
  });
});

import { describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestMeetingRepository } from './helpers/test-db.js';
import { ProjectRepository } from '../src/repositories/project-repository.js';

describe('ProjectRepository', () => {
  it('lists no preset projects or mapping rules after a fresh migration', () => {
    const database = createTestMeetingRepository();
    const repo = new ProjectRepository(database.client);

    expect(repo.listProjects()).toEqual([]);
    expect(repo.listMappingRules()).toEqual([]);
    expect(repo.listDiscoveryEligibleProjects()).toEqual([]);
  });

  it('limits discovery to non-legacy projects that are not closed', () => {
    const database = createTestMeetingRepository();
    const repo = new ProjectRepository(database.client);
    insertProject(database.client, 'evidence-project', 'discovered', 'active_project');
    insertProject(database.client, 'founder-project', 'human_confirmed', 'paused');
    insertProject(database.client, 'closed-project', 'discovered', 'closed');
    insertProject(database.client, 'legacy-project', 'legacy_seed', 'active_project');

    expect(repo.listDiscoveryEligibleProjects().map((project) => project.projectKey)).toEqual([
      'evidence-project',
      'founder-project'
    ]);
  });

  it('records Ivy corrections as higher-priority long-lived rules', () => {
    const database = createTestMeetingRepository();
    const repo = new ProjectRepository(database.client);
    insertLegacyProject(database.client, 'aijia-landingpage');

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
    insertLegacyProject(database.client, 'openmontage');

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
    insertLegacyProject(database.client, 'openmontage');
    insertLegacyProject(database.client, 'aijia-landingpage');
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

function insertProject(
  client: Database.Database,
  projectKey: string,
  origin: 'discovered' | 'human_confirmed' | 'legacy_seed',
  stage: 'idea' | 'exploring' | 'project_candidate' | 'active_project' | 'paused' | 'closed'
): void {
  client.prepare(`
    INSERT INTO projects (
      project_key, display_name, aliases, local_path_hint, repo_url,
      default_branch, status, origin, stage, created_at, updated_at
    ) VALUES (?, ?, '[]', NULL, NULL, NULL, 'active', ?, ?, ?, ?)
  `).run(projectKey, projectKey, origin, stage, '2026-09-20', '2026-09-20');
}

function insertLegacyProject(client: Database.Database, projectKey: string): void {
  client.prepare(`
    INSERT INTO projects (
      project_key, display_name, aliases, local_path_hint, repo_url,
      default_branch, status, created_at, updated_at
    ) VALUES (?, ?, '[]', NULL, NULL, NULL, 'active', ?, ?)
  `).run(projectKey, projectKey, '2026-07-31', '2026-07-31');
}

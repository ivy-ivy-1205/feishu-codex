import { describe, expect, it } from 'vitest';
import {
  ProjectDefinition,
  ProjectMappingDraft,
  ProjectMappingRule
} from '../src/domain/project.js';

describe('Project Registry domain', () => {
  it('validates evidence-backed project origin and lifecycle stage', () => {
    expect(ProjectDefinition.safeParse({
      projectKey: 'source-backed-project',
      displayName: 'Source-backed project',
      aliases: [],
      localPathHint: null,
      repoUrl: null,
      defaultBranch: null,
      status: 'active',
      origin: 'discovered',
      stage: 'exploring'
    }).success).toBe(true);
    expect(ProjectDefinition.safeParse({
      projectKey: 'invalid-project',
      displayName: 'Invalid project',
      aliases: [],
      localPathHint: null,
      repoUrl: null,
      defaultBranch: null,
      status: 'active',
      origin: 'preset',
      stage: 'active_project'
    }).success).toBe(false);
  });

  it('validates persisted founder correction rules', () => {
    expect(ProjectMappingRule.safeParse({
      id: 'ivy:landing-page',
      pattern: 'landing page',
      patternKind: 'keyword',
      projectKey: 'aijia-landingpage',
      subprojectKey: null,
      confidenceHint: 'high',
      priority: 1000,
      source: 'ivy_correction',
      active: true
    }).success).toBe(true);
  });

  it('rejects invalid project mapping confidence and status values', () => {
    expect(ProjectMappingDraft.safeParse({
      projectKey: null,
      subprojectKey: null,
      confidence: 'certain',
      evidence: 'model guessed',
      status: 'mapped',
      projectPrompt: '请处理这个任务。'
    }).success).toBe(false);
  });
});

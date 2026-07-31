import { describe, expect, it } from 'vitest';
import {
  ProjectDefinition,
  ProjectMappingDraft,
  ProjectMappingRule
} from '../src/domain/project.js';
import {
  initialProjectDefinitions,
  initialProjectMappingRules
} from '../src/services/project-registry-seed.js';

describe('Project Registry domain', () => {
  it('validates Ivy approved initial projects', () => {
    expect(initialProjectDefinitions.map((project) => project.projectKey)).toEqual([
      'feishu-adaptor',
      'openmontage',
      'aijia-landingpage',
      'realagent-ai-cc',
      'ljhooker-audiobooks',
      'ivy-xhs',
      'james-wechat',
      'family-first-ai-os',
      'aijia-compass-work'
    ]);
    for (const project of initialProjectDefinitions) {
      expect(ProjectDefinition.safeParse(project).success).toBe(true);
    }
  });

  it('validates deterministic keyword and correction rules', () => {
    expect(initialProjectMappingRules).toEqual(expect.arrayContaining([
      expect.objectContaining({
        pattern: 'Amy Live',
        projectKey: 'realagent-ai-cc',
        subprojectKey: 'amy-voice'
      }),
      expect.objectContaining({
        pattern: 'compass',
        projectKey: 'aijia-compass-work'
      })
    ]));
    for (const rule of initialProjectMappingRules) {
      expect(ProjectMappingRule.safeParse(rule).success).toBe(true);
    }
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

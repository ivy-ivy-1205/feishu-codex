import { describe, expect, it } from 'vitest';
import { mapTodoToProject } from '../src/services/project-mapper.js';
import {
  initialProjectDefinitions,
  initialProjectMappingRules
} from '../src/services/project-registry-seed.js';

const registry = {
  projects: [...initialProjectDefinitions],
  rules: [...initialProjectMappingRules],
  contextSnapshots: []
};

describe('mapTodoToProject', () => {
  it('maps Amy Live to RealAgent Amy Voice with high confidence', () => {
    expect(mapTodoToProject({
      title: '生成 Amy Live 复测与 Demo 剪辑清单',
      description: '验证 Amy 语音通话延迟和中文音色。',
      proposedProjectKey: null,
      proposedSubprojectKey: null,
      proposedConfidence: 'low',
      proposedEvidence: '',
      proposedProjectPrompt: '请整理复测清单。'
    }, registry)).toMatchObject({
      projectKey: 'realagent-ai-cc',
      subprojectKey: 'amy-voice',
      confidence: 'high',
      status: 'mapped'
    });
  });

  it('maps compass to aijia-compass-work', () => {
    expect(mapTodoToProject({
      title: '整理 compass 下一步',
      description: '输出项目化 prompt。',
      proposedProjectKey: null,
      proposedSubprojectKey: null,
      proposedConfidence: 'low',
      proposedEvidence: '',
      proposedProjectPrompt: '请整理 compass 下一步。'
    }, registry)).toMatchObject({
      projectKey: 'aijia-compass-work',
      confidence: 'high',
      status: 'mapped'
    });
  });

  it('preserves Unicode regex syntax while matching normalized candidate text', () => {
    expect(mapTodoToProject({
      title: 'ABC',
      description: '',
      proposedProjectKey: null,
      proposedSubprojectKey: null,
      proposedConfidence: 'low',
      proposedEvidence: '',
      proposedProjectPrompt: '请整理 ABC。'
    }, {
      ...registry,
      rules: [
        ...registry.rules,
        {
          id: 'system:unicode-uppercase',
          pattern: '^\\p{Lu}+$',
          patternKind: 'regex',
          projectKey: 'feishu-adaptor',
          subprojectKey: null,
          confidenceHint: 'high',
          priority: 200,
          source: 'system',
          active: true
        }
      ]
    })).toMatchObject({
      projectKey: 'feishu-adaptor',
      confidence: 'high',
      status: 'mapped'
    });
  });

  it('keeps unknown items as needs_confirmation and renders them as pending', () => {
    expect(mapTodoToProject({
      title: '整理未命名项目的材料',
      description: '会议没有给出项目名。',
      proposedProjectKey: null,
      proposedSubprojectKey: null,
      proposedConfidence: 'low',
      proposedEvidence: '',
      proposedProjectPrompt: '请先确认项目。'
    }, registry)).toMatchObject({
      projectKey: null,
      confidence: 'low',
      status: 'needs_confirmation'
    });
  });
});

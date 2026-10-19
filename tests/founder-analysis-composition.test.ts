import { expect, it } from 'vitest';
import { createFounderAnalysisAdapters } from '../src/composition/founder-stream-analysis.js';
import { sha256 } from '../src/services/canonical-json.js';

it('composes both topic and perspective analysis on the same Codex executor boundary', async () => {
  const prompts: string[] = [];
  const stack = createFounderAnalysisAdapters({ codex: { async executeJson(request) {
    prompts.push(request.prompt);
    return prompts.length === 1 ? { topics: [] } : { observations: [], alignmentProposals: [] };
  } } });
  await stack.analyzer.analyze({ sources: [{ id:'src',sourceType:'group_message',sourceVersion:1,
    contentHash:sha256('讨论官网'),contentText:'讨论官网',occurredAt:'2026-09-20T00:00:00.000Z',availabilityStatus:'available' }],currentTopics:[] });
  await stack.perspectiveAnalyzer.analyze({ sourceIds:['src'],topicIds:['topic'],evidence:[{
    id:'ev',sourceId:'src',topicIds:['topic'],excerpt:'讨论官网',founder:'ivy',occurredAt:'2026-09-20T00:00:00.000Z'
  }] });
  expect(prompts).toHaveLength(2);
  expect(prompts[0]).toContain('话题分析器');
  expect(prompts[1]).toContain('观点与分歧分析器');
});

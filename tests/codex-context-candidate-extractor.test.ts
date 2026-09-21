import { describe, expect, it } from 'vitest';
import {
  CodexContextCandidateExtractor,
  contextCandidateOutputJsonSchema
} from '../src/adapters/codex-context-candidate-extractor.js';
import type { CodexJsonExecutor } from '../src/ports/json-executor.js';
import { extractedContextCandidateSchema } from '../src/ports/context-candidate-extractor.js';

const source = {
  id: 'ctxsrc_1', sourceSystem: 'fixture', sourceType: 'transcript', externalId: 'm1',
  logicalKey: 'fixture:m1', sourceVersion: 1, occurredAt: '2026-08-03T00:00:00.000Z',
  authors: [], locatorUri: null, contentFormat: 'text/plain',
  contentText: 'Ivy [0-1000]: 决定周五上线，但目前还没有上线。',
  metadata: { segments: [{ segmentOrdinal: 0, speakerName: 'Ivy', startMs: 0, endMs: 1000 }] },
  contentHash: 'a'.repeat(64),
  availabilityStatus: 'available' as const, capturedAt: '2026-08-03T00:00:00.000Z',
  rawTextExpiresAt: null, contentState: 'cleartext' as const, redactedAt: null
};
const validCandidate = {
  candidateType: 'decision', scope: 'project', summary: '决定周五上线', subjectKey: 'release',
  structuredPayload: {}, extractionConfidence: 0.9, factualStatus: 'source_attested',
  projectMappings: [{ projectKey: 'feishu-adaptor', role: 'primary', confidence: 'high', evidence: '会议标题和内容明确' }],
  evidence: [{ sourceId: 'ctxsrc_1', excerpt: '决定周五上线', locator: {
    segmentOrdinal: 0, sourceVersion: 1, contentHash: 'a'.repeat(64),
    speakerName: 'Ivy', startMs: 0, endMs: 1000
  }, evidenceLevel: 'primary_statement', role: 'supporting' }],
  suggestedRelations: [], externalRefs: []
};

function findNonStrictObjectSchemas(schema: unknown, path = '$'): string[] {
  if (Array.isArray(schema)) {
    return schema.flatMap((value, index) => findNonStrictObjectSchemas(value, `${path}[${index}]`));
  }
  if (!schema || typeof schema !== 'object') return [];
  const record = schema as Record<string, unknown>;
  const current = record.type === 'object' && record.additionalProperties !== false ? [path] : [];
  return current.concat(Object.entries(record).flatMap(([key, value]) =>
    findNonStrictObjectSchemas(value, `${path}.${key}`)));
}

describe('CodexContextCandidateExtractor', () => {
  it('emits only strict object schemas accepted by Codex structured output', () => {
    expect(findNonStrictObjectSchemas(contextCandidateOutputJsonSchema)).toEqual([]);
  });

  it('requests atomic candidates and keeps decision separate from completion status', async () => {
    const calls: Parameters<CodexJsonExecutor['executeJson']>[0][] = [];
    const extractor = new CodexContextCandidateExtractor({ codex: { async executeJson(input) {
      calls.push(input);
      return { candidates: [validCandidate, { ...validCandidate, candidateType: 'claim',
        summary: '当前还没有上线', factualStatus: 'reported', extractionConfidence: 0.7 }] };
    } } });
    const output = await extractor.extract({ sources: [source], projects: [], existingRecords: [] });
    expect(output.candidates.map((candidate) => candidate.summary)).toEqual(['决定周五上线', '当前还没有上线']);
    expect(calls[0]?.prompt).toContain('决定上线”和“已经上线”必须拆成两个候选');
    expect(calls[0]?.prompt).toContain('proposal/decision/requirement/action_item → source_attested');
    expect(calls[0]?.prompt).toContain('reported_progress/claim/status_update/risk/blocker → reported');
    expect(JSON.stringify(calls[0]?.outputSchema)).not.toContain('feishu');
  });

  it.each([
    ['proposal', 'source_attested'], ['decision', 'source_attested'],
    ['requirement', 'source_attested'], ['action_item', 'source_attested'],
    ['reported_progress', 'reported'], ['claim', 'reported'], ['status_update', 'reported'],
    ['risk', 'reported'], ['blocker', 'reported']
  ] as const)('accepts the locked factual default for %s', (candidateType, factualStatus) => {
    expect(extractedContextCandidateSchema.safeParse({ ...validCandidate, candidateType, factualStatus }).success)
      .toBe(true);
  });

  it.each([
    ['proposal', 'reported'], ['decision', 'reported'], ['requirement', 'reported'],
    ['action_item', 'reported'], ['reported_progress', 'source_attested'],
    ['claim', 'source_attested'], ['status_update', 'source_attested'],
    ['risk', 'source_attested'], ['blocker', 'source_attested']
  ] as const)('rejects an illegal factual default for %s', (candidateType, factualStatus) => {
    expect(extractedContextCandidateSchema.safeParse({ ...validCandidate, candidateType, factualStatus }).success)
      .toBe(false);
  });

  it.each([
    { ...validCandidate, factualStatus: 'evidence_verified' },
    { ...validCandidate, evidence: [] },
    { ...validCandidate, projectMappings: [] }
  ])('rejects unsafe extractor output %#', async (candidate) => {
    const extractor = new CodexContextCandidateExtractor({ codex: { async executeJson() { return { candidates: [candidate] }; } } });
    await expect(extractor.extract({ sources: [source], projects: [], existingRecords: [] })).rejects.toThrow();
  });

  it('rejects more than twelve candidates', async () => {
    const extractor = new CodexContextCandidateExtractor({ codex: { async executeJson() {
      return { candidates: Array.from({ length: 13 }, (_, index) => ({ ...validCandidate, summary: `候选 ${index}` })) };
    } } });
    await expect(extractor.extract({ sources: [source], projects: [], existingRecords: [] })).rejects.toThrow();
  });

  it('keeps pure Todo outside the production adapter candidate schema and prompt contract', async () => {
    const candidateType = (((contextCandidateOutputJsonSchema.properties.candidates.items.properties
      .candidateType as { enum: readonly string[] }).enum));
    expect(candidateType).not.toContain('todo');
    let prompt = '';
    const extractor = new CodexContextCandidateExtractor({ codex: { async executeJson(input) {
      prompt = input.prompt; return { candidates: [] };
    } } });
    await extractor.extract({ sources: [source], projects: [], existingRecords: [] });
    expect(prompt).toContain('纯一次性行动指令只进入 Todo，不生成 Context');
  });
});

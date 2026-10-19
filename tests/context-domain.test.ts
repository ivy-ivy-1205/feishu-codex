import { describe, expect, it } from 'vitest';
import { contextCandidateSchema } from '../src/domain/context.js';

const validCandidate = {
  candidateType: 'reported_progress',
  scope: 'project',
  summary: 'Phase 1E 已进入本地实现阶段',
  subjectKey: 'phase1e',
  structuredPayload: {},
  extractionConfidence: 0.82,
  factualStatus: 'reported',
  reviewStatus: 'pending'
} as const;

describe('Context domain', () => {
  it('keeps review status independent from factual status', () => {
    expect(contextCandidateSchema.parse({
      ...validCandidate,
      reviewStatus: 'approved',
      factualStatus: 'reported'
    })).toMatchObject({ reviewStatus: 'approved', factualStatus: 'reported' });
  });

  it.each([
    [{ ...validCandidate, candidateType: 'todo' }, 'candidate type'],
    [{ ...validCandidate, scope: 'task' }, 'scope'],
    [{ ...validCandidate, extractionConfidence: 1.01 }, 'confidence'],
    [{ ...validCandidate, suggestedRelation: 'replaces' }, 'relation']
  ])('rejects an invalid %s', (candidate, _label) => {
    expect(() => contextCandidateSchema.parse(candidate)).toThrow();
  });
});

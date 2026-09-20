import { describe, expect, it } from 'vitest';
import { AlignmentDetector } from '../src/services/alignment-detector.js';

const proposal = {
  topicId: 'topic-1', decisionKey: 'release', dimension: 'direction' as const,
  ivy: { evidenceId: 'ev-ivy', statement: '先做页面' },
  james: { evidenceId: 'ev-james', statement: '先做知识库' },
  actionConsequence: { evidenceId: 'ev-ivy', excerpt: '今天开始实施' },
  actionHorizon: { evidenceId: 'ev-ivy', excerpt: '今天',
    startsAt: '2026-09-21T00:00:00.000Z', endsAt: '2026-09-22T00:00:00.000Z' }
};

describe('AlignmentDetector', () => {
  it('only proposes stable candidates; repeated analysis cannot mark them ready or asked', () => {
    const detector = new AlignmentDetector();
    const first = detector.propose(proposal);
    expect(first.status).toBe('candidate');
    expect(first.id).toBe(detector.propose({ ...proposal }).id);
    expect(first.evidenceSetHash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.evidenceIds).toEqual(['ev-ivy', 'ev-james']);
    expect(detector.propose({ ...proposal, james: { ...proposal.james, evidenceId: 'ev-new' } }).id)
      .not.toBe(first.id);
  });

  it('rejects invented lifecycle, empty statements and unsupported dimensions at the boundary', () => {
    const detector = new AlignmentDetector();
    expect(() => detector.propose({ ...proposal, status: 'asked' })).toThrow();
    expect(() => detector.propose({ ...proposal, ivy: { evidenceId: 'ev-ivy', statement: '' } })).toThrow();
    expect(() => detector.propose({ ...proposal, dimension: 'personality' })).toThrow();
  });
});

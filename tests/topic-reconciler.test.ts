import { describe, expect, it } from 'vitest';
import { reconcileTopics } from '../src/services/topic-reconciler.js';
import type { FounderStreamAnalysis, FounderStreamInput, TopicProposal } from '../src/ports/founder-stream-analyzer.js';
import { sha256 } from '../src/services/canonical-json.js';

const oldText = '销售助手还在探索，先验证销售助手问答。';
const newText = '继续销售助手：交付销售助手试用版。我今天开始整理销售助手问答。';
function input(): FounderStreamInput {
  return { sources: [oldText, newText].map((contentText, index) => ({ id: `source-${index}`,
    sourceType: index === 0 ? 'group_message' : 'minute_transcript', sourceVersion: 1,
    contentText, contentHash: sha256(contentText), availabilityStatus: 'available' as const,
    occurredAt: '2026-09-20T10:00:00.000Z' })),
  currentTopics: [{ id: 'topic-sales', currentVersion: 2, displayName: '销售助手', stage: 'exploring',
    outcome: null, evidenceExcerpts: [{ sourceId: 'source-0', excerpt: oldText }] }] };
}
function proposal(): TopicProposal {
  return { displayName: '销售助手', stage: 'active_project', outcome: '交付销售助手试用版',
    currentAction: '我今天开始整理销售助手问答', confidence: 'high', sourceIds: ['source-1'],
    evidenceExcerpts: [{ sourceId: 'source-1', excerpt: newText }],
    joinDecision: { kind: 'exact_continuation', topicId: 'topic-sales', confidence: 'high', sharedTerms: ['销售助手'] },
    splitSuggestions: [] };
}
function reconcile(change: Partial<TopicProposal> = {}, supplied = input()) {
  return reconcileTopics(supplied, { topics: [{ ...proposal(), ...change }] });
}

describe('reconcileTopics', () => {
  it('auto-joins only exact high-confidence continuation and preserves old/new source mappings', () => {
    const result = reconcile();
    expect(result.topics).toEqual([expect.objectContaining({ action: 'join', topicId: 'topic-sales',
      expectedVersion: 2, sourceIds: ['source-0', 'source-1'], relations: [] })]);
    expect(result.topics[0]?.evidenceExcerpts).toEqual([
      { sourceId: 'source-0', excerpt: oldText }, { sourceId: 'source-1', excerpt: newText }
    ]);
  });

  it.each(['medium', 'low'] as const)('keeps %s-confidence topics separate with needs_confirmation', (confidence) => {
    const result = reconcile({ confidence });
    expect(result.topics[0]).toMatchObject({ action: 'create', topicId: null, expectedVersion: null,
      relations: [{ type: 'possible_continuation', topicId: 'topic-sales', status: 'needs_confirmation' }] });
  });

  it.each(['medium', 'low'] as const)('does not let high topic confidence override a %s join', (confidence) => {
    expect(reconcile({ joinDecision: { ...proposal().joinDecision, confidence } }).topics[0]?.action).toBe('create');
  });

  it('keeps a possible continuation separate even at high confidence', () => {
    expect(reconcile({ joinDecision: { ...proposal().joinDecision, kind: 'possible_continuation' } }).topics[0])
      .toMatchObject({ action: 'create', relations: [{ status: 'needs_confirmation' }] });
  });

  it('does not auto-join without a shared evidence term or with a renamed topic', () => {
    expect(reconcile({ joinDecision: { ...proposal().joinDecision, sharedTerms: [] } }).topics[0]?.action).toBe('create');
    expect(reconcile({ displayName: '销售助手问答' }).topics[0]?.action).toBe('create');
  });

  it('rejects invented shared terms instead of treating model confidence as evidence', () => {
    expect(() => reconcile({ joinDecision: { ...proposal().joinDecision, sharedTerms: ['不存在的产品'] } }))
      .toThrowError(expect.objectContaining({ code: 'FOUNDER_STREAM_OUTPUT_INVALID' }));
  });

  it('will not auto-join a closed topic', () => {
    const supplied = input();
    supplied.currentTopics = [{ ...supplied.currentTopics[0]!, stage: 'closed' }];
    expect(reconcile({}, supplied).topics[0]?.action).toBe('create');
  });

  it('does not infer a join based only on a name match', () => {
    const result = reconcile({ joinDecision: { kind: 'new', topicId: null, confidence: 'high', sharedTerms: [] } });
    expect(result.topics[0]).toMatchObject({ action: 'create', relations: [] });
  });

  it('returns a split suggestion as needs_confirmation without joining or mutating old topics', () => {
    const supplied = input();
    const before = JSON.stringify(supplied);
    const result = reconcile({ joinDecision: { kind: 'new', topicId: null, confidence: 'high', sharedTerms: [] },
      splitSuggestions: [{ topicId: 'topic-sales', confidence: 'high', rationale: '建议将问答拆成独立话题' }] }, supplied);
    expect(result.topics[0]).toMatchObject({ action: 'create', relations: [{ type: 'split_from',
      topicId: 'topic-sales', status: 'needs_confirmation' }] });
    expect(JSON.stringify(supplied)).toBe(before);
  });

  it('keeps competing proposals to one existing topic separate instead of order-dependent merging', () => {
    const first = proposal();
    const second = { ...proposal(), stage: 'exploring' as const };
    const result = reconcileTopics(input(), { topics: [first, second] });
    expect(result.topics.map((topic) => topic.action)).toEqual(['create', 'create']);
    expect(result.topics.map((topic) => topic.relations[0]?.status)).toEqual(['needs_confirmation', 'needs_confirmation']);
  });

  it('validates direct service callers rather than trusting a TypeScript cast', () => {
    expect(() => reconcileTopics(input(), { topics: [{ ...proposal(), sourceIds: ['invented'] }] } as FounderStreamAnalysis))
      .toThrowError(expect.objectContaining({ code: 'FOUNDER_STREAM_OUTPUT_INVALID' }));
  });

  it('rejects a current topic without supplied provenance and duplicate topic IDs', () => {
    const supplied = input();
    expect(() => reconcile({}, { ...supplied, currentTopics: [
      { ...supplied.currentTopics[0]!, evidenceExcerpts: [{ sourceId: 'not-supplied', excerpt: oldText }] }
    ] })).toThrowError(expect.objectContaining({ code: 'FOUNDER_STREAM_INPUT_INVALID' }));
    expect(() => reconcile({}, { ...supplied, currentTopics: [...supplied.currentTopics, ...supplied.currentTopics] }))
      .toThrowError(expect.objectContaining({ code: 'FOUNDER_STREAM_INPUT_INVALID' }));
  });
});

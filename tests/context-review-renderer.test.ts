import { describe, expect, it } from 'vitest';
import { renderContextReviewCard } from '../src/services/context-review-renderer.js';

const candidate = {
  id: 'ctxcand_1', candidateType: 'reported_progress' as const, scope: 'project' as const,
  summary: 'Phase 1E 已进入实现', factualStatus: 'reported' as const, reviewStatus: 'pending' as const,
  extractionConfidence: 0.82,
  projects: [{ projectKey: 'feishu-adaptor', role: 'primary' as const, mappingStatus: 'mapped' as const,
    confidence: 'low' as const, evidence: '会议提到 Phase 1E' }],
  evidence: [{ evidenceId: 'ev1', role: 'supporting' as const, excerpt: 'Phase 1E 已进入实现',
    sourceId: 'ctxsrc_1', sourceVersion: 1, sourceOccurredAt: '2026-08-03T01:00:00.000Z',
    evidenceLevel: 'primary_statement' as const }],
  suggestedRelations: [{ recordId: 'ctxrec_old', relationType: 'supplements' as const, rationale: '补充进度' }]
};

describe('renderContextReviewCard', () => {
  it('uses the legacy interactive-card envelope required by action buttons', () => {
    const card = renderContextReviewCard({ meetingTitle: 'Phase 1E 周会', extractionRunId: 'run1',
      candidates: [candidate], cardNonce: 'nonce-1' });
    expect(card).not.toHaveProperty('schema');
    expect(card).not.toHaveProperty('body');
    expect(card).toHaveProperty('elements');
    expect((card.elements as Array<Record<string, unknown>>).some((element) => element.tag === 'action')).toBe(true);
  });

  it('shows independent statuses, provenance and allowlisted action payloads', () => {
    const card = renderContextReviewCard({ meetingTitle: 'Phase 1E 周会', extractionRunId: 'run1',
      candidates: [candidate], cardNonce: 'nonce-1' });
    const serialized = JSON.stringify(card);
    expect(serialized).toContain('纳入 Context，保持当前事实状态');
    expect(serialized).toContain('reported');
    expect(serialized).toContain('项目映射置信度：low');
    expect(serialized).toContain('内容置信度：82%');
    expect(serialized).toContain('ctxsrc_1@v1');
    expect(serialized).toContain('supplements');
    expect(serialized).toContain('AI 建议，尚未确认');
    expect(serialized).not.toContain('contentText');

    const values = collectActionValues(card);
    expect(values).toContainEqual({ candidateId: 'ctxcand_1', action: 'approve_keep_status',
      expectedReviewStatus: 'pending', cardNonce: 'nonce-1' });
    expect(values.every((value) => Object.keys(value).sort().join(',') ===
      'action,candidateId,cardNonce,expectedReviewStatus')).toBe(true);
  });

  it('uses a server promotion intent only for an explicit relation action', () => {
    const card = renderContextReviewCard({ meetingTitle: '关系审核', extractionRunId: 'run1',
      candidates: [candidate], cardNonce: 'nonce-1', promotionIntents: [{
        id: `ctxpi_${'a'.repeat(32)}`, candidateId: candidate.id,
        targetRecordId: 'ctxrec_old', relationType: 'supplements'
      }] });
    const values = collectActionValues(card);
    expect(values.find((value) => value.action === 'approve_keep_status')).not.toHaveProperty('promotionIntentId');
    expect(values).toContainEqual({ candidateId: candidate.id, action: 'apply_suggested_relation',
      expectedReviewStatus: 'pending', cardNonce: 'nonce-1', promotionIntentId: `ctxpi_${'a'.repeat(32)}` });
  });

  it('does not offer overwrite-style approval for a conflict candidate', () => {
    const card = renderContextReviewCard({ meetingTitle: '冲突', extractionRunId: 'run1',
      candidates: [{ ...candidate, reviewStatus: 'conflict' }], cardNonce: 'nonce-1' });
    expect(collectActionValues(card).map((value) => value.action)).not.toContain('approve_keep_status');
  });

  it('offers explicit verification only for direct or authoritative evidence', () => {
    const primary = renderContextReviewCard({ meetingTitle: '口头来源', extractionRunId: 'run1',
      candidates: [candidate], cardNonce: 'nonce-1' });
    expect(collectActionValues(primary).map((value) => value.action)).not.toContain('approve_verified');
    const direct = renderContextReviewCard({ meetingTitle: '直接观察', extractionRunId: 'run1',
      candidates: [{ ...candidate, evidence: [{ ...candidate.evidence[0]!, evidenceLevel: 'direct_observation' }] }],
      cardNonce: 'nonce-1' });
    expect(collectActionValues(direct).map((value) => value.action)).toContain('approve_verified');
  });

  it('explains source-attested and reported without implying objective verification', () => {
    const card = renderContextReviewCard({ meetingTitle: '事实边界', extractionRunId: 'run1',
      candidates: [{ ...candidate, candidateType: 'decision', factualStatus: 'source_attested' }, candidate],
      cardNonce: 'nonce-1' });
    const serialized = JSON.stringify(card);
    expect(serialized).toContain('来源仅证明“有人这样陈述或作出决定”');
    expect(serialized).toContain('来源报告，尚未独立验证');
    expect(serialized).not.toContain('客观事实已验证');
  });

  it('bounds one card to twelve candidates', () => {
    expect(() => renderContextReviewCard({ meetingTitle: '过多', extractionRunId: 'run1',
      candidates: Array.from({ length: 13 }, (_, index) => ({ ...candidate, id: `c${index}` })),
      cardNonce: 'nonce-1' })).toThrow(/12/);
  });
});

function collectActionValues(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.flatMap(collectActionValues);
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  return [...(record.value && typeof record.value === 'object' ? [record.value as Record<string, unknown>] : []),
    ...Object.values(record).flatMap(collectActionValues)];
}

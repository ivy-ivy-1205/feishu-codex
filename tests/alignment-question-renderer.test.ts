import { describe, expect, it } from 'vitest';
import type { AlignmentIssue } from '../src/domain/alignment.js';
import { renderAlignmentQuestion, renderAlignmentResolution } from '../src/services/alignment-question-renderer.js';
import type { FounderCardEvidence } from '../src/services/founder-card.js';

const at = '2026-09-20T00:00:00.000Z';
const source = (id: string): FounderCardEvidence => ({ id, sourceId: `source-${id}`, sourceVersion: 1, occurredAt: at, excerpt: `原文 ${id}`,
  locator: { kind: 'group_message', sourceVersion: 1, contentHash: 'a'.repeat(64), chatId: 'oc_group', messageId: `om_${id}`, threadId: null, authorOpenId: `ou_${id}`, occurredAt: at }
});
const issue: AlignmentIssue = { id: 'issue-1', topicId: 'topic-1', decisionKey: 'landing', dimension: 'next_action',
  ivy: { evidenceId: 'ivy', statement: '先做页面' }, james: { evidenceId: 'james', statement: '先写文案' },
  actionConsequence: { evidenceId: 'ivy', excerpt: '今天开始做页面' }, actionHorizon: null,
  status: 'ready', evidenceIds: ['ivy', 'james'], evidenceSetHash: 'hash', createdAt: at, updatedAt: at, deliveredMessageId: null };

describe('alignment cards', () => {
  it('shows both founder source labels and only one concise natural-language answer request', () => {
    const rendered = renderAlignmentQuestion({ issue, topicName: '官网', evidence: [source('james'), source('ivy')] });
    expect(rendered.kind).toBe('alignment_question');
    const body = JSON.stringify(rendered.card);
    for (const value of ['Ivy', 'James', 'om_ivy', 'om_james', '2026-09-20', '先做页面', '先写文案', '自然语言']) expect(body).toContain(value);
    expect(body.match(/？/g)).toHaveLength(1);
    expect(body).not.toMatch(/ou_|evidenceSetHash|confidence|decisionKey/);
    expect(body).not.toContain('button');
  });

  it('fails closed without both exact source records or for non-actionable issue states', () => {
    expect(() => renderAlignmentQuestion({ issue, topicName: '官网', evidence: [source('ivy')] })).toThrow();
    for (const status of ['candidate', 'resolved', 'dismissed', 'stale'] as const) {
      expect(() => renderAlignmentQuestion({ issue: { ...issue, status }, topicName: '官网', evidence: [source('ivy'), source('james')] })).toThrow();
    }
  });

  it('supports traceable minute evidence and bounds displayed source text', () => {
    const minute = { ...source('james'), minuteToken:'obcn_fixture', excerpt: '文'.repeat(3000), locator: { kind: 'minute_segment' as const,
      sourceVersion: 1, contentHash: 'b'.repeat(64), segmentOrdinal: 7, speakerName: 'ou_private', startMs: 1000, endMs: 2000 } };
    const result = renderAlignmentQuestion({ issue, topicName: '官网', evidence: [source('ivy'), minute] });
    const body = JSON.stringify(result.card);
    expect(body).toContain('obcn_fixture');
    expect(body).not.toContain('source-james');
    expect(body).toContain('第 8 段');
    expect(body).not.toContain('文'.repeat(241));
    expect(body).not.toContain('ou_private');
  });

  it('renders resolved receipt with the actual agreement and both resolution sources', () => {
    const result = renderAlignmentResolution({ issue: { ...issue, status: 'resolved' }, topicName: '官网',
      resolution: { statement: '先写统一文案，再做页面预览', ivy: source('resolution-ivy'), james: source('resolution-james') } });
    expect(result.kind).toBe('alignment_resolution');
    const body = JSON.stringify(result.card);
    expect(body).toContain('先写统一文案，再做页面预览');
    expect(body).toContain('已对齐');
    expect(body).toContain('om_resolution-ivy');
    expect(body).toContain('om_resolution-james');
    expect(body).toContain('自然语言');
    expect(() => renderAlignmentResolution({ issue, topicName: '官网', resolution: { statement: '已对齐', ivy: source('a'), james: source('b') } })).toThrow();
  });
});

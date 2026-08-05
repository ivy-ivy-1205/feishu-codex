import type {
  ContextCandidateType, ContextEvidenceLevel, ContextEvidenceRole, ContextFactualStatus,
  ContextProjectConfidence, ContextProjectMappingStatus, ContextProjectRole,
  ContextRelationType, ContextReviewStatus, ContextScope
} from '../domain/context.js';
import type { ContextPromotionIntent } from '../repositories/outbox-repository.js';

export interface ContextReviewCardCandidate {
  id: string;
  candidateType: ContextCandidateType;
  scope: ContextScope;
  summary: string;
  factualStatus: ContextFactualStatus;
  reviewStatus: ContextReviewStatus;
  extractionConfidence: number;
  projects: Array<{ projectKey: string | null; role: ContextProjectRole;
    mappingStatus: ContextProjectMappingStatus; confidence: ContextProjectConfidence; evidence: string }>;
  evidence: Array<{ evidenceId: string; role: ContextEvidenceRole; excerpt: string; sourceId: string;
    sourceVersion: number; sourceOccurredAt: string; evidenceLevel: ContextEvidenceLevel }>;
  suggestedRelations: Array<{ recordId: string; relationType: ContextRelationType; rationale: string }>;
}

export function renderContextReviewCard(input: {
  meetingTitle: string;
  extractionRunId: string;
  candidates: readonly ContextReviewCardCandidate[];
  cardNonce: string;
  promotionIntents?: readonly ContextPromotionIntent[];
}): Record<string, unknown> {
  if (input.candidates.length > 12) throw new Error('one Context review card supports at most 12 candidates');
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: { template: 'blue', title: { tag: 'plain_text', content: `${input.meetingTitle} · Context 审核（${input.candidates.length}）` } },
    body: { elements: input.candidates.flatMap((candidate, index) => renderCandidate(candidate, index + 1,
      input.cardNonce, input.promotionIntents ?? [])) }
  };
}

function renderCandidate(candidate: ContextReviewCardCandidate, number: number, cardNonce: string,
  promotionIntents: readonly ContextPromotionIntent[]): Record<string, unknown>[] {
  const primaryProject = candidate.projects.find((project) => project.role === 'primary') ?? null;
  const evidence = candidate.evidence.find((item) => item.role === 'supporting') ?? candidate.evidence[0];
  const relationText = candidate.suggestedRelations.length > 0
    ? candidate.suggestedRelations.map((relation) =>
      `${relation.relationType} → ${relation.recordId}（${relation.rationale}）`).join('；')
    : null;
  const facts = [
    `**#${number} · ${candidateTypeLabels[candidate.candidateType]} · ${candidate.scope}**`,
    `项目：${primaryProject?.projectKey ?? '未映射'}；项目映射状态：${primaryProject?.mappingStatus ?? 'unmapped'}；项目映射置信度：${primaryProject?.confidence ?? 'low'}`,
    `事实状态：${factualStatusLabels[candidate.factualStatus]}；内容置信度：${Math.round(candidate.extractionConfidence * 100)}%`,
    `候选内容：${candidate.summary}`,
    evidence ? `原始证据：${evidence.excerpt}` : '原始证据：缺失（不可批准）',
    evidence ? `来源：${evidence.sourceId}@v${evidence.sourceVersion}；来源时间：${evidence.sourceOccurredAt}` : '',
    relationText ? `AI 建议，尚未确认：${relationText}` : '关系：默认创建新的独立 Context Record'
  ].filter(Boolean).join('\n');
  const actionValue = (action: string) => ({
    candidateId: candidate.id, action, expectedReviewStatus: candidate.reviewStatus, cardNonce
  });
  const actions: Record<string, unknown>[] = [];
  if (candidate.reviewStatus !== 'conflict' && evidence) {
    actions.push({ tag: 'button', type: 'primary', text: { tag: 'plain_text', content: '纳入 Context，保持当前事实状态' }, value: actionValue('approve_keep_status') });
    if (candidate.evidence.some((item) =>
      item.evidenceLevel === 'direct_observation' || item.evidenceLevel === 'authoritative_record')) {
      actions.push({ tag: 'button', type: 'default', text: { tag: 'plain_text', content: '纳入 Context，并明确标记为证据已验证' }, value: actionValue('approve_verified') });
    }
  }
  for (const intent of promotionIntents.filter((item) => item.candidateId === candidate.id)) {
    actions.push({ tag: 'button', type: intent.relationType === 'conflicts_with' ? 'danger' : 'default',
      text: { tag: 'plain_text', content: `明确采用关系：${relationLabels[intent.relationType]}` },
      value: { ...actionValue('apply_suggested_relation'), promotionIntentId: intent.id } });
  }
  actions.push(
    { tag: 'button', type: 'default', text: { tag: 'plain_text', content: '拒绝' }, value: actionValue('reject') },
    { tag: 'button', type: 'default', text: { tag: 'plain_text', content: '要求澄清' }, value: actionValue('request_clarification') },
    { tag: 'button', type: 'danger', text: { tag: 'plain_text', content: '识别冲突' }, value: actionValue('mark_conflict') }
  );
  return [
    { tag: 'markdown', content: facts },
    { tag: 'action', actions },
    { tag: 'hr' }
  ];
}

const candidateTypeLabels: Record<ContextCandidateType, string> = {
  proposal: '提议', decision: '决定', reported_progress: '口头进展', claim: '待验证陈述',
  risk: '风险', blocker: '阻塞', requirement: '需求/约束', status_update: '状态变化',
  action_item: '长期行动承诺'
};

const relationLabels: Record<ContextRelationType, string> = {
  supplements: '补充', confirms: '确认', corrects: '纠正', supersedes: '取代',
  conflicts_with: '冲突', duplicates: '重复'
};

const factualStatusLabels: Record<ContextFactualStatus, string> = {
  source_attested: 'source_attested（来源仅证明“有人这样陈述或作出决定”，不代表内含事实为真）',
  reported: 'reported（来源报告，尚未独立验证）',
  reviewer_confirmed: 'reviewer_confirmed（Ivy 已明确确认）',
  evidence_verified: 'evidence_verified（已有直接或权威证据）',
  disputed: 'disputed（存在未解决争议）'
};

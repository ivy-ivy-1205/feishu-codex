import { AlignmentIssueRepository } from '../repositories/alignment-issue-repository.js';
import { OutboxRepository, type FounderWorkMapMessage } from '../repositories/outbox-repository.js';
import { applyTopicCorrection, findFeedbackReplay, founderFeedbackInputSchema, staleFeedback, topicCorrectionSchema,
  type FounderFeedbackDecision, type FounderFeedbackDependencies, type TopicCorrection } from './topic-correction-service.js';
import type { TopicStage } from '../domain/topic.js';
import { confirmFounderBatchCorrection, draftFounderBatchCorrection } from './founder-batch-correction.js';

export type { FounderFeedbackDecision, FounderFeedbackDependencies } from './topic-correction-service.js';

/** Deterministic, bounded grammar: uncertain language is clarification, never guessed as consent. */
export function routeFounderFeedback(raw: unknown, dependencies: FounderFeedbackDependencies): FounderFeedbackDecision {
  const parsed = founderFeedbackInputSchema.safeParse(raw);
  if (!parsed.success) return { kind: 'reject', reason: 'invalid_input' };
  const input = parsed.data;
  if (!dependencies.approvedChatIds.includes(input.chatId)) return { kind: 'reject', reason: 'wrong_chat' };
  if (!dependencies.client.prepare("SELECT id FROM founder_identities WHERE source_system = 'feishu' AND external_author_id = ?").get(input.openId)) {
    return { kind: 'reject', reason: 'unknown_founder' };
  }
  const replay = findFeedbackReplay(input, dependencies.client); if (replay) return replay;
  const confirmation=input.text.normalize('NFKC').trim().match(/^确认修正\s+(feedbackdraft_[a-f0-9]{32})$/u);
  if(confirmation)return confirmFounderBatchCorrection(input,confirmation[1]!,dependencies);
  if (!input.replyTo) return { kind: 'clarify', reason: 'missing_reply_context', text: '请在对应工作地图或对齐问题卡片下回复，方便确认你指的是哪件事。' };
  const binding = new OutboxRepository(dependencies.client).findDeliveredFounderMessage(input.chatId, input.replyTo);
  if (!binding) return { kind: 'reject', reason: 'unrelated_message' };
  const text = input.text.normalize('NFKC').trim().replace(/[。!！]$/u, '');
  let correction: TopicCorrection | null = null;
  if (binding.kind === 'founder_work_map') {
    const batch=draftFounderBatchCorrection(input,binding,dependencies);if(batch)return batch;
    correction = parseTopicCorrection(text, binding);
  }
  else {
    const issue = new AlignmentIssueRepository(dependencies.client).get(binding.issueId);
    if (!issue || issue.status !== 'asked' || issue.deliveredMessageId !== input.replyTo || issue.evidenceSetHash !== binding.evidenceSetHash) return staleFeedback();
    const ref = { id: issue.id, expectedStatus: 'asked' as const, expectedUpdatedAt: issue.updatedAt };
    if (/^(?:这个问题)?(?:不用提醒|不需要提醒|停止提醒|忽略这个分歧)$/u.test(text)) correction = { kind: 'dismiss_alignment', issue: ref };
    else if (isExplicitSupportWithdrawal(text)) correction = { kind: 'resolve_alignment', issue: ref,
      statement: input.text, speechAct: 'explicit_disagreement' };
    else if (/^(?:(?:我)?同意[，,\s]*)?(?:按.+(?:推进|执行|实施|处理|做)|(?:采用|执行|选择).+)$/u.test(text) &&
      !/(?:如果|除非|但是|不过|不同意|不要|不应|取消|撤回|[“”"‘’]|说|表示|\?)/u.test(text)) {
      correction = { kind: 'resolve_alignment', issue: ref, statement: input.text,
        speechAct: /^(?:我)?同意/u.test(text) ? 'explicit_agreement' : 'decision_proposal' };
    }
  }
  if (!correction || !topicCorrectionSchema.safeParse(correction).success) return { kind: 'clarify', reason: 'ambiguous_feedback', text: '请说明条目编号和要如何调整；对齐问题请写出明确方案，例如“按 A 方案推进”。' };
  return applyTopicCorrection(input, correction, dependencies);
}

function isExplicitSupportWithdrawal(text: string): boolean {
  if (/(?:如果|假如|除非|前提|[“”"‘’]|说|表示|转述|\?|？)/u.test(text)) return false;
  return /^(?:我)?(?:撤回|取消)(?:(?:我)?(?:刚才|之前|原先)?(?:的)?[^，,;；]{0,80}(?:方案|提案|决定|观点|同意|支持))?(?:[，,]先?不要.+)?$/u.test(text) ||
    /^(?:我)?(?:不同意|不赞成|不再支持|不再同意)$/u.test(text) ||
    /^(?:我)?(?:不同意|不赞成|不再支持|不再同意|不要|不能|不应)(?:按.+(?:推进|执行|实施|处理|做)|[^，,;；]{0,80}(?:方案|提案|决定|观点))$/u.test(text);
}

function parseTopicCorrection(text: string, binding: FounderWorkMapMessage): TopicCorrection | null {
  const refs = binding.itemRefs.filter((item) => item.kind === 'topic');
  const ref = (number: string | undefined) => {
    const item = number ? refs.find((r) => r.displayedNumber === Number(number)) : refs.length === 1 ? refs[0] : undefined;
    return item && item.expectedVersion ? { id: item.id, expectedVersion: item.expectedVersion } : null;
  };
  const merge = text.match(/^(?:第\s*)?([1-9]\d*)\s*(?:项)?\s*(?:和|与|、)\s*(?:第\s*)?([1-9]\d*)\s*(?:项)?\s*是同一个(?:项目|话题)$/u);
  if (merge) { const a = ref(merge[1]), b = ref(merge[2]); return a && b && a.id !== b.id ? { kind: 'merge_topics', topics: [a, b] } : null; }
  const single = text.match(/^(?:(?:第\s*)?([1-9]\d*)\s*项\s*|这个)(.+)$/u);
  if (single) {
    const target = ref(single[1]); if (!target) return null;
    const command = single[2]!;
    if (/^(?:只是想法[，,]?\s*(?:还不是项目)?|只是想法)$/u.test(command)) return { kind: 'reclassify_stage', topic: target, stage: 'idea' };
    const stage = command.match(/^改为(想法|探索中|候选项目|正在推进|已结束)$/u)?.[1];
    const stages: Record<string, TopicStage> = { 想法: 'idea', 探索中: 'exploring', 候选项目: 'project_candidate', 正在推进: 'active_project', 已结束: 'closed' };
    if (stage) return { kind: 'reclassify_stage', topic: target, stage: stages[stage]! };
    const rename = command.match(/^改名为\s*(.{1,80})$/u)?.[1]?.trim();
    if (rename) return { kind: 'rename_topic', topic: target, name: rename };
    const split = command.match(/^拆分为\s*(.{1,80}?)\s+和\s+(.{1,80})$/u);
    if (split && split[1]!.trim() !== split[2]!.trim()) return { kind: 'split_topic', topic: target, names: [split[1]!.trim(), split[2]!.trim()] };
  }
  const pause = text.match(/^暂停(?:第\s*)?([1-9]\d*)\s*项$/u);
  const target = pause ? ref(pause[1]) : null;
  return target ? { kind: 'pause_topic', topic: target } : null;
}

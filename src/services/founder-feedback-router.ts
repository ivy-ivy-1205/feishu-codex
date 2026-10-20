import { AlignmentIssueRepository } from '../repositories/alignment-issue-repository.js';
import { OutboxRepository, type FounderWorkMapMessage } from '../repositories/outbox-repository.js';
import { applyTopicCorrection, findFeedbackReplay, founderFeedbackInputSchema, staleFeedback, topicCorrectionSchema,
  type FounderFeedbackDecision, type FounderFeedbackDependencies, type TopicCorrection } from './topic-correction-service.js';
import type { TopicStage } from '../domain/topic.js';
import { confirmFounderBatchCorrection, draftFounderBatchCorrection } from './founder-batch-correction.js';
import { founderCommandText } from './founder-command-text.js';
import { TopicRepository } from '../repositories/topic-repository.js';

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
  const text = founderCommandText(input.text), outbox = new OutboxRepository(dependencies.client);
  // A draft is confirmed by its id, or by a plain 确认 replying to the message that proposed it; never by a bare 确认.
  const confirmation = text.match(/^确认(?:修正)?\s*(feedbackdraft_[a-f0-9]{32})?$/u);
  const draftId = confirmation ? confirmation[1] ?? (input.replyTo ? outbox.findDeliveredFeedbackDraftId(input.chatId, input.replyTo) : null) : null;
  if (draftId) return confirmFounderBatchCorrection(input, draftId, dependencies);
  if (!input.replyTo) return { kind: 'clarify', reason: 'missing_reply_context', text: '请在对应工作地图或对齐问题卡片下回复，方便确认你指的是哪件事。' };
  const binding = outbox.findDeliveredFounderMessage(input.chatId, input.replyTo);
  if (!binding) return { kind: 'reject', reason: 'unrelated_message' };
  let correction: TopicCorrection | null = null;
  if (binding.kind === 'founder_work_map') {
    const batch=draftFounderBatchCorrection(input,binding,dependencies);if(batch)return batch;
    const names = new Map(new TopicRepository(dependencies.client).listCurrentTopics().map((topic) => [topic.id, topic.displayName]));
    // Match on normalized text but keep a written reason in the founder's own punctuation.
    const original = founderCommandText(input.text, false);
    const verbatim = (value: string) => { const tail = original.slice(original.length - value.length);
      return tail.normalize('NFKC') === value ? tail : value; };
    correction = parseTopicCorrection(text, binding, (id) => names.get(id), verbatim);
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

/**
 * One numbered item per message. Founders write naturally, so the item's own name may be echoed after the
 * number and a short reason may follow a pause or close; anything naming another item or asking a question
 * stays a clarification.
 */
function parseTopicCorrection(text: string, binding: FounderWorkMapMessage, nameOf: (id: string) => string | undefined,
  verbatim: (value: string) => string = (value) => value): TopicCorrection | null {
  const refs = binding.itemRefs.filter((item) => item.kind === 'topic');
  const ref = (number: string | undefined) => {
    const item = number ? refs.find((r) => r.displayedNumber === Number(number)) : refs.length === 1 ? refs[0] : undefined;
    return item && item.expectedVersion ? { id: item.id, expectedVersion: item.expectedVersion } : null;
  };
  const merge = text.match(/^(?:第\s*)?([1-9]\d*)\s*(?:项)?\s*(?:和|与|、)\s*(?:第\s*)?([1-9]\d*)\s*(?:项)?\s*是同一个(?:项目|话题)$/u);
  if (merge) { const a = ref(merge[1]), b = ref(merge[2]); return a && b && a.id !== b.id ? { kind: 'merge_topics', topics: [a, b] } : null; }
  const separators = /^[\s·|｜:：，,、;；-]+/u;
  const withoutName = (rest: string, id: string) => {
    let value = rest.replace(separators, '');
    const name = nameOf(id)?.trim();
    if (name && value.startsWith(name)) value = value.slice(name.length);
    return value.replace(separators, '').trim();
  };
  const ambiguous = (value: string) => /(?:第\s*\d+\s*项|#\s*\d+|^[和与及]|[?？]|吗$)/u.test(value);
  const pauseFirst = text.match(/^暂停\s*(?:第\s*|#\s*)?([1-9]\d*)\s*项?([\s\S]*)$/u);
  if (pauseFirst) {
    const target = ref(pauseFirst[1]); if (!target) return null;
    const reason = withoutName(pauseFirst[2]!, target.id);
    if (ambiguous(reason)) return null;
    return { kind: 'pause_topic', topic: target, ...(reason ? { outcome: verbatim(reason).slice(0, 800) } : {}) };
  }
  const single = text.match(/^(?:(?:第\s*)?([1-9]\d*)\s*项|#\s*([1-9]\d*)|这个)([\s\S]+)$/u);
  if (!single) return null;
  const target = ref(single[1] ?? single[2]); if (!target) return null;
  const command = withoutName(single[3]!, target.id);
  if (/^(?:只是想法[，,]?\s*(?:还不是项目)?|只是想法)$/u.test(command)) return { kind: 'reclassify_stage', topic: target, stage: 'idea' };
  const stage = command.match(/^改为(想法|探索中|候选项目|正在推进)$/u)?.[1];
  const stages: Record<string, TopicStage> = { 想法: 'idea', 探索中: 'exploring', 候选项目: 'project_candidate', 正在推进: 'active_project' };
  if (stage) return { kind: 'reclassify_stage', topic: target, stage: stages[stage]! };
  const rename = command.match(/^改名为\s*(.{1,80})$/u)?.[1]?.trim();
  if (rename) return { kind: 'rename_topic', topic: target, name: rename };
  const split = command.match(/^拆分为\s*(.{1,80}?)\s+和\s+(.{1,80})$/u);
  if (split && split[1]!.trim() !== split[2]!.trim()) return { kind: 'split_topic', topic: target, names: [split[1]!.trim(), split[2]!.trim()] };
  if (ambiguous(command)) return null;
  const close = command.match(/^(?:(?:改为|标注为|标为|设为)\s*)?已?(?:结束|关闭)(?:[，,。；;:：\s]+([\s\S]+))?$/u);
  if (close) return { kind: 'reclassify_stage', topic: target, stage: 'closed', ...(close[1]?.trim() ? { outcome: verbatim(close[1].trim()).slice(0, 800) } : {}) };
  const pause = command.match(/^(?:(?:改为|标注为|标为|设为)\s*)?暂停(?:[，,。；;:：\s]+([\s\S]+))?$/u);
  if (pause) return { kind: 'pause_topic', topic: target, ...(pause[1]?.trim() ? { outcome: verbatim(pause[1].trim()).slice(0, 800) } : {}) };
  return null;
}

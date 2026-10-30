import { AlignmentIssueRepository } from '../repositories/alignment-issue-repository.js';
import { AlignmentJudgementRepository, spaceJudgementKey, type AlignmentJudgementSection,
  type AlignmentJudgementVerdict } from '../repositories/alignment-judgement-repository.js';
import { ContextSourceRepository } from '../repositories/context-source-repository.js';
import { captureGroupMessageSource } from './group-message-source-capture.js';
import { stableId } from './canonical-json.js';
import { founderText } from './founder-card.js';
import { feedbackHash, findFeedbackReplay, type FounderFeedbackDecision, type FounderFeedbackDependencies,
  type FounderFeedbackInput } from './topic-correction-service.js';

/** One numbered line of a delivered 查看分歧 card: a group-chat alignment issue or a Space page paragraph. */
export type FounderAlignmentItemRef = { displayedNumber: number; section: AlignmentJudgementSection; topicId: string;
  project: string; text: string } & (
  | { kind: 'alignment_issue'; issueId: string; expectedStatus: 'candidate' | 'ready' | 'asked'; expectedUpdatedAt: string }
  | { kind: 'space_item'; projectKey: string; blockId: string });

export interface FounderAlignmentOverviewMessage { kind: 'alignment_overview'; targetChatId: string; refs: FounderAlignmentItemRef[] }

export interface AlignmentJudgementCommand { displayedNumber: number; verdict: AlignmentJudgementVerdict; statement: string | null }

export const alignmentReplyGuide = '回复本卡片处理（可多行，一行一条）：第 N 条 已解决：结论 ／ 第 N 条 不是分歧（待决定可写「不用决定」）';

const resolvedWords = /^(?:已解决|解决了|已决定|决定了)/u, dismissedWords = /^(?:不是分歧|不算分歧|不用决定|不需要决定|忽略)/u;

/**
 * Ivy 2026-10-30: replies to 查看分歧 are written naturally — "第 2 条 已解决：按 A 方案", "2 已解决", "#3 不是分歧",
 * "第4、5条 不用决定", several lines at once. Every line must read as one of these, or nothing is applied.
 */
export function parseAlignmentJudgements(text: string): AlignmentJudgementCommand[] | null {
  const commands: AlignmentJudgementCommand[] = [];
  for (const raw of text.normalize('NFKC').split('\n')) {
    const line = raw.trim(); if (!line) continue;
    const match = /^(?:第\s*)?#?\s*(\d+(?:\s*(?:、|,|和|与|及)\s*(?:第\s*)?#?\s*\d+)*)\s*(?:条|项)?\s*[:,]?\s*(.+)$/u.exec(line);
    if (!match) return null;
    const rest = match[2]!.trim(), resolved = resolvedWords.exec(rest), dismissed = dismissedWords.exec(rest);
    const word = resolved ?? dismissed; if (!word) return null;
    const tail = rest.slice(word[0].length).replace(/^[\s:,。;]+/u, '').trim();
    if (/[?？吗]$/u.test(rest)) return null;
    for (const number of match[1]!.match(/\d+/gu)!) {
      const displayedNumber = Number(number);
      if (commands.some((command) => command.displayedNumber === displayedNumber)) return null;
      commands.push({ displayedNumber, verdict: resolved ? 'resolved' : 'not_divergence', statement: tail || null });
    }
  }
  return commands.length ? commands : null;
}

/**
 * Applies a whole reply in one transaction: each line closes a group-chat issue (已解决 → resolved, 不是分歧 → dismissed)
 * or settles a Space paragraph, and the reply is stored as evidence. One founder's word is enough (Ivy 2026-10-30); the
 * record names who settled it. Never executes Todos or sends anything beyond the reply acknowledgement.
 */
export function applyAlignmentJudgements(input: FounderFeedbackInput, binding: FounderAlignmentOverviewMessage,
  commands: readonly AlignmentJudgementCommand[], dependencies: FounderFeedbackDependencies): FounderFeedbackDecision {
  const { client } = dependencies;
  try {
    return client.transaction(() => {
      const replay = findFeedbackReplay(input, client); if (replay) return replay;
      const founder = (client.prepare("SELECT founder FROM founder_identities WHERE source_system = 'feishu' AND external_author_id = ?")
        .get(input.openId) as { founder: 'ivy' | 'james' } | undefined)?.founder;
      if (!founder) return { kind: 'reject', reason: 'unknown_founder' } as const;
      const issues = new AlignmentIssueRepository(client), judgements = new AlignmentJudgementRepository(client);
      const targets = commands.map((command) => ({ command, ref: binding.refs.find((ref) => ref.displayedNumber === command.displayedNumber) }));
      if (targets.some((target) => !target.ref)) return { kind: 'clarify', reason: 'ambiguous_feedback',
        text: `这张卡上没有第 ${targets.filter((target) => !target.ref).map((target) => target.command.displayedNumber).join('、')} 条。${alignmentReplyGuide}` } as const;
      const now = dependencies.now();
      const captured = captureGroupMessageSource({ chatId: input.chatId, messageId: input.messageId, threadId: input.threadId ?? null,
        rootId: input.rootId ?? null, author: { openId: input.openId, displayName: null }, messageType: 'text', senderType: 'user',
        text: input.text, occurredAt: input.occurredAt }, now);
      const sources = new ContextSourceRepository(client), source = sources.saveSource(captured.source).source;
      const evidence = sources.saveEvidence({ sourceId: source.id, excerpt: input.text, locator: { ...captured.messageLocator,
        threadId: typeof source.metadata.threadId === 'string' ? source.metadata.threadId : null, sourceVersion: source.sourceVersion,
        contentHash: source.contentHash }, evidenceLevel: 'primary_statement', capturedAt: now }).evidence;
      const lines: string[] = [];
      for (const { command, ref } of targets as { command: AlignmentJudgementCommand; ref: FounderAlignmentItemRef }[]) {
        const itemKey = ref.kind === 'alignment_issue' ? ref.issueId : spaceJudgementKey(ref.projectKey, ref.blockId);
        if (ref.kind === 'alignment_issue') {
          const issue = issues.get(ref.issueId);
          if (!issue || issue.status !== ref.expectedStatus || issue.updatedAt !== ref.expectedUpdatedAt) throw new StaleAlignmentCard();
          issues.close({ issueId: issue.id, expectedStatus: ref.expectedStatus, status: command.verdict === 'resolved' ? 'resolved' : 'dismissed',
            changedAt: now });
        }
        if (!judgements.record({ chatId: input.chatId, itemKind: ref.kind, itemKey, topicId: ref.topicId, projectName: ref.project,
          itemText: ref.text, section: ref.section, verdict: command.verdict, statement: command.statement, founder, evidenceId: evidence.id,
          sourceMessageId: input.messageId, bindingMessageId: input.replyTo!, createdAt: now.toISOString() })) throw new StaleAlignmentCard();
        const done = ref.section === 'decision' ? '已决定' : '已解决';
        lines.push(command.verdict === 'resolved'
          ? `第 ${command.displayedNumber} 条（${ref.project}）：记为${done}${command.statement ? `，结论：${founderText(command.statement, 80)}` : ''}`
          : `第 ${command.displayedNumber} 条（${ref.project}）：不再列出，原始记录保留`);
      }
      const result: FounderFeedbackDecision = { kind: 'corrected', correctionKind: 'alignment_judgement', status: 'applied',
        text: `已记录（${founder === 'ivy' ? 'Ivy' : 'James'}）：\n${lines.join('\n')}\n不会自动执行任务。` };
      client.prepare(`INSERT INTO founder_feedback_corrections
        (id, chat_id, source_message_id, author_open_id, binding_message_id, evidence_id, input_hash, correction_json, result_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(stableId('feedback', `${input.chatId}\n${input.messageId}`), input.chatId, input.messageId,
        input.openId, input.replyTo, evidence.id, feedbackHash(input), JSON.stringify({ kind: 'alignment_judgement', commands }),
        JSON.stringify(result), now.toISOString());
      return result;
    }).immediate();
  } catch (error) {
    if (error instanceof StaleAlignmentCard || (error instanceof Error && error.message === 'ALIGNMENT_ISSUE_CONFLICT')) {
      return { kind: 'clarify', reason: 'stale_context', text: '这张卡对应的内容已更新，请重新发送「查看分歧」后再回复。' };
    }
    throw error;
  }
}

class StaleAlignmentCard extends Error {}

import type { AlignmentIssue } from '../domain/alignment.js';
import { founderCard, founderSourceText, founderText, type FounderCardEvidence } from './founder-card.js';

const dimensions: Record<AlignmentIssue['dimension'], string> = {
  direction: '方向', next_action: '下一步行动', owner: '负责人', deadline: '时间安排', completion_standard: '完成标准'
};

export function renderAlignmentQuestion(input: { issue: AlignmentIssue; topicName: string; evidence: readonly FounderCardEvidence[] }): {
  kind: 'alignment_question'; issueId: string; evidenceSetHash: string; card: Record<string, unknown>
} {
  if (!['ready', 'asked'].includes(input.issue.status)) throw new Error('alignment question requires a ready or asked issue');
  const find = (id: string) => {
    const matches = input.evidence.filter((source) => source.id === id);
    if (matches.length !== 1) throw new Error('alignment question requires both exact source records');
    return matches[0]!;
  };
  const ivy = find(input.issue.ivy.evidenceId), james = find(input.issue.james.evidenceId);
  if (ivy.id === james.id) throw new Error('alignment question requires distinct founder sources');
  return {
    kind: 'alignment_question', issueId: input.issue.id, evidenceSetHash: input.issue.evidenceSetHash,
    card: founderCard(`需要对齐 · ${founderText(input.topicName, 80)}`, [
      `待对齐：${dimensions[input.issue.dimension]}。以下是双方已表达的理解，不代表共同决定。`,
      `Ivy：${founderText(input.issue.ivy.statement, 240)}\n${founderSourceText(ivy)}`,
      `James：${founderText(input.issue.james.statement, 240)}\n${founderSourceText(james)}`,
      ...(input.issue.actionConsequence ? [`对推进的影响：${founderText(input.issue.actionConsequence.excerpt, 240)}`] : []),
      `这件事的${dimensions[input.issue.dimension]}最终按什么推进？\n可直接在本卡下用自然语言回复你认可的方案或纠正理解，无需点击按钮。`
    ], 'orange')
  };
}

export function renderAlignmentResolution(input: { issue: AlignmentIssue; topicName: string;
  resolution: { statement: string; ivy: FounderCardEvidence; james: FounderCardEvidence }
}): { kind: 'alignment_resolution'; issueId: string; card: Record<string, unknown> } {
  if (input.issue.status !== 'resolved' || !input.resolution.statement.trim() || input.resolution.ivy.id === input.resolution.james.id) {
    throw new Error('resolved issue and distinct founder resolution evidence are required');
  }
  return { kind: 'alignment_resolution', issueId: input.issue.id,
    card: founderCard(`已对齐 · ${founderText(input.topicName, 80)}`, [
      `已对齐的${dimensions[input.issue.dimension]}：${founderText(input.resolution.statement, 1000)}`,
      `Ivy 确认来源\n${founderSourceText(input.resolution.ivy)}`,
      `James 确认来源\n${founderSourceText(input.resolution.james)}`,
      '该问题已记为解决；仅更新共同理解，不会自动执行任务。若有偏差，可在本卡下用自然语言回复纠正。'
    ], 'green') };
}

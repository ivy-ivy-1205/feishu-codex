import { describe, expect, it } from 'vitest';
import { CodexFounderStreamAnalyzer, founderStreamOutputJsonSchema } from '../src/adapters/codex-founder-stream-analyzer.js';
import type { FounderStreamInput, TopicProposal } from '../src/ports/founder-stream-analyzer.js';
import { sha256 } from '../src/services/canonical-json.js';

const ideaText = '也许可以做买家知识库，先想想，还没有决定要做。';
const discussionText = '上次讨论的销售助手，目标是交付销售助手试用版。';
const commitmentText = '继续销售助手：交付销售助手试用版。我今天开始整理销售助手问答，周五给大家测试。';
function source(id: string, contentText: string, sourceType = 'group_message') {
  return { id, sourceType, sourceVersion: 1, contentHash: sha256(contentText), contentText,
    availabilityStatus: 'available' as const, occurredAt: '2026-09-20T10:00:00.000Z' };
}
function input(): FounderStreamInput {
  return { sources: [source('idea', ideaText), source('discussion', discussionText),
    source('commitment', commitmentText, 'minute_transcript')], currentTopics: [] };
}
function proposal(): TopicProposal {
  return { displayName: '销售助手', stage: 'active_project', outcome: '交付销售助手试用版',
    currentAction: '我今天开始整理销售助手问答', confidence: 'high',
    sourceIds: ['discussion', 'commitment'], evidenceExcerpts: [
      { sourceId: 'discussion', excerpt: discussionText },
      { sourceId: 'commitment', excerpt: commitmentText }
    ], joinDecision: { kind: 'new', topicId: null, confidence: 'high', sharedTerms: [] },
    splitSuggestions: [] };
}
function analyzer(output: unknown) {
  return new CodexFounderStreamAnalyzer({ codex: { async executeJson() { return output; } } });
}

describe('CodexFounderStreamAnalyzer', () => {
  it('keeps an unformed idea while accepting an evidenced outcome and current work commitment', async () => {
    const result = await analyzer({ topics: [
      { ...proposal(), displayName: '买家知识库', stage: 'idea', outcome: null, currentAction: null,
        sourceIds: ['idea'], evidenceExcerpts: [{ sourceId: 'idea', excerpt: ideaText }] }, proposal()
    ] }).analyze(input());
    expect(result.topics.map(({ displayName, stage }) => ({ displayName, stage }))).toEqual([
      { displayName: '买家知识库', stage: 'idea' }, { displayName: '销售助手', stage: 'active_project' }
    ]);
  });

  it.each(['idea', 'exploring', 'project_candidate', 'active_project', 'paused', 'closed'] as const)(
    'accepts the exact lifecycle stage %s', async (stage) => {
      expect((await analyzer({ topics: [{ ...proposal(), stage }] }).analyze(input())).topics[0]?.stage)
        .toBe(stage);
    });

  it.each([
    ['invented source', { sourceIds: ['not-supplied'] }],
    ['no source', { sourceIds: [] }],
    ['uncited listed source', { sourceIds: ['discussion', 'commitment', 'idea'] }],
    ['unlisted excerpt source', { sourceIds: ['commitment'] }],
    ['invented excerpt', { evidenceExcerpts: [{ sourceId: 'commitment', excerpt: '项目已经上线了' }] }],
    ['missing excerpts', { evidenceExcerpts: [] }],
    ['unknown stage', { stage: 'ongoing' }],
    ['unknown confidence', { confidence: 0.99 }],
    ['missing outcome', { outcome: null }],
    ['missing current action', { currentAction: null }],
    ['ungrounded outcome', { outcome: '完成企业上市' }],
    ['ungrounded action', { currentAction: '现在执行部署' }],
    ['unknown field', { projectKey: 'legacy' }],
    ['invalid join target', { joinDecision: { kind: 'exact_continuation', topicId: 'invented', confidence: 'high', sharedTerms: ['销售助手'] } }],
    ['new decision with target', { joinDecision: { kind: 'new', topicId: 'invented', confidence: 'high', sharedTerms: [] } }],
    ['split invented topic', { splitSuggestions: [{ topicId: 'invented', confidence: 'high', rationale: '拆分' }] }]
  ])('fails closed for %s', async (_label, change) => {
    await expect(analyzer({ topics: [{ ...proposal(), ...change }] }).analyze(input()))
      .rejects.toMatchObject({ code: 'FOUNDER_STREAM_OUTPUT_INVALID' });
  });

  it('rejects an active-project upgrade supported only by the early idea', async () => {
    const early = { ...proposal(), displayName: '买家知识库', sourceIds: ['idea'],
      evidenceExcerpts: [{ sourceId: 'idea', excerpt: ideaText }] };
    await expect(analyzer({ topics: [early] }).analyze(input()))
      .rejects.toMatchObject({ code: 'FOUNDER_STREAM_OUTPUT_INVALID' });
  });

  it('reports a safe reason category without echoing malformed model content', async () => {
    await expect(analyzer({ topics: [{ ...proposal(), outcome: 'invented-secret-value' }] }).analyze(input()))
      .rejects.toMatchObject({ code: 'FOUNDER_STREAM_OUTPUT_INVALID', reason: 'outcome_ungrounded' });
  });

  it('restores display-name-only formatting differences to the exact source text', async () => {
    const result = await analyzer({ topics: [{ ...proposal(), displayName: '销售 助手' }] }).analyze(input());
    expect(result.topics[0]?.displayName).toBe('销售助手');
  });

  it('replaces a semantic display-name rewrite with a deterministic source line', async () => {
    const result=await analyzer({ topics: [{ ...proposal(), displayName: '智能销售助手' }] }).analyze(input());
    expect(result.topics[0]?.displayName).toBe(discussionText);
  });

  it('retries one invalid model result with a safe validation reason', async () => {
    const prompts:string[]=[];let calls=0;
    const subject=new CodexFounderStreamAnalyzer({codex:{async executeJson(request){prompts.push(request.prompt);calls++;
      return calls===1?{topics:[{...proposal(),outcome:'改写后的目标'}]}:{topics:[proposal()]};}}});
    expect((await subject.analyze(input())).topics[0]?.displayName).toBe('销售助手');
    expect(calls).toBe(2);
    expect(prompts[1]).toContain('outcome_ungrounded');
    expect(prompts[1]).not.toContain('改写后的目标');
  });

  it.each([null, '```json\n{}\n```', { topics: [], projectRegistry: [] }, { topics: Array(41).fill(proposal()) }])(
    'rejects malformed or oversized responses %#', async (output) => {
      await expect(analyzer(output).analyze(input())).rejects.toMatchObject({ code: 'FOUNDER_STREAM_OUTPUT_INVALID' });
    });

  it('passes only whitelisted evidence fields to the executor and emits a fully strict schema', async () => {
    let captured: { prompt: string; outputSchema: Record<string, unknown> } | undefined;
    const subject = new CodexFounderStreamAnalyzer({ codex: { async executeJson(request) {
      captured = request;
      return { topics: [] };
    } } });
    const extendedSource = { ...input().sources[0]!, metadata: { projects: ['legacy-secret-project'] },
      authors: [{ privateToken: 'never-send-token' }] };
    await subject.analyze({ sources: [extendedSource], currentTopics: [] });
    expect(captured?.prompt).toContain(ideaText);
    expect(captured?.prompt).not.toContain('legacy-secret-project');
    expect(captured?.prompt).not.toContain('never-send-token');
    expect(captured?.prompt).toContain('逐项执行最终校验');
    expect(captured?.prompt).toContain('必须完整出现在至少一个 evidenceExcerpts[].excerpt');
    function check(value: unknown): void {
      if (!value || typeof value !== 'object') return;
      const object = value as Record<string, unknown>;
      if (object.type === 'object') {
        expect(object.additionalProperties).toBe(false);
        expect(new Set(object.required as string[])).toEqual(new Set(Object.keys(object.properties as object)));
      }
      Object.values(object).forEach(check);
    }
    check(captured?.outputSchema);
    expect(captured?.outputSchema).toEqual(founderStreamOutputJsonSchema);
  });

  it.each(['projects', 'systemRules'])('rejects %s as an analyzer input before executing', async (key) => {
    let calls = 0;
    const subject = new CodexFounderStreamAnalyzer({ codex: { async executeJson() { calls++; return { topics: [] }; } } });
    await expect(subject.analyze({ ...input(), [key]: ['legacy'] } as FounderStreamInput))
      .rejects.toMatchObject({ code: 'FOUNDER_STREAM_INPUT_INVALID' });
    expect(calls).toBe(0);
  });

  it.each([
    { sourceType: 'project_registry' }, { availabilityStatus: 'deleted' },
    { contentHash: '0'.repeat(64) }, { sourceVersion: 0 }, { occurredAt: 'yesterday' }
  ])('rejects invalid immutable input source %#', async (change) => {
    await expect(analyzer({ topics: [] }).analyze({ ...input(), sources: [
      { ...input().sources[0]!, ...change } as FounderStreamInput['sources'][number]
    ] })).rejects.toMatchObject({ code: 'FOUNDER_STREAM_INPUT_INVALID' });
  });

  it('rejects duplicate source IDs rather than letting a later source shadow evidence', async () => {
    const supplied = input();
    await expect(analyzer({ topics: [] }).analyze({ ...supplied, sources: [
      ...supplied.sources, source('idea', '另一个内容')
    ] })).rejects.toMatchObject({ code: 'FOUNDER_STREAM_INPUT_INVALID' });
  });

  it('preserves an executor failure instead of returning an empty successful analysis', async () => {
    const subject = new CodexFounderStreamAnalyzer({ codex: { async executeJson() { throw new Error('CODEX_AUTH_REQUIRED'); } } });
    await expect(subject.analyze(input())).rejects.toThrow('CODEX_AUTH_REQUIRED');
  });

  it('preserves occurrence timestamps so later withdrawal can be distinguished from old commitment', async () => {
    let prompt = '';
    const subject = new CodexFounderStreamAnalyzer({ codex: { async executeJson(request) {
      prompt = request.prompt; return { topics: [] };
    } } });
    await subject.analyze({ sources: [
      { ...source('old', commitmentText), occurredAt: '2026-09-01T10:00:00.000Z' },
      { ...source('new', '撤回销售助手计划，暂时不做。'), occurredAt: '2026-09-20T10:00:00.000Z' }
    ], currentTopics: [] });
    const supplied = JSON.parse(prompt.split('Supplied evidence JSON:\n')[1]!) as {
      sources: { id: string; occurredAt: string }[]
    };
    expect(supplied.sources.map(({ id, occurredAt }) => ({ id, occurredAt }))).toEqual([
      { id: 'old', occurredAt: '2026-09-01T10:00:00.000Z' },
      { id: 'new', occurredAt: '2026-09-20T10:00:00.000Z' }
    ]);
  });
});

import { describe, expect, it } from 'vitest';
import { CodexFounderPerspectiveAnalyzer } from '../src/adapters/codex-founder-perspective-analyzer.js';

const input = {
  sourceIds: ['src_ivy', 'src_james'],
  topicIds: ['topic_site'],
  evidence: [
    { id: 'ev_ivy', sourceId: 'src_ivy', topicIds: ['topic_site'], excerpt: 'Ivy：先完成官网首页再做内容库。',
      founder: 'ivy' as const, occurredAt: '2026-09-10T10:00:00.000Z' },
    { id: 'ev_james', sourceId: 'src_james', topicIds: ['topic_site'], excerpt: 'James：先把内容库建起来，官网可以后做。',
      founder: 'james' as const, occurredAt: '2026-09-10T10:05:00.000Z' }
  ]
};

describe('CodexFounderPerspectiveAnalyzer', () => {
  it('grounds founder observations and a divergence in scoped immutable evidence', async () => {
    const subject = new CodexFounderPerspectiveAnalyzer({ codex: { async executeJson() {
      return {
        observations: [
          { topicId: 'topic_site', evidenceId: 'ev_ivy', statement: '先完成官网首页再做内容库',
            speechAct: 'decision_proposal', decisionKey: 'execution-order', confidence: 0.94 },
          { topicId: 'topic_site', evidenceId: 'ev_james', statement: '先把内容库建起来，官网可以后做',
            speechAct: 'decision_proposal', decisionKey: 'execution-order', confidence: 0.91 }
        ],
        alignmentProposals: [{ topicId: 'topic_site', decisionKey: 'execution-order', dimension: 'direction',
          ivy: { evidenceId: 'ev_ivy', statement: '先完成官网首页再做内容库' },
          james: { evidenceId: 'ev_james', statement: '先把内容库建起来，官网可以后做' },
          actionConsequence: null, actionHorizon: null }]
      };
    } } });

    const result = await subject.analyze(input);

    expect(result.observations).toEqual([
      { topicId: 'topic_site', evidenceId: 'ev_ivy', statement: '先完成官网首页再做内容库',
        speechAct: 'decision_proposal', decisionKey: 'execution-order', confidence: 0.94,
        observedAt: new Date('2026-09-10T10:00:00.000Z') },
      { topicId: 'topic_site', evidenceId: 'ev_james', statement: '先把内容库建起来，官网可以后做',
        speechAct: 'decision_proposal', decisionKey: 'execution-order', confidence: 0.91,
        observedAt: new Date('2026-09-10T10:05:00.000Z') }
    ]);
    expect(result.alignmentProposals).toHaveLength(1);
  });

  it.each([
    ['unknown evidence', { observations: [{ topicId: 'topic_site', evidenceId: 'ev_missing', statement: '先完成官网首页',
      speechAct: 'view', decisionKey: null, confidence: 0.8 }], alignmentProposals: [] }],
    ['unscoped topic', { observations: [{ topicId: 'topic_other', evidenceId: 'ev_ivy', statement: '先完成官网首页',
      speechAct: 'view', decisionKey: null, confidence: 0.8 }], alignmentProposals: [] }],
    ['invented statement', { observations: [{ topicId: 'topic_site', evidenceId: 'ev_ivy', statement: '已经完成全部交付',
      speechAct: 'view', decisionKey: null, confidence: 0.8 }], alignmentProposals: [] }],
    ['identity-swapped divergence', { observations: [], alignmentProposals: [{ topicId: 'topic_site', decisionKey: 'order',
      dimension: 'direction', ivy: { evidenceId: 'ev_james', statement: '先把内容库建起来' },
      james: { evidenceId: 'ev_ivy', statement: '先完成官网首页' }, actionConsequence: null, actionHorizon: null }] }]
  ])('fails closed for %s', async (_label, output) => {
    const subject = new CodexFounderPerspectiveAnalyzer({ codex: { async executeJson() { return output; } } });
    await expect(subject.analyze(input)).rejects.toMatchObject({ code: 'FOUNDER_PERSPECTIVE_OUTPUT_INVALID' });
  });

  it('reports a safe reason category without echoing invalid model text',async()=>{
    const subject=new CodexFounderPerspectiveAnalyzer({codex:{async executeJson(){return{observations:[{
      topicId:'topic_site',evidenceId:'ev_ivy',statement:'invented private sentence',speechAct:'view',decisionKey:null,confidence:0.8
    }],alignmentProposals:[]}}}});
    await expect(subject.analyze(input)).rejects.toMatchObject({code:'FOUNDER_PERSPECTIVE_OUTPUT_INVALID',reason:'observation_ungrounded'});
  });

  it('retries once with the safe validation reason and accepts a corrected grounded result', async () => {
    const prompts: string[] = [];
    const subject = new CodexFounderPerspectiveAnalyzer({ codex: { async executeJson(request) {
      prompts.push(request.prompt);
      if (prompts.length === 1) return { observations: [{
        topicId: 'topic_site', evidenceId: 'ev_ivy', statement: 'invented private sentence',
        speechAct: 'view', decisionKey: null, confidence: 0.8
      }], alignmentProposals: [] };
      return { observations: [{
        topicId: 'topic_site', evidenceId: 'ev_ivy', statement: '先完成官网首页再做内容库',
        speechAct: 'decision_proposal', decisionKey: 'execution-order', confidence: 0.9
      }], alignmentProposals: [] };
    } } });

    const result = await subject.analyze(input);

    expect(result.observations).toHaveLength(1);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('observation_ungrounded');
    expect(prompts[1]).not.toContain('invented private sentence');
  });

  it('passes only allowlisted evidence fields to Codex and emits a strict output schema', async () => {
    let captured: { prompt: string; outputSchema: Record<string, unknown> } | undefined;
    const subject = new CodexFounderPerspectiveAnalyzer({ codex: { async executeJson(request) {
      captured = request;
      return { observations: [], alignmentProposals: [] };
    } } });
    await subject.analyze({ ...input, evidence: [{ ...input.evidence[0]!, privateToken: 'never-forward' } as never] });
    expect(captured?.prompt).toContain('Ivy：先完成官网首页再做内容库。');
    expect(captured?.prompt).not.toContain('never-forward');
    const visit = (value: unknown): void => {
      if (!value || typeof value !== 'object') return;
      const object = value as Record<string, unknown>;
      if (object.type === 'object') {
        expect(object.additionalProperties).toBe(false);
        expect(new Set(object.required as string[])).toEqual(new Set(Object.keys(object.properties as object)));
      }
      Object.values(object).forEach(visit);
    };
    visit(captured?.outputSchema);
  });
});

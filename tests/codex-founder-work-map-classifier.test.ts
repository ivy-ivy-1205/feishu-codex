import { expect, it } from 'vitest';
import { CodexFounderWorkMapClassifier } from '../src/adapters/codex-founder-work-map-classifier.js';
import type { FounderStreamAnalysis } from '../src/ports/founder-stream-analyzer.js';

const analysis:FounderStreamAnalysis={topics:[{displayName:'情绪价值',stage:'exploring',outcome:null,currentAction:null,confidence:'high',
  sourceIds:['s1'],evidenceExcerpts:[{sourceId:'s1',excerpt:'情绪价值是服务原则'}],joinDecision:{kind:'new',topicId:null,confidence:'high',sharedTerms:[]},splitSuggestions:[]}]};

it('classifies every proposal through a strict semantic boundary',async()=>{
  let prompt='';const classifier=new CodexFounderWorkMapClassifier({codex:{async executeJson(input){prompt=input.prompt;return{items:[{
    proposalIndex:0,kind:'principle',lifecycle:'active',parentProposalIndex:null}]}}}});
  await expect(classifier.classify(analysis)).resolves.toEqual({items:[{proposalIndex:0,kind:'principle',lifecycle:'active',parentProposalIndex:null}]});
  expect(prompt).toContain('project / principle / artifact / research / idea');
  expect(prompt).toContain('持续目标、负责人或明确下一步');
});

it('rejects malformed classifications without echoing source content',async()=>{
  const classifier=new CodexFounderWorkMapClassifier({codex:{async executeJson(){return{items:[{proposalIndex:0,kind:'tool',lifecycle:'active',parentProposalIndex:null}]}}}});
  await expect(classifier.classify(analysis)).rejects.toThrow('FOUNDER_CLASSIFICATION_INVALID');
});

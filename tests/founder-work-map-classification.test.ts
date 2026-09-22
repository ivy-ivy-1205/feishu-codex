import { expect, it } from 'vitest';
import type { FounderStreamAnalysis, TopicProposal } from '../src/ports/founder-stream-analyzer.js';
import { projectFounderWorkMap } from '../src/services/founder-work-map-classification.js';

const proposal=(displayName:string,sourceId:string):TopicProposal=>({displayName,stage:'exploring',outcome:null,currentAction:null,
  confidence:'high',sourceIds:[sourceId],evidenceExcerpts:[{sourceId,excerpt:`${displayName} evidence`}],
  joinDecision:{kind:'new',topicId:null,confidence:'high',sharedTerms:[]},splitSuggestions:[]});

it('applies Ivy authoritative corrections and keeps principles, research and completed artifacts out of the project layer',()=>{
  const input:FounderStreamAnalysis={topics:[proposal('AI native 房产业务','s1'),proposal('情绪价值','s2'),
    proposal('EP00《挺好》｜剧本 V1.4-R1 候选稿','s3'),proposal('低干扰自动沉淀与工作对齐','s4'),
    proposal('VibeVoice','s5'),proposal('PropHero｜独立竞品主报告（第一轮）','s6')]};
  const result=projectFounderWorkMap(input,{items:input.topics.map((_,proposalIndex)=>({proposalIndex,kind:'project',
    lifecycle:'active',parentProposalIndex:null}))});
  expect(Object.values(result.canonicalNames)).toEqual(expect.arrayContaining(['AI native 房产业务','AiJia Founder Alignment Room / AiJia 合伙人对齐室']));
  expect(result.supportingItems).toEqual(expect.arrayContaining([
    expect.objectContaining({displayName:'情绪价值',kind:'principle',parentDisplayName:'AI native 房产业务'}),
    expect.objectContaining({displayName:'PropHero｜独立竞品主报告（第一轮）',kind:'research',parentDisplayName:'AI native 房产业务'})
  ]));
  expect(result.historyItems).toEqual([expect.objectContaining({displayName:'EP00《挺好》｜剧本 V1.4-R1 候选稿',kind:'artifact',lifecycle:'completed'})]);
  expect(result.researchInbox).toEqual([expect.objectContaining({displayName:'VibeVoice',kind:'research'})]);
  expect(result.analysis.topics[0]!.sourceIds).toEqual(['s1','s2','s6']);
});

it('fails closed when model classification omits or duplicates a proposal',()=>{
  const input:FounderStreamAnalysis={topics:[proposal('A','s1'),proposal('B','s2')]};
  expect(()=>projectFounderWorkMap(input,{items:[{proposalIndex:0,kind:'project',lifecycle:'active',parentProposalIndex:null}]}))
    .toThrow('FOUNDER_CLASSIFICATION_INVALID');
  expect(()=>projectFounderWorkMap(input,{items:[{proposalIndex:0,kind:'project',lifecycle:'active',parentProposalIndex:null},
    {proposalIndex:0,kind:'idea',lifecycle:'active',parentProposalIndex:null}]})).toThrow('FOUNDER_CLASSIFICATION_INVALID');
});

it('applies authoritative corrections to headings with markdown and document-title wrappers',()=>{
  const input:FounderStreamAnalysis={topics:[proposal('# AI native房产服务：产品系统与服务流程总纲','s1'),
    proposal('   情绪价值融入商业骨髓','s2'),proposal('# James与艾薇：低干扰自动沉淀与工作对齐 V0.2','s3'),
    proposal('# EP00《挺好','s4'),proposal('．VibeVoice','s5'),proposal('# PropHero｜独立竞品主报告（第一轮','s6')]};
  const result=projectFounderWorkMap(input,{items:input.topics.map((_,proposalIndex)=>({proposalIndex,kind:'research' as const,
    lifecycle:'active' as const,parentProposalIndex:null}))});
  expect(Object.values(result.canonicalNames)).toEqual(expect.arrayContaining(['AI native 房产业务','AiJia Founder Alignment Room / AiJia 合伙人对齐室']));
  expect(result.supportingItems.map(item=>item.kind)).toEqual(['principle','research']);
  expect(result.historyItems).toEqual([expect.objectContaining({kind:'artifact',lifecycle:'completed'})]);
  expect(result.researchInbox).toEqual([expect.objectContaining({kind:'research',lifecycle:'unknown'})]);
});

import { z } from 'zod';
import type { FounderStreamAnalysis, TopicProposal } from '../ports/founder-stream-analyzer.js';

export const founderEntityKindSchema=z.enum(['project','principle','artifact','research','idea']);
export const founderEntityLifecycleSchema=z.enum(['active','completed','unknown']);
export const founderWorkMapClassificationSchema=z.object({items:z.array(z.object({
  proposalIndex:z.number().int().nonnegative(),kind:founderEntityKindSchema,lifecycle:founderEntityLifecycleSchema,
  parentProposalIndex:z.number().int().nonnegative().nullable()
}).strict()).max(40)}).strict();
export type FounderWorkMapClassification=z.infer<typeof founderWorkMapClassificationSchema>;
export type FounderSupportingItem={displayName:string;kind:'principle'|'artifact'|'research';lifecycle:'active'|'completed'|'unknown';parentDisplayName:string};
export type FounderDetachedItem={displayName:string;kind:'principle'|'artifact'|'research';lifecycle:'active'|'completed'|'unknown'};

export function projectFounderWorkMap(input:FounderStreamAnalysis,raw:FounderWorkMapClassification):{
  analysis:FounderStreamAnalysis;supportingItems:FounderSupportingItem[];historyItems:FounderDetachedItem[];researchInbox:FounderDetachedItem[];
  supportingByDisplayName:Record<string,FounderSupportingItem[]>;canonicalNames:Record<string,string>;
}{
  const parsed=founderWorkMapClassificationSchema.safeParse(raw);if(!parsed.success)throw new Error('FOUNDER_CLASSIFICATION_INVALID');
  const indexes=parsed.data.items.map(item=>item.proposalIndex);
  if(indexes.length!==input.topics.length||new Set(indexes).size!==indexes.length||indexes.some(index=>index>=input.topics.length))
    throw new Error('FOUNDER_CLASSIFICATION_INVALID');
  const items=[...parsed.data.items].sort((a,b)=>a.proposalIndex-b.proposalIndex).map(item=>({...item}));
  const find=(needle:string)=>input.topics.findIndex(topic=>semanticName(topic.displayName).includes(semanticName(needle)));
  const ai=find('AI native房产');
  const set=(needle:string,value:Partial<(typeof items)[number]>)=>{const index=find(needle);if(index>=0)Object.assign(items[index]!,value)};
  if(ai>=0)Object.assign(items[ai]!,{kind:'project',lifecycle:'active',parentProposalIndex:null});
  if(ai>=0){set('情绪价值',{kind:'principle',lifecycle:'active',parentProposalIndex:ai});
    set('PropHero',{kind:'research',lifecycle:'active',parentProposalIndex:ai})}
  const ep=find('EP00挺好');
  if(ep>=0)Object.assign(items[ep]!,{kind:'project',lifecycle:'completed',parentProposalIndex:null});
  set('低干扰自动沉淀与工作对齐',{kind:'project',lifecycle:'active',parentProposalIndex:null});
  set('VibeVoice',{kind:'research',lifecycle:'unknown',parentProposalIndex:null});
  for(const item of items){if(item.parentProposalIndex===item.proposalIndex||item.parentProposalIndex!==null&&items[item.parentProposalIndex]?.kind!=='project')
    throw new Error('FOUNDER_CLASSIFICATION_INVALID')}
  const supportingItems:FounderSupportingItem[]=[],historyItems:FounderDetachedItem[]=[],researchInbox:FounderDetachedItem[]=[];
  const visible=new Map<number,TopicProposal>();
  for(const item of items){const topic=input.topics[item.proposalIndex]!;
    if(item.kind==='project'||item.kind==='idea')visible.set(item.proposalIndex,{...topic,
      ...(item.kind==='project'&&item.lifecycle==='completed'?{stage:'closed' as const}: {})});
    else if(item.parentProposalIndex!==null){const parent=input.topics[item.parentProposalIndex]!;
      supportingItems.push({displayName:topic.displayName,kind:item.kind,lifecycle:item.lifecycle,parentDisplayName:parent.displayName});
    }else if(item.lifecycle==='completed')historyItems.push({displayName:topic.displayName,kind:item.kind,lifecycle:item.lifecycle});
    else researchInbox.push({displayName:topic.displayName,kind:item.kind,lifecycle:item.lifecycle})}
  for(const item of items){if(item.parentProposalIndex===null)continue;const parent=visible.get(item.parentProposalIndex);if(!parent)continue;
    const child=input.topics[item.proposalIndex]!;visible.set(item.parentProposalIndex,{...parent,
      sourceIds:[...new Set([...parent.sourceIds,...child.sourceIds])].sort(),evidenceExcerpts:unique([...parent.evidenceExcerpts,...child.evidenceExcerpts])})}
  const supportingByDisplayName:Record<string,FounderSupportingItem[]>={};
  for(const item of supportingItems)(supportingByDisplayName[item.parentDisplayName]??=[]).push(item);
  const canonicalNames:Record<string,string>={};
  const alignment=find('低干扰自动沉淀与工作对齐');
  if(alignment>=0)canonicalNames[input.topics[alignment]!.displayName]='AiJia Founder Alignment Room / AiJia 合伙人对齐室';
  if(ai>=0)canonicalNames[input.topics[ai]!.displayName]='AI native 房产业务';
  if(ep>=0)canonicalNames[input.topics[ep]!.displayName]='EP00《挺好》';
  return {analysis:{topics:[...visible.entries()].sort(([a],[b])=>a-b).map(([,topic])=>topic)},supportingItems,historyItems,researchInbox,supportingByDisplayName,canonicalNames};
}

function semanticName(value:string):string{return value.normalize('NFKC').toLocaleLowerCase('en-US').replace(/[\s\p{P}\p{S}]+/gu,'')}

function unique(values:TopicProposal['evidenceExcerpts']):TopicProposal['evidenceExcerpts']{
  return [...new Map(values.map(value=>[JSON.stringify([value.sourceId,value.excerpt]),value])).values()];
}

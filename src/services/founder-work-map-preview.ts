import type Database from 'better-sqlite3';
import type { AlignmentProposal, FounderRole } from '../domain/alignment.js';
import type { ContextEvidenceLocator } from '../domain/context.js';
import type { FounderStreamAnalyzer } from '../ports/founder-stream-analyzer.js';
import { validateFounderStreamInput } from '../ports/founder-stream-analyzer.js';
import { ContextSourceRepository, type ContextSourceRecord } from '../repositories/context-source-repository.js';
import type { FounderPerspectiveAnalysisPort } from './founder-stream-worker.js';
import { projectFounderWorkMap, type FounderWorkMapClassification, type FounderSupportingItem, type FounderDetachedItem } from './founder-work-map-classification.js';
import { canonicalJson, stableId } from './canonical-json.js';
import type { FounderCardEvidence } from './founder-card.js';
import { renderFounderWorkMap, type FounderWorkMapCard } from './founder-work-map-renderer.js';
import { reconcileTopics } from './topic-reconciler.js';

export interface FounderWorkMapPreviewInput {
  client: Database.Database;
  chatId: string;
  since: string;
  until: string;
  sourceIds: readonly string[];
  founderOpenIds: Record<FounderRole, string>;
  analyzer: FounderStreamAnalyzer;
  perspectiveAnalyzer: FounderPerspectiveAnalysisPort;
  classifier?: { classify(analysis: Awaited<ReturnType<FounderStreamAnalyzer['analyze']>>): Promise<FounderWorkMapClassification> };
}

export interface FounderWorkMapPreviewResult {
  window: { since: string; until: string };
  coverage: { status: 'complete' | 'partial'; gapsByCode: Record<string, number> };
  topics: Array<{ id: string; displayName: string; stage: string; outcome: string | null;
    currentAction: string | null; perspectives: Array<{ founder: FounderRole; statement: string;
      speechAct: string; decisionKey: string | null; evidenceId: string }> }>;
  alignmentProposals: readonly AlignmentProposal[];
  evidence: Array<{ id:string;sourceId:string;topicIds:string[];messageId:string;threadId:string|null;
    excerpt:string;founder:FounderRole|null;occurredAt:string }>;
  cards: FounderWorkMapCard[];
  classification: { supportingItems:FounderSupportingItem[];historyItems:FounderDetachedItem[];researchInbox:FounderDetachedItem[] };
}

export async function buildFounderWorkMapPreview(input: FounderWorkMapPreviewInput): Promise<FounderWorkMapPreviewResult> {
  const start = Date.parse(input.since), end = Date.parse(input.until);
  if (!input.chatId.trim() || !Number.isFinite(start) || !Number.isFinite(end) || start >= end ||
    input.founderOpenIds.ivy === input.founderOpenIds.james || new Set(input.sourceIds).size !== input.sourceIds.length) {
    throw new Error('FOUNDER_PREVIEW_INPUT_INVALID');
  }
  const repository = new ContextSourceRepository(input.client);
  const sources = input.sourceIds.map((id) => repository.getSource(id));
  if (sources.some((source) => !eligible(source, input.chatId, start, end))) throw new Error('FOUNDER_PREVIEW_SOURCE_INVALID');
  const immutableInput = validateFounderStreamInput({ sources: sources.map((source) => ({
    id: source!.id, sourceType: source!.sourceType as 'group_message', sourceVersion: source!.sourceVersion,
    contentHash: source!.contentHash, contentText: source!.contentText, occurredAt: source!.occurredAt,
    availabilityStatus: 'available' as const
  })), currentTopics: [] });
  const analysis = await input.analyzer.analyze(immutableInput);
  const classified=input.classifier?projectFounderWorkMap(analysis,await input.classifier.classify(analysis)):{analysis,supportingItems:[],historyItems:[],researchInbox:[],supportingByDisplayName:{},canonicalNames:{}};
  const plan = reconcileTopics(immutableInput, classified.analysis);
  const prepared = plan.topics.map((item) => ({ item,
    id: stableId('previewtopic', canonicalJson([input.since,input.until,item.proposalIndex,item.proposal.displayName])) }));
  const evidence = new Map<string, { id:string;sourceId:string;topicIds:string[];excerpt:string;
    founder:FounderRole|null;occurredAt:string;card:FounderCardEvidence }>();
  for (const row of prepared) for (const excerpt of row.item.evidenceExcerpts) {
    const source = sources.find((candidate) => candidate!.id === excerpt.sourceId)!;
    const id = stableId('previewevidence', canonicalJson([source!.id,excerpt.excerpt]));
    const existing = evidence.get(id);
    if (existing) { if (!existing.topicIds.includes(row.id)) existing.topicIds.push(row.id); continue; }
    const locator: ContextEvidenceLocator = { kind:'group_message',sourceVersion:source!.sourceVersion,
      contentHash:source!.contentHash,chatId:input.chatId,messageId:source!.externalId,
      threadId:typeof source!.metadata.threadId==='string'?source!.metadata.threadId:null,
      authorOpenId:authorOpenIdFor(source!),occurredAt:source!.occurredAt };
    evidence.set(id,{id,sourceId:source!.id,topicIds:[row.id],excerpt:excerpt.excerpt,
      founder:founderFor(source!,input.founderOpenIds),occurredAt:source!.occurredAt,
      card:{id,sourceId:source!.id,sourceVersion:source!.sourceVersion,excerpt:excerpt.excerpt,locator,occurredAt:source!.occurredAt}});
  }
  const perspectiveResult = evidence.size === 0 ? { observations:[],alignmentProposals:[] } :
    await input.perspectiveAnalyzer.analyze({ sourceIds:immutableInput.sources.map((source) => source.id),
      topicIds:prepared.map((row) => row.id),evidence:[...evidence.values()].map(({card:_,...item})=>item) });
  const gapsByCode = collectGaps(repository.listSources(), input.chatId, input.since, input.until);
  const coverageGaps = Object.entries(gapsByCode).sort(([a],[b])=>a.localeCompare(b)).map(([code,count])=>({
    id:`gap:${code}`,summary:`${gapLabel(code)}：${count}`
  }));
  const topics = prepared.map(({item,id}) => ({ id,displayName:classified.canonicalNames[item.proposal.displayName]??item.proposal.displayName,stage:item.proposal.stage,
    outcome:item.proposal.outcome,currentAction:item.proposal.currentAction,
    perspectives:perspectiveResult.observations.filter((observation)=>observation.topicId===id).flatMap((observation)=>{
      const founder=evidence.get(observation.evidenceId)?.founder;
      return founder ? [{founder,statement:observation.statement,speechAct:observation.speechAct,
        decisionKey:observation.decisionKey,evidenceId:observation.evidenceId}] : [];
    }) }));
  const cards = renderFounderWorkMap({since:input.since,until:input.until,
    topics:prepared.map(({item,id})=>({id,currentVersion:1,displayName:classified.canonicalNames[item.proposal.displayName]??item.proposal.displayName,stage:item.proposal.stage,
      outcome:item.proposal.outcome,evidence:[...evidence.values()].filter(value=>value.topicIds.includes(id)).map(value=>value.card),
      supportingItems:(classified.supportingByDisplayName[item.proposal.displayName]??[]).map(({kind,displayName})=>({kind,displayName}))})),
    uncertainGrouping:[],coverageGaps});
  const evidenceOutput=[...evidence.values()].map((item)=>({id:item.id,sourceId:item.sourceId,topicIds:[...item.topicIds],
    messageId:item.card.locator.kind==='group_message'?item.card.locator.messageId:'',
    threadId:item.card.locator.kind==='group_message'?item.card.locator.threadId:null,excerpt:item.excerpt,
    founder:item.founder,occurredAt:item.occurredAt}));
  return {window:{since:input.since,until:input.until},coverage:{status:coverageGaps.length?'partial':'complete',gapsByCode},
    topics,alignmentProposals:perspectiveResult.alignmentProposals,evidence:evidenceOutput,cards,
    classification:{supportingItems:classified.supportingItems,historyItems:classified.historyItems,researchInbox:classified.researchInbox}};
}

function eligible(source: ContextSourceRecord | null, chatId: string, start: number, end: number): source is ContextSourceRecord {
  return Boolean(source && source.sourceType==='group_message' && source.availabilityStatus==='available' &&
    source.contentState==='cleartext' && source.metadata.chatId===chatId && source.metadata.senderType==='user' &&
    Date.parse(source.occurredAt)>=start && Date.parse(source.occurredAt)<=end && source.contentText.trim());
}

function founderFor(source: ContextSourceRecord, identities: Record<FounderRole,string>): FounderRole|null {
  const openId=source.authors.length===1?authorOpenIdFor(source):null;
  return openId===identities.ivy?'ivy':openId===identities.james?'james':null;
}

function authorOpenIdFor(source: ContextSourceRecord): string | null {
  const openId = source.authors[0]?.openId;
  return typeof openId === 'string' ? openId : null;
}

function collectGaps(sources: readonly ContextSourceRecord[], chatId: string, since: string, until: string): Record<string,number> {
  const result:Record<string,number>={};
  const coverage = sources.filter((source) => {
    if (source.sourceType !== 'feishu_sync_coverage' || source.metadata.chatId !== chatId) return false;
    try {
      const value = JSON.parse(source.contentText) as { requestedRange?: { since?: unknown; until?: unknown } };
      return value.requestedRange?.since === since && value.requestedRange.until === until;
    } catch { return false; }
  }).sort((a,b) => b.capturedAt.localeCompare(a.capturedAt))[0];
  if (!coverage?.externalId.endsWith(':coverage')) return result;
  const gapPrefix = `${coverage.externalId.slice(0,-':coverage'.length)}:gap:`;
  for(const source of sources) {
    if(source.sourceType!=='feishu_sync_gap'||source.metadata.chatId!==chatId||!source.externalId.startsWith(gapPrefix))continue;
    try { const code=JSON.parse(source.contentText).code;if(typeof code==='string'&&/^[A-Z_]{2,80}$/.test(code))result[code]=(result[code]??0)+1; } catch { /* malformed gaps stay excluded from display */ }
  }
  return result;
}

function gapLabel(code:string):string {
  return ({FILE_TEXT_UNREADABLE:'文件正文不可读',MEDIA_SKIPPED:'媒体已跳过',IMAGE_SKIPPED:'图片已跳过',MESSAGE_DELETED:'消息已删除',VOICE_TEXT_MISSING:'语音缺少文字'} as Record<string,string>)[code] ?? code;
}

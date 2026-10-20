import type Database from 'better-sqlite3';
import { z } from 'zod';
import type { FounderWorkMapMessage } from '../repositories/outbox-repository.js';
import { ContextSourceRepository } from '../repositories/context-source-repository.js';
import { TopicRepository, TopicVersionConflictError } from '../repositories/topic-repository.js';
import { captureGroupMessageSource } from './group-message-source-capture.js';
import { canonicalJson, sha256, stableId } from './canonical-json.js';
import type { CurrentTopic } from '../domain/topic.js';
import { founderFeedbackInputSchema, staleFeedback, type FounderFeedbackDependencies,
  type FounderFeedbackDecision, type FounderFeedbackInput } from './topic-correction-service.js';

const topicRefSchema = z.object({ id: z.string().min(1), expectedVersion: z.number().int().positive() }).strict();
export const founderBatchOperationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('update_topic'), topic: topicRefSchema,
    stage: z.enum(['idea', 'exploring', 'project_candidate', 'active_project', 'paused', 'closed']).optional(),
    outcome: z.string().trim().min(1).max(800).optional() }).strict(),
  z.object({ kind: z.literal('merge_topics'), topics: z.array(topicRefSchema).min(2).max(12),
    canonicalTopic: topicRefSchema }).strict(),
  z.object({ kind: z.literal('set_visibility'), topics: z.array(topicRefSchema).min(1).max(12),
    visibility: z.literal('space_managed') }).strict(),
  z.object({ kind: z.literal('set_work_map_preference'), hideOrphanActive: z.literal(true) }).strict()
]);
export const founderBatchOperationsSchema = z.array(founderBatchOperationSchema).min(2).max(40);
export type FounderBatchOperation = z.infer<typeof founderBatchOperationSchema>;

interface DraftRow {
  id:string;chat_id:string;map_id:string;binding_message_id:string;source_message_id:string;author_open_id:string;
  input_hash:string;input_json:string;operations_json:string;status:'pending'|'applied'|'cancelled';created_at:string;applied_at:string|null;
}

export function draftFounderBatchCorrection(input:FounderFeedbackInput,binding:FounderWorkMapMessage,
  dependencies:FounderFeedbackDependencies):FounderFeedbackDecision|null{
  const operations=parseFounderBatchCorrection(input.text,binding,dependencies.client);
  if(!operations)return null;
  const hash=feedbackHash(input),id=stableId('feedbackdraft',`${input.chatId}\n${input.messageId}`),now=dependencies.now().toISOString();
  const existing=dependencies.client.prepare('SELECT * FROM founder_feedback_drafts WHERE chat_id=? AND source_message_id=?')
    .get(input.chatId,input.messageId) as DraftRow|undefined;
  if(existing){
    if(existing.input_hash!==hash)return{kind:'reject',reason:'message_conflict'};
    return draftDecision(existing.id,JSON.parse(existing.operations_json).length,true);
  }
  dependencies.client.prepare(`INSERT INTO founder_feedback_drafts
    (id,chat_id,map_id,binding_message_id,source_message_id,author_open_id,input_hash,input_json,operations_json,status,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,'pending',?)`).run(id,input.chatId,binding.mapId,input.replyTo,input.messageId,input.openId,hash,
      JSON.stringify(input),JSON.stringify(operations),now);
  return draftDecision(id,operations.length,false);
}

export function confirmFounderBatchCorrection(input:FounderFeedbackInput,draftId:string,
  dependencies:FounderFeedbackDependencies):FounderFeedbackDecision{
  const draft=findDraft(dependencies.client,input.chatId,draftId);
  if(!draft)return{kind:'reject',reason:'unrelated_message'};
  if(draft.author_open_id!==input.openId)return{kind:'reject',reason:'unknown_founder'};
  return applyFounderBatchDraft(draft.id,dependencies);
}

/** Operator path for an already approved recovery. It still enforces the stored source hash and every expected topic version. */
export function applyFounderBatchDraft(draftId:string,dependencies:FounderFeedbackDependencies,
  options:{cancelPendingFeedbackKey?:string}={}):FounderFeedbackDecision{
  const {client}=dependencies;
  try{return client.transaction(()=>{
    const draft=client.prepare('SELECT * FROM founder_feedback_drafts WHERE id=?').get(draftId) as DraftRow|undefined;
    if(!draft||!dependencies.approvedChatIds.includes(draft.chat_id))return{kind:'reject',reason:'unrelated_message'} as const;
    if(draft.status==='applied'){
      const prior=client.prepare('SELECT result_json FROM founder_feedback_corrections WHERE chat_id=? AND source_message_id=?')
        .get(draft.chat_id,draft.source_message_id) as {result_json:string}|undefined;
      return prior?{...JSON.parse(prior.result_json),kind:'duplicate'} as FounderFeedbackDecision:{kind:'reject',reason:'message_conflict'} as const;
    }
    if(draft.status!=='pending')return{kind:'reject',reason:'message_conflict'} as const;
    const original=founderFeedbackInputSchema.parse(JSON.parse(draft.input_json));
    if(feedbackHash(original)!==draft.input_hash||original.messageId!==draft.source_message_id||original.chatId!==draft.chat_id)
      return{kind:'reject',reason:'message_conflict'} as const;
    const operations=founderBatchOperationsSchema.parse(JSON.parse(draft.operations_json));
    const topics=new TopicRepository(client),current=topics.listCurrentTopics(),byId=new Map(current.map(topic=>[topic.id,topic]));
    const refs=operations.flatMap(operation=>operation.kind==='set_work_map_preference'?[]:
      operation.kind==='update_topic'?[operation.topic]:operation.topics);
    for(const ref of refs){const topic=byId.get(ref.id);if(!topic||topic.currentVersion!==ref.expectedVersion)throw new TopicVersionConflictError()}
    const stamp=dependencies.now();
    const captured=captureGroupMessageSource({chatId:original.chatId,messageId:original.messageId,threadId:original.threadId??null,
      rootId:original.rootId??null,author:{openId:original.openId,displayName:null},messageType:'text',senderType:'user',
      text:original.text,occurredAt:original.occurredAt},stamp);
    const sources=new ContextSourceRepository(client),source=sources.saveSource(captured.source).source;
    const evidence=sources.saveEvidence({sourceId:source.id,excerpt:original.text,
      locator:{...captured.messageLocator,threadId:typeof source.metadata.threadId==='string'?source.metadata.threadId:null,
        sourceVersion:source.sourceVersion,contentHash:source.contentHash},evidenceLevel:'primary_statement',capturedAt:stamp}).evidence;
    const desired=new Map<string,{stage?:CurrentTopic['stage'];outcome?:string}>();
    const touched=new Set<string>();
    const merges:Extract<FounderBatchOperation,{kind:'merge_topics'}>[]=[];
    for(const operation of operations){
      if(operation.kind==='update_topic'){desired.set(operation.topic.id,{...desired.get(operation.topic.id),...('stage'in operation?{stage:operation.stage}:{}),
        ...('outcome'in operation?{outcome:operation.outcome}:{})});touched.add(operation.topic.id)}
      else if(operation.kind==='merge_topics'){
        for(const ref of operation.topics)touched.add(ref.id);
        merges.push(operation);
      }else if(operation.kind==='set_visibility'){
        for(const ref of operation.topics){touched.add(ref.id);client.prepare(`INSERT INTO founder_topic_visibility
          (topic_id,visibility,source_message_id,updated_at) VALUES(?,'space_managed',?,?)
          ON CONFLICT(topic_id) DO UPDATE SET visibility=excluded.visibility,source_message_id=excluded.source_message_id,updated_at=excluded.updated_at`)
          .run(ref.id,original.messageId,stamp.toISOString())}
      }else client.prepare(`INSERT INTO founder_work_map_preferences(chat_id,hide_orphan_active,source_message_id,updated_at)
        VALUES(?,1,?,?) ON CONFLICT(chat_id) DO UPDATE SET hide_orphan_active=1,source_message_id=excluded.source_message_id,updated_at=excluded.updated_at`)
        .run(original.chatId,original.messageId,stamp.toISOString());
    }
    for(const id of touched){const topic=byId.get(id)!,change=desired.get(id);
      topics.appendVersion({topicId:id,expectedVersion:topic.currentVersion,displayName:topic.displayName,
        stage:change?.stage??topic.stage,outcome:change?.outcome??topic.outcome,rationale:'群内批量人工纠正',
        evidenceIds:[...topic.evidenceIds,evidence.id],changedAt:stamp})}
    for(const operation of merges)for(const ref of operation.topics){if(ref.id===operation.canonicalTopic.id)continue;
      topics.addRelation({fromTopicId:operation.canonicalTopic.id,toTopicId:ref.id,relationType:'same_as',
        rationale:'群内批量纠正确认属于同一工作流',createdAt:stamp})}
    const result:FounderFeedbackDecision={kind:'corrected',correctionKind:'batch_correction',status:'applied',
      text:'已按确认草稿一次性更新工作地图，并保留原始回复与历史版本。'};
    client.prepare(`INSERT INTO founder_feedback_corrections
      (id,chat_id,source_message_id,author_open_id,binding_message_id,evidence_id,input_hash,correction_json,result_json,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(stableId('feedback',`${original.chatId}\n${original.messageId}`),original.chatId,original.messageId,
        original.openId,draft.binding_message_id,evidence.id,draft.input_hash,JSON.stringify({kind:'batch_correction',draftId:draft.id,operations}),
        JSON.stringify(result),stamp.toISOString());
    const applied=client.prepare("UPDATE founder_feedback_drafts SET status='applied',applied_at=? WHERE id=? AND status='pending'")
      .run(stamp.toISOString(),draft.id);if(applied.changes!==1)throw new TopicVersionConflictError();
    if(options.cancelPendingFeedbackKey){
      const expected=`founder-feedback:${original.chatId}:${original.messageId}`;
      if(options.cancelPendingFeedbackKey!==expected)throw new Error('FOUNDER_FEEDBACK_OUTBOX_KEY_MISMATCH');
      const row=client.prepare('SELECT status,payload FROM outbox WHERE idempotency_key=?').get(expected) as {status:string;payload:string}|undefined;
      let payload:unknown;try{payload=row?JSON.parse(row.payload):null}catch{payload=null}
      if(!row||row.status!=='pending'||!payload||typeof payload!=='object'||
        (payload as {kind?:unknown}).kind!=='founder_feedback'||(payload as {targetChatId?:unknown}).targetChatId!==original.chatId)
        throw new Error('FOUNDER_FEEDBACK_OUTBOX_NOT_EXACT_PENDING');
      const cancelled=client.prepare(`UPDATE outbox SET status='cancelled',next_attempt_at=NULL,
        last_error_code='SUPERSEDED_BY_APPROVED_BATCH_CORRECTION' WHERE idempotency_key=? AND status='pending'`).run(expected);
      if(cancelled.changes!==1)throw new Error('FOUNDER_FEEDBACK_OUTBOX_CANCEL_CONFLICT');
    }
    return result;
  }).immediate()}catch(error){if(error instanceof TopicVersionConflictError||(error&&typeof error==='object'&&'code'in error&&
    typeof error.code==='string'&&error.code.startsWith('SQLITE_BUSY')))return staleFeedback();throw error}
}

export function parseFounderBatchCorrection(text:string,binding:FounderWorkMapMessage,client:Database.Database):FounderBatchOperation[]|null{
  if(!text.includes('\n')&&!/(?:#[1-9]\d*.*){2,}/u.test(text))return null;
  const topicRefs=binding.itemRefs.filter((item):item is typeof item&{kind:'topic';expectedVersion:number}=>item.kind==='topic'&&Boolean(item.expectedVersion));
  const byNumber=new Map(topicRefs.map(ref=>[ref.displayedNumber,{id:ref.id,expectedVersion:ref.expectedVersion}]));
  const repository=new TopicRepository(client),current=repository.listCurrentTopics(),byId=new Map(current.map(topic=>[topic.id,topic]));
  const operations:FounderBatchOperation[]=[];
  for(const rawLine of text.normalize('NFKC').split(/\n+/u)){const line=rawLine.trim();if(!line)continue;
    const numbers=[...line.matchAll(/#\s*([1-9]\d*)/gu)].map(match=>Number(match[1]));
    const refs=[...new Map(numbers.flatMap(number=>{const ref=byNumber.get(number);return ref?[[ref.id,ref] as const]:[]})).values()];
    if(refs.length>=2&&/(?:同一个|同一工作流)/u.test(line)){
      const named=refs.find(ref=>byId.get(ref.id)?.displayName==='教育视频系列');
      const fallback=numbers.includes(11)?byNumber.get(11):refs[0];const canonical=named??fallback;
      if(canonical){operations.push({kind:'merge_topics',topics:refs,canonicalTopic:canonical});
        if(/(?:Space|迁移|删除|不再显示)/iu.test(line))operations.push({kind:'set_visibility',topics:refs,visibility:'space_managed'});}
      continue;
    }
    if(refs.length===1){const ref=refs[0]!,topic=byId.get(ref.id);if(!topic)continue;
      if(topic.stage==='closed'&&/(?:已结束|无需重复)/u.test(line))continue;
      let stage:typeof topic.stage|undefined;
      if(/(?:不能作为独立项目|只是观点|只是想法)/u.test(line))stage='idea';
      else if(/(?:暂停|暂且不再投入精力)/u.test(line))stage='paused';
      else if(/(?:close|已完成未发布|标注为已完成|(?:改为|标注为|标为|设为)\s*已?(?:结束|关闭)|(?:→|->|>)\s*已?(?:结束|关闭))/iu.test(line))stage='closed';
      else if(/(?:继续保持|正在实现|当前正在)/u.test(line)&&topic.stage!=='active_project')stage='active_project';
      let outcome=cleanOutcome(line,numbers[0]!,topic.displayName);
      // "→ 结束" / "改为已结束，原因…" only change the stage; keep any reason after it as the current direction.
      if(stage==='closed')outcome=outcome.replace(/^(?:(?:→|->|>)\s*)?(?:(?:改为|标注为|标为|设为)\s*)?已?(?:结束|关闭)[，,。；;:：\s]*/u,'').trim();
      if(stage===topic.stage&&/(?:已经是|无需重复)/u.test(line))continue;
      if(!stage&&!outcome)continue;
      operations.push({kind:'update_topic',topic:ref,...(stage?{stage}:{}),...(outcome?{outcome}:{})});continue;
    }
    if(/给静姐和\s*Kenny\s*哥\s*update/iu.test(line)){
      const matches=current.filter(topic=>/给静姐和\s*Kenny\s*哥\s*update/iu.test(topic.displayName)&&
        repository.listVersions(topic.id).some(version=>version.rationale==='Ivy confirmed Founder work map task'));
      if(matches.length===1&&matches[0]!.stage!=='closed')operations.push({kind:'update_topic',
        topic:{id:matches[0]!.id,expectedVersion:matches[0]!.currentVersion},stage:'closed',outcome:'本轮 update 已完成'});
    }
    if(/阶段目标\s*[|｜]?\s*飞书第一阶段目标/u.test(line)){
      const matches=current.filter(topic=>topic.displayName==='飞书第一阶段目标'&&
        repository.listVersions(topic.id).some(version=>version.rationale==='Ivy confirmed Founder work map goal'));
      if(matches.length===1){const outcome=line.slice(line.indexOf('飞书第一阶段目标')+'飞书第一阶段目标'.length)
        .replace(/^[（(]\s*/u,'').replace(/[）)]\s*$/u,'').trim();
        if(outcome)operations.push({kind:'update_topic',topic:{id:matches[0]!.id,expectedVersion:matches[0]!.currentVersion},outcome});}
    }
    if(/(?:不用单独再展示正在推进的项目|未归入\s*A\/B\/C.*不形成第四个项目列表)/iu.test(line))
      operations.push({kind:'set_work_map_preference',hideOrphanActive:true});
  }
  const parsed=founderBatchOperationsSchema.safeParse(dedupeOperations(operations));
  return parsed.success?parsed.data:null;
}

function cleanOutcome(line:string,number:number,name:string):string{
  let value=line.replace(new RegExp(`^.*?#\\s*${number}\\s*[·.、|｜:：\\-]*\\s*`,'u'),'').trim();
  value=value.replace(/^(?:项目|子项目)\s*[|｜:：]\s*/u,'').trim();
  const nameAt=value.indexOf(name);if(nameAt>=0)value=value.slice(nameAt+name.length).replace(/^[，,:：|｜\s]+/u,'').trim();
  if(/^[（(].*[）)]$/u.test(value))value=value.slice(1,-1).trim();
  return value.slice(0,800);
}
function dedupeOperations(operations:FounderBatchOperation[]):FounderBatchOperation[]{
  const seen=new Set<string>();return operations.filter(operation=>{const key=canonicalJson(operation);if(seen.has(key))return false;seen.add(key);return true});
}
function draftDecision(id:string,count:number,duplicate:boolean):FounderFeedbackDecision{return{kind:duplicate?'duplicate':'drafted',
  correctionKind:'batch_correction',status:'pending_confirmation',draftId:id,
  text:`已整理为 ${count} 项修正草稿，尚未写入。确认无误后回复“确认修正 ${id}”；如需调整，重新回复原工作地图。`}}
function findDraft(client:Database.Database,chatId:string,id:string):DraftRow|undefined{
  return client.prepare('SELECT * FROM founder_feedback_drafts WHERE chat_id=? AND id=?').get(chatId,id) as DraftRow|undefined;
}
function feedbackHash(input:FounderFeedbackInput):string{return sha256(canonicalJson(input))}

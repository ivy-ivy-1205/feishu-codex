import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createSqliteDatabase } from '../src/db/client.js';
import { migrateDatabase } from '../src/db/migrate.js';
import { JobRepository } from '../src/repositories/job-repository.js';
import { ContextSourceRepository } from '../src/repositories/context-source-repository.js';
import { TopicRepository } from '../src/repositories/topic-repository.js';
import { createFounderStreamRuntime } from '../src/services/founder-stream-worker.js';
import type { FounderStreamInput, TopicProposal } from '../src/ports/founder-stream-analyzer.js';
import { captureGroupMessageSource } from '../src/services/group-message-source-capture.js';
import { buildFounderStreamInput, saveFounderEvidence } from '../src/services/founder-stream-worker.js';
import { AlignmentRepository } from '../src/repositories/alignment-repository.js';
import { OutboxRepository } from '../src/repositories/outbox-repository.js';
import { renderFounderWorkMap } from '../src/services/founder-work-map-renderer.js';
import { applyTopicCorrection, type TopicCorrection } from '../src/services/topic-correction-service.js';
import { FounderStreamValidationError } from '../src/ports/founder-stream-analyzer.js';
import { CodexCliError } from '../src/adapters/codex-cli.js';
import { sha256 } from '../src/services/canonical-json.js';

const chat = 'oc_a84d5b6ca478220d0a37964b50776edb';
const start = new Date('2026-09-21T00:00:00.000Z');
function harness(flags = { captureEnabled: true, analysisEnabled: true, groupDeliveryEnabled: false }, attachmentReader?: {
  read(input:{messageId:string;fileKey:string;fileName:string}):Promise<{body:Buffer;mimeType:string}>
}) {
  const db = createSqliteDatabase(':memory:'); migrateDatabase(db.client);
  const jobs = new JobRepository(db.client); const topics = new TopicRepository(db.client);
  const sources = new ContextSourceRepository(db.client);
  let now = start, calls = 0;
  const inputs: FounderStreamInput[] = [];
  const runtime = createFounderStreamRuntime({ client: db.client, jobRepository: jobs, flags,
    approvedChatIds: [chat], ivyPrivateChatId: 'oc_private', now: () => now,
    attachmentReader, analyzer: { async analyze(input) { calls++; inputs.push(input); return { topics: [{
      displayName: '知识库', stage: 'idea', outcome: null, currentAction: null, confidence: 'high',
      sourceIds: [input.sources[0]!.id], evidenceExcerpts: [{ sourceId: input.sources[0]!.id, excerpt: '知识库' }],
      joinDecision: input.currentTopics.length ? { kind: 'exact_continuation', topicId: input.currentTopics[0]!.id,
        confidence: 'high', sharedTerms: ['知识库'] } : { kind: 'new', topicId: null, confidence: 'high', sharedTerms: [] }, splitSuggestions: []
    }] }; } }
  });
  const app = buildApp({ readiness: () => ({ ready: true }), verificationToken: 'verify', encryptKey: 'encrypt',
    logger: false, ingestMinute: () => ({ status: 'ignored' }), routeReply: () => ({ kind: 'reject', reason: 'wrong_chat' }),
    founderStream: runtime.route, founderStreamDiagnostics: { client: db.client } });
  return { db, jobs, sources, topics, runtime, app, inputs, calls: () => calls, setNow: (value: Date) => { now = value; } };
}
function event(id = 'om_1', eventId = `evt_${id}`, thread = '', sender = 'user', chatId = chat) {
  return { schema: '2.0', header: { token: 'verify', event_id: eventId, event_type: 'im.message.receive_v1', create_time: String(start.getTime()) },
    event: { sender: { sender_type: sender, sender_id: { open_id: 'ou_ivy' } }, message: {
      message_id: id, chat_id: chatId, chat_type: 'group', thread_id: thread, message_type: 'text',
      content: JSON.stringify({ text: `知识库 ${id}` }), create_time: String(start.getTime()) } } };
}
describe('founder stream durable wiring', () => {
  it('persists only an allowlisted stage and code when topic analysis fails', async () => {
    const h=harness();
    const source=h.sources.saveSource(captureGroupMessageSource({chatId:chat,messageId:'om_failure',threadId:null,rootId:null,
      author:{openId:'ou_ivy',displayName:null},senderType:'user',messageType:'text',text:'private source text',occurredAt:start.toISOString()},start).source).source;
    const runtime=createFounderStreamRuntime({client:h.db.client,jobRepository:h.jobs,
      flags:{captureEnabled:true,analysisEnabled:true,groupDeliveryEnabled:false},approvedChatIds:[chat],ivyPrivateChatId:'oc_private',now:()=>start,
      analyzer:{async analyze(){throw new FounderStreamValidationError('FOUNDER_STREAM_OUTPUT_INVALID','excerpt_ungrounded')}}});
    const queued=h.jobs.enqueueFounderStreamBatch({chatId:chat,since:start.toISOString(),until:start.toISOString(),sourceIds:[source.id],capturedAt:start});
    await runtime.runOnce();
    const row=h.db.client.prepare('SELECT payload,status FROM batch_jobs WHERE stable_key=?').get(queued.key) as {payload:string;status:string};
    expect(row.status).toBe('retry');expect(JSON.parse(row.payload)).toMatchObject({failureStage:'topic_analysis',failureCode:'grounding_invalid'});
    expect(row.payload).not.toContain('private source text');expect(row.payload).not.toContain('excerpt_ungrounded');
    await h.app.close();h.db.close();
  });
  it('classifies classifier execution failures without persisting their message', async () => {
    const h=harness();const source=h.sources.saveSource(captureGroupMessageSource({chatId:chat,messageId:'om_classifier_failure',threadId:null,rootId:null,
      author:{openId:'ou_ivy',displayName:null},senderType:'user',messageType:'text',text:'知识库',occurredAt:start.toISOString()},start).source).source;
    const runtime=createFounderStreamRuntime({client:h.db.client,jobRepository:h.jobs,
      flags:{captureEnabled:true,analysisEnabled:true,groupDeliveryEnabled:false},approvedChatIds:[chat],ivyPrivateChatId:'oc_private',now:()=>start,
      analyzer:{async analyze(){return{topics:[]}}},classifier:{async classify(){throw new CodexCliError('CODEX_EXECUTION_FAILED','private stderr')}}});
    const queued=h.jobs.enqueueFounderStreamBatch({chatId:chat,since:start.toISOString(),until:start.toISOString(),sourceIds:[source.id],capturedAt:start});
    await runtime.runOnce();const payload=(h.db.client.prepare('SELECT payload FROM batch_jobs WHERE stable_key=?').get(queued.key) as {payload:string}).payload;
    expect(JSON.parse(payload)).toMatchObject({failureStage:'semantic_classification',failureCode:'codex_execution_failed'});
    expect(payload).not.toContain('private stderr');await h.app.close();h.db.close();
  });
  it('separates evidence preparation failures from pure topic reconciliation',async()=>{
    const h=harness();const saved=h.sources.saveSource({sourceSystem:'feishu',sourceType:'group_message',externalId:'om_bad_locator',
      logicalKey:'bad-locator',occurredAt:start.toISOString(),capturedAt:start,authors:[],locatorUri:null,contentFormat:'text/plain',
      contentText:'知识库',metadata:{chatId:chat,senderType:'user',threadId:42},availabilityStatus:'available'}).source;
    const runtime=createFounderStreamRuntime({client:h.db.client,jobRepository:h.jobs,
      flags:{captureEnabled:true,analysisEnabled:true,groupDeliveryEnabled:false},approvedChatIds:[chat],ivyPrivateChatId:'oc_private',now:()=>start,
      analyzer:{async analyze(){return{topics:[{displayName:'知识库',stage:'idea',outcome:null,currentAction:null,confidence:'high',
        sourceIds:[saved.id],evidenceExcerpts:[{sourceId:saved.id,excerpt:'知识库'}],
        joinDecision:{kind:'new',topicId:null,confidence:'high',sharedTerms:[]},splitSuggestions:[]}]}}}});
    const queued=h.jobs.enqueueFounderStreamBatch({chatId:chat,since:start.toISOString(),until:start.toISOString(),sourceIds:[saved.id],capturedAt:start});
    await runtime.runOnce();const payload=(h.db.client.prepare('SELECT payload FROM batch_jobs WHERE stable_key=?').get(queued.key) as {payload:string}).payload;
    expect(JSON.parse(payload)).toMatchObject({failureStage:'evidence_preparation',failureCode:'unknown'});
    await h.app.close();h.db.close();
  });
  it('reuses immutable evidence when joining instead of rebuilding legacy minute locators',async()=>{
    const h=harness();
    const minute=h.sources.saveSource({sourceSystem:'feishu',sourceType:'minute_transcript',externalId:'minute_legacy',logicalKey:'minute_legacy',
      occurredAt:start.toISOString(),capturedAt:start,authors:[],locatorUri:null,contentFormat:'text/plain',contentText:'知识库',
      metadata:{founderStreamEligible:true,founderStreamChatId:chat},availabilityStatus:'available'}).source;
    h.db.client.prepare(`INSERT INTO context_evidence(id,source_id,source_version,excerpt,locator_json,excerpt_hash,evidence_level,captured_at)
      VALUES('ctxev_legacy',?,1,'知识库','{"kind":"minute_segment","segmentOrdinal":0,"sourceVersion":1,"contentHash":"${minute.contentHash}","speakerName":"Ivy","startMs":0,"endMs":1}',?,'primary_statement',?)`)
      .run(minute.id,sha256('知识库'),start.toISOString());
    const topic=h.topics.createTopic({displayName:'知识库',stage:'idea',evidenceIds:['ctxev_legacy'],createdAt:start});
    const fresh=h.sources.saveSource(captureGroupMessageSource({chatId:chat,messageId:'om_join',threadId:null,rootId:null,
      author:{openId:'ou_ivy',displayName:null},senderType:'user',messageType:'text',text:'知识库',occurredAt:start.toISOString()},start).source).source;
    const runtime=createFounderStreamRuntime({client:h.db.client,jobRepository:h.jobs,
      flags:{captureEnabled:true,analysisEnabled:true,groupDeliveryEnabled:false},approvedChatIds:[chat],ivyPrivateChatId:'oc_private',now:()=>start,
      analyzer:{async analyze(){return{topics:[{displayName:'知识库',stage:'idea',outcome:null,currentAction:null,confidence:'high',
        sourceIds:[fresh.id],evidenceExcerpts:[{sourceId:fresh.id,excerpt:'知识库'}],
        joinDecision:{kind:'exact_continuation',topicId:topic.id,confidence:'high',sharedTerms:['知识库']},splitSuggestions:[]}]}}}});
    const queued=h.jobs.enqueueFounderStreamBatch({chatId:chat,since:start.toISOString(),until:start.toISOString(),sourceIds:[fresh.id],capturedAt:start});
    await runtime.runOnce();
    const row=h.db.client.prepare('SELECT status,payload FROM batch_jobs WHERE stable_key=?').get(queued.key) as {status:string;payload:string};
    expect(row.status).toBe('completed');
    expect(h.topics.listCurrentTopics()[0]!.evidenceIds).toEqual(expect.arrayContaining(['ctxev_legacy']));
    await h.app.close();h.db.close();
  });
  it('applies semantic classification before persisting the active project map', async () => {
    const h=harness();
    const rows=['AI native 房产业务','VibeVoice'].map((text,index)=>h.sources.saveSource(captureGroupMessageSource({chatId:chat,
      messageId:`om_class_${index}`,threadId:null,rootId:null,author:{openId:'ou_ivy',displayName:null},senderType:'user',
      messageType:'text',text,occurredAt:start.toISOString()},start).source).source);
    const runtime=createFounderStreamRuntime({client:h.db.client,jobRepository:h.jobs,
      flags:{captureEnabled:true,analysisEnabled:true,groupDeliveryEnabled:false},approvedChatIds:[chat],ivyPrivateChatId:'oc_private',
      now:()=>new Date(start.getTime()+600_000),analyzer:{async analyze(){return{topics:rows.map((source,index)=>({
        displayName:source.contentText,stage:'exploring' as const,outcome:null,currentAction:null,confidence:'high' as const,
        sourceIds:[source.id],evidenceExcerpts:[{sourceId:source.id,excerpt:source.contentText}],
        joinDecision:{kind:'new' as const,topicId:null,confidence:'high' as const,sharedTerms:[]},splitSuggestions:[]}))}}},
      classifier:{async classify(){return{items:[
        {proposalIndex:0,kind:'project' as const,lifecycle:'active' as const,parentProposalIndex:null},
        {proposalIndex:1,kind:'research' as const,lifecycle:'unknown' as const,parentProposalIndex:null}
      ]}}}});
    h.jobs.enqueueFounderStreamBatch({chatId:chat,since:start.toISOString(),until:start.toISOString(),sourceIds:rows.map(r=>r.id),capturedAt:start});
    await runtime.runOnce();
    expect(h.topics.listCurrentTopics().map(topic=>topic.displayName)).toEqual(['AI native 房产业务']);
    await h.app.close();h.db.close();
  });
  it('aggregates every same-target protected proposal once with stable deduplicated evidence and suggestions',async()=>{
    const run=async(reverse:boolean)=>{
      const h=harness();new AlignmentRepository(h.db.client).configureFounderIdentity({founder:'ivy',sourceSystem:'feishu',externalAuthorId:'ou_ivy',configuredAt:start});
      const capture=(id:string,text:string)=>h.sources.saveSource(captureGroupMessageSource({chatId:chat,messageId:id,threadId:null,rootId:null,
        author:{openId:'ou_ivy',displayName:null},senderType:'user',messageType:'text',text,occurredAt:start.toISOString()},start).source).source;
      const originals=['知识库','网站'].map((name,index)=>{
        const source=capture(`om_prior_${index}`,name);
        return{source,topic:h.topics.createTopic({displayName:name,stage:'idea',evidenceIds:[saveFounderEvidence(h.sources,source.id,name,start)],createdAt:start})};
      });
      const outbox=new OutboxRepository(h.db.client);
      const map=renderFounderWorkMap({since:'2026-09-01T00:00:00Z',until:start.toISOString(),topics:originals.map(({topic})=>({...topic,evidence:[]})),uncertainGrouping:[],coverageGaps:[]})[0]!;
      outbox.enqueueFounderWorkMap({...map,mapId:'multi',targetChatId:chat},start);outbox.acknowledgeFounderWorkMapDelivery({mapId:'multi',page:1,messageId:'om_multi_map',deliveredAt:start});
      const proposals:TopicProposal[]=[];const sourceIds=originals.map(o=>o.source.id);
      for(const {topic} of originals){
        expect(applyTopicCorrection({chatId:chat,openId:'ou_ivy',messageId:`om_pause_${topic.id}`,replyTo:'om_multi_map',text:`${topic.displayName} 暂停`,occurredAt:new Date(start.getTime()+1000).toISOString()},
          {kind:'pause_topic',topic:{id:topic.id,expectedVersion:1}},{client:h.db.client,approvedChatIds:[chat],now:()=>new Date(start.getTime()+1000)}).kind).toBe('corrected');
        for(const variant of ['A','B']){
          const name=`${topic.displayName}方案${variant}`;const source=capture(`om_${topic.id}_${variant}`,name);sourceIds.push(source.id);
          proposals.push({displayName:name,stage:'idea',outcome:null,currentAction:null,confidence:'high',sourceIds:[source.id],evidenceExcerpts:[{sourceId:source.id,excerpt:name}],
            joinDecision:{kind:'exact_continuation',topicId:topic.id,confidence:'high',sharedTerms:[topic.displayName]},splitSuggestions:[]});
        }
      }
      proposals.push(proposals[0]!);if(reverse)proposals.reverse();
      const runtime=createFounderStreamRuntime({client:h.db.client,jobRepository:h.jobs,flags:{captureEnabled:true,analysisEnabled:true,groupDeliveryEnabled:false},approvedChatIds:[chat],ivyPrivateChatId:'oc_private',now:()=>new Date(start.getTime()+600_000),analyzer:{async analyze(){return{topics:proposals}}}});
      const batch={chatId:chat,since:start.toISOString(),until:start.toISOString(),sourceIds:[...sourceIds,sourceIds[0]!],capturedAt:start};
      const queued=h.jobs.enqueueFounderStreamBatch(batch);await runtime.runOnce();
      expect(h.db.client.prepare('SELECT status FROM batch_jobs WHERE stable_key=?').get(queued.key)).toEqual({status:'completed'});
      expect(h.jobs.enqueueFounderStreamBatch(batch).created).toBe(false);await runtime.runOnce();
      const current=h.topics.listCurrentTopics();expect(current).toHaveLength(2);
      for(const topic of current){
        expect(topic.currentVersion).toBe(3);expect(topic.stage).toBe('paused');expect(topic.evidenceIds).toHaveLength(4);
        expect(new Set(topic.evidenceIds).size).toBe(4);
        expect(JSON.parse(topic.rationale).suggestions.map((s:{displayName:string})=>s.displayName)).toEqual([`${topic.displayName}方案A`,`${topic.displayName}方案B`]);
        expect(h.topics.listVersions(topic.id)).toHaveLength(3);
      }
      await h.app.close();h.db.close();return current;
    };
    expect(await run(false)).toEqual(await run(true));
  });
  it.each(['pause_topic','reclassify_stage','rename_topic'] as const)('keeps %s authoritative against old and newer automatic proposals', async kind => {
    const h=harness();new AlignmentRepository(h.db.client).configureFounderIdentity({founder:'ivy',sourceSystem:'feishu',externalAuthorId:'ou_ivy',configuredAt:start});
    const original=h.sources.saveSource(captureGroupMessageSource({chatId:chat,messageId:'om_old',threadId:null,rootId:null,
      author:{openId:'ou_ivy',displayName:null},senderType:'user',messageType:'text',text:'知识库 今天开始制作演示，交付演示稿，或交付替代稿',occurredAt:start.toISOString()},start).source).source;
    const topic=h.topics.createTopic({displayName:'知识库',stage:'active_project',outcome:'交付演示稿',evidenceIds:[saveFounderEvidence(h.sources,original.id,original.contentText,start)],createdAt:start});
    const map=renderFounderWorkMap({since:'2026-09-01T00:00:00Z',until:start.toISOString(),topics:[{...topic,evidence:[]}],uncertainGrouping:[],coverageGaps:[]})[0]!;
    const outbox=new OutboxRepository(h.db.client);outbox.enqueueFounderWorkMap({...map,mapId:'authority',targetChatId:chat},start);
    outbox.acknowledgeFounderWorkMapDelivery({mapId:'authority',page:1,messageId:'om_authority_map',deliveredAt:start});
    const correction={kind,topic:{id:topic.id,expectedVersion:1},...(kind==='rename_topic'?{name:'销售知识库'}:kind==='reclassify_stage'?{stage:'idea'}:{})} as TopicCorrection;
    expect(applyTopicCorrection({chatId:chat,openId:'ou_ivy',messageId:'om_authority',replyTo:'om_authority_map',text:'知识库：更名销售知识库，暂停，不作为项目',occurredAt:new Date(start.getTime()+1000).toISOString()},correction,
      {client:h.db.client,approvedChatIds:[chat],now:()=>new Date(start.getTime()+1000)}).kind).toBe('corrected');
    const corrected=h.topics.listCurrentTopics()[0]!;
    const runtime=createFounderStreamRuntime({client:h.db.client,jobRepository:h.jobs,flags:{captureEnabled:true,analysisEnabled:true,groupDeliveryEnabled:false},approvedChatIds:[chat],ivyPrivateChatId:'oc_private',now:()=>new Date(start.getTime()+600_000),
      analyzer:{async analyze(input){const source=input.sources[0]!;return{topics:[{displayName:'知识库',stage:'active_project',outcome:'交付替代稿',currentAction:'今天开始制作演示',confidence:'high',sourceIds:[source.id],evidenceExcerpts:[{sourceId:source.id,excerpt:source.contentText}],joinDecision:{kind:'exact_continuation',topicId:topic.id,confidence:'high',sharedTerms:['知识库']},splitSuggestions:[]}]}}}});
    for(const [index,source] of [original,h.sources.saveSource(captureGroupMessageSource({chatId:chat,messageId:'om_new',threadId:null,rootId:null,author:{openId:'ou_ivy',displayName:null},senderType:'user',messageType:'text',text:original.contentText,occurredAt:new Date(start.getTime()+2000).toISOString()},start).source).source].entries()){
      h.jobs.enqueueFounderStreamBatch({chatId:chat,since:start.toISOString(),until:start.toISOString(),sourceIds:[source.id],capturedAt:start});
      await runtime.runOnce();
      expect(h.topics.listCurrentTopics()).toHaveLength(1);
      expect(h.topics.listCurrentTopics()[0]).toMatchObject({displayName:corrected.displayName,stage:corrected.stage,outcome:corrected.outcome});
      expect(h.topics.listCurrentTopics()[0]!.rationale).toContain('needs_confirmation');
      expect(JSON.parse(h.topics.listCurrentTopics()[0]!.rationale).suggestion.evidenceAfterCorrection).toBe(index===1);
      expect(h.topics.listCurrentTopics()[0]!.evidenceIds.length).toBeGreaterThanOrEqual(2+index);
    }
    expect(h.db.client.prepare('SELECT count(*) n FROM founder_feedback_corrections').get()).toEqual({n:1});
    await h.app.close();h.db.close();
  });
  it('recovers a completed capture-only interval once after enabling analysis and restarting', async () => {
    const h=harness({captureEnabled:true,analysisEnabled:false,groupDeliveryEnabled:false});
    for(let i=0;i<25;i++){await h.app.inject({method:'POST',url:'/webhooks/feishu/events',payload:event(`om_recover_${i}`)});await h.runtime.runOnce();}
    const ids=h.sources.listSources().map(s=>s.id);const seen=new Set<string>();let calls=0;
    const create=()=>createFounderStreamRuntime({client:h.db.client,jobRepository:h.jobs,flags:{captureEnabled:true,analysisEnabled:true,groupDeliveryEnabled:false},approvedChatIds:[chat],ivyPrivateChatId:'oc_private',now:()=>new Date(start.getTime()+600_000),
      analyzer:{async analyze(input){calls++;for(const source of input.sources)seen.add(source.id);return{topics:[]}}}});
    let runtime=create();await runtime.afterTick();runtime=create();
    for(let i=0;i<6;i++)await runtime.runOnce();
    expect([...seen].sort()).toEqual(ids.sort());expect(calls).toBe(2);
    const rows=h.db.client.prepare("SELECT payload FROM batch_jobs WHERE type='analyze_founder_stream_batch'").all();
    expect(JSON.stringify(rows)).not.toContain('知识库');expect(rows).toHaveLength(2);
    await runtime.afterTick();expect(h.db.client.prepare("SELECT count(*) n FROM batch_jobs WHERE type='analyze_founder_stream_batch'").get()).toEqual({n:2});
    await h.app.close();h.db.close();
  });
  it.each([['audio','VOICE_TEXT_MISSING'],['voice','VOICE_TEXT_MISSING'],['file','FILE_TEXT_UNREADABLE'],['media','MEDIA_SKIPPED'],['text','MESSAGE_TEXT_UNAVAILABLE']])('persists a typed live %s gap once without forwarding media or IDs to diagnostics',async(messageType,code)=>{
    const h=harness();const payload=event('om_media');Object.assign(payload.event.message,{message_type:messageType,content:'{"file_key":"secret_file_key"}'});
    await h.app.inject({method:'POST',url:'/webhooks/feishu/events',payload});await h.app.inject({method:'POST',url:'/webhooks/feishu/events',payload});
    const sources=h.sources.listSources();expect(sources).toHaveLength(2);
    expect(sources.find(s=>s.sourceType==='group_message')).toMatchObject({externalId:'om_media',availabilityStatus:'unknown',contentText:'',metadata:{messageType,senderType:'user'}});
    expect(JSON.parse(sources.find(s=>s.sourceType==='feishu_sync_gap')!.contentText)).toMatchObject({code});
    const diag=await h.app.inject({method:'GET',url:'/diag/founder-stream'});expect(diag.json().gapsByCode).toEqual({[code]:1});
    expect(diag.body).not.toContain('om_media');expect(JSON.stringify(sources)).not.toContain('secret_file_key');
    await h.runtime.runOnce();expect(h.calls()).toBe(0);expect(h.jobs.list()).toHaveLength(0);await h.app.close();h.db.close();
  });
  it('queues a file resource during webhook handling and persists only parsed text with 90-day retention in the worker',async()=>{
    let reads=0;const h=harness(undefined,{async read(input){reads++;expect(input).toEqual({messageId:'om_file',fileKey:'secret_file_key',fileName:'brief.md'});
      return{body:Buffer.from('# 方案\n合伙人对齐室'),mimeType:'text/markdown'}}});
    const payload=event('om_file');Object.assign(payload.event.message,{message_type:'file',content:JSON.stringify({file_key:'secret_file_key',file_name:'brief.md'})});
    const response=await h.app.inject({method:'POST',url:'/webhooks/feishu/events',payload});
    expect(response.json()).toMatchObject({status:'attachment_queued'});expect(reads).toBe(0);
    expect(h.jobs.list()).toEqual([expect.objectContaining({kind:'capture_founder_attachment',messageId:'om_file',fileName:'brief.md'})]);
    await h.runtime.runOnce();expect(reads).toBe(1);
    const parsed=h.sources.listSources().find(source=>source.externalId==='om_file:file');
    expect(parsed).toMatchObject({sourceType:'group_message',contentText:'# 方案\n合伙人对齐室',availabilityStatus:'available',
      rawTextExpiresAt:'2026-12-20T00:00:00.000Z',metadata:{chatId:chat,messageId:'om_file',messageType:'file',senderType:'user',attachmentTitle:'brief.md'}});
    expect(JSON.stringify(h.sources.listSources())).not.toContain('secret_file_key');
    expect(h.jobs.list()).toEqual(expect.arrayContaining([expect.objectContaining({kind:'capture_group_message',sourceIds:[parsed!.id]})]));
    await h.app.close();h.db.close();
  });
  it('records a typed gap and completes an unsupported attachment without exposing its resource key',async()=>{
    const h=harness(undefined,{async read(){return{body:Buffer.from('binary'),mimeType:'application/pdf'}}});
    const payload=event('om_pdf');Object.assign(payload.event.message,{message_type:'file',content:JSON.stringify({file_key:'secret_pdf_key',file_name:'brief.pdf'})});
    await h.app.inject({method:'POST',url:'/webhooks/feishu/events',payload});await h.runtime.runOnce();
    const gap=h.sources.listSources().find(source=>source.sourceType==='feishu_sync_gap');
    expect(JSON.parse(gap!.contentText)).toMatchObject({code:'FILE_TEXT_UNREADABLE',reason:'ATTACHMENT_TYPE_UNSUPPORTED'});
    expect(JSON.stringify(h.sources.listSources())).not.toContain('secret_pdf_key');
    expect(h.db.client.prepare("SELECT status FROM batch_jobs WHERE type='capture_founder_attachment'").get()).toEqual({status:'completed'});
    await h.app.close();h.db.close();
  });
  it('bounds attachment read retries and records a safe terminal gap',async()=>{
    const h=harness(undefined,{async read(){throw new Error('remote private failure')}}),payload=event('om_failed_file');
    Object.assign(payload.event.message,{message_type:'file',content:JSON.stringify({file_key:'secret_failed_key',file_name:'brief.md'})});
    await h.app.inject({method:'POST',url:'/webhooks/feishu/events',payload});
    for(const offset of [0,30_000,60_000]){h.setNow(new Date(start.getTime()+offset));await h.runtime.runOnce()}
    const gap=h.sources.listSources().find(source=>source.sourceType==='feishu_sync_gap');
    expect(JSON.parse(gap!.contentText)).toMatchObject({code:'FILE_TEXT_UNREADABLE',reason:'ATTACHMENT_READ_FAILED'});
    expect(JSON.stringify(h.sources.listSources())).not.toMatch(/secret_failed_key|remote private failure/);
    expect(h.db.client.prepare("SELECT status FROM batch_jobs WHERE type='capture_founder_attachment'").get()).toEqual({status:'completed'});
    await h.app.close();h.db.close();
  });
  it.each(['audio','voice'])('uses an existing platform %s text transcript without reading a media resource',async messageType=>{
    const h=harness();const payload=event();Object.assign(payload.event.message,{message_type:messageType,content:JSON.stringify({text:'知识库 语音转文字',file_key:'must_not_read'})});
    await h.app.inject({method:'POST',url:'/webhooks/feishu/events',payload});await h.runtime.runOnce();h.setNow(new Date(start.getTime()+300_000));await h.runtime.runOnce();
    expect(h.calls()).toBe(1);expect(h.sources.listSources()[0]).toMatchObject({contentText:'知识库 语音转文字',metadata:{messageType}});
    expect(h.sources.listSources().some(s=>s.sourceType==='feishu_sync_gap')).toBe(false);
    expect(JSON.stringify(h.sources.listSources())).not.toContain('must_not_read');await h.app.close();h.db.close();
  });
  it('does not recover an older capture before the latest arrival in its thread has been quiet for 300 seconds',async()=>{
    const h=harness({captureEnabled:true,analysisEnabled:false,groupDeliveryEnabled:false});
    await h.app.inject({method:'POST',url:'/webhooks/feishu/events',payload:event()});await h.runtime.runOnce();
    h.setNow(new Date(start.getTime()+299_000));await h.app.inject({method:'POST',url:'/webhooks/feishu/events',payload:event('om_later')});await h.runtime.runOnce();
    let now=new Date(start.getTime()+300_000);let calls=0;
    const runtime=createFounderStreamRuntime({client:h.db.client,jobRepository:h.jobs,flags:{captureEnabled:true,analysisEnabled:true,groupDeliveryEnabled:false},approvedChatIds:[chat],ivyPrivateChatId:'oc_private',now:()=>now,analyzer:{async analyze(){calls++;return{topics:[]}}}});
    await runtime.afterTick();await runtime.runOnce();expect(calls).toBe(0);
    now=new Date(start.getTime()+599_000);await runtime.afterTick();await runtime.runOnce();expect(calls).toBe(1);
    await h.app.close();h.db.close();
  });
  it('extends already recovered analysis when a new webhook arrives before it is leased',async()=>{
    const h=harness({captureEnabled:true,analysisEnabled:false,groupDeliveryEnabled:false});
    await h.app.inject({method:'POST',url:'/webhooks/feishu/events',payload:event()});await h.runtime.runOnce();
    let now=new Date(start.getTime()+600_000);let calls=0;
    const runtime=createFounderStreamRuntime({client:h.db.client,jobRepository:h.jobs,flags:{captureEnabled:true,analysisEnabled:true,groupDeliveryEnabled:false},approvedChatIds:[chat],ivyPrivateChatId:'oc_private',now:()=>now,analyzer:{async analyze(){calls++;return{topics:[]}}}});
    await runtime.afterTick();runtime.route.ingest(event('om_new_arrival'));await runtime.runOnce();await runtime.runOnce();expect(calls).toBe(0);
    now=new Date(start.getTime()+900_000);await runtime.runOnce();expect(calls).toBe(1);await h.app.close();h.db.close();
  });
  it('recovers legacy user sources without a handoff but excludes unknown, bot and unavailable sources',async()=>{
    const h=harness();const eligible:string[]=[];
    for(const senderType of ['user','app','unknown'] as const){
      for(const availabilityStatus of ['available','unknown'] as const){
        const captured=captureGroupMessageSource({chatId:chat,messageId:`om_legacy_${senderType}_${availabilityStatus}`,threadId:null,rootId:null,
          author:{openId:'ou_ivy',displayName:null},senderType,messageType:'text',text:'知识库',occurredAt:start.toISOString()},start);
        const source=h.sources.saveSource({...captured.source,availabilityStatus}).source;
        if(senderType==='user'&&availabilityStatus==='available')eligible.push(source.id);
      }
    }
    h.setNow(new Date(start.getTime()+600_000));await h.runtime.afterTick();await h.runtime.runOnce();await h.runtime.runOnce();
    expect(h.calls()).toBe(1);expect(h.inputs[0]!.sources.map(s=>s.id)).toEqual(eligible);expect(h.sources.listSources()).toHaveLength(6);
    expect(h.db.client.prepare("SELECT count(*) n FROM batch_jobs WHERE type='analyze_founder_stream_batch'").get()).toEqual({n:1});
    await h.app.close();h.db.close();
  });
  it('keeps a trusted founder rename in the next model current-topic window', async () => {
    const h=harness();new AlignmentRepository(h.db.client).configureFounderIdentity({founder:'ivy',sourceSystem:'feishu',externalAuthorId:'ou_ivy',configuredAt:start});
    const topic=h.topics.createTopic({displayName:'旧名称',stage:'idea',createdAt:start});
    const map=renderFounderWorkMap({since:'2026-09-01T00:00:00Z',until:start.toISOString(),topics:[{...topic,evidence:[]}],uncertainGrouping:[],coverageGaps:[]})[0]!;
    const outbox=new OutboxRepository(h.db.client);outbox.enqueueFounderWorkMap({...map,mapId:'rename',targetChatId:chat},start);
    outbox.acknowledgeFounderWorkMapDelivery({mapId:'rename',page:1,messageId:'om_map',deliveredAt:start});
    const correction=event('om_rename');Object.assign(correction.event.message,{parent_id:'om_map',content:JSON.stringify({text:'这个改名为新名称'})});
    await h.app.inject({method:'POST',url:'/webhooks/feishu/events',payload:correction});
    await h.app.inject({method:'POST',url:'/webhooks/feishu/events',payload:event()});await h.runtime.runOnce();
    h.setNow(new Date(start.getTime()+300_000));await h.runtime.runOnce();
    expect(h.inputs[0]?.currentTopics).toEqual(expect.arrayContaining([expect.objectContaining({id:topic.id,displayName:'新名称'})]));
    const source=h.sources.listSources().find(s=>s.externalId==='om_rename');expect(source?.metadata.senderType).toBe('user');
    await h.app.close();h.db.close();
  });
  it('reserves name and latest outcome anchors before filling the remaining window with recent trusted evidence', async () => {
    const h=harness();const ids:string[]=[];let latestSourceId='';
    for(let i=0;i<26;i++){
      const text=i===25?'交付销售演示稿':`知识库 ${i}`;
      const at=new Date(start.getTime()+i*1000);
      const source=h.sources.saveSource(captureGroupMessageSource({chatId:chat,messageId:`om_anchor_${i}`,threadId:null,rootId:null,
        author:{openId:'ou_ivy',displayName:null},senderType:'user',messageType:'text',text,occurredAt:at.toISOString()},at).source).source;
      ids.push(saveFounderEvidence(h.sources,source.id,text,at));latestSourceId=source.id;
    }
    const topic=h.topics.createTopic({displayName:'知识库',stage:'exploring',outcome:'交付销售演示稿',evidenceIds:ids,createdAt:start});
    const input=buildFounderStreamInput(h.sources,h.topics,[latestSourceId],chat);
    expect(input.currentTopics).toHaveLength(1);
    const excerpts=input.currentTopics[0]!.evidenceExcerpts.map(e=>e.excerpt);
    expect(excerpts).toContain('交付销售演示稿');expect(excerpts).toContain('知识库 24');expect(excerpts).not.toContain('知识库 0');expect(excerpts).toHaveLength(20);
    expect(h.topics.listCurrentTopics().find(t=>t.id===topic.id)?.evidenceIds).toEqual(ids);
    await h.app.close();h.db.close();
  });
  it('filters untrusted evidence without hiding a topic that still has trusted name evidence', async () => {
    const h=harness();const ids:string[]=[];let trustedSourceId='';
    for(const senderType of ['user','unknown'] as const){
      const source=h.sources.saveSource(captureGroupMessageSource({chatId:chat,messageId:`om_${senderType}`,threadId:null,rootId:null,
        author:{openId:'ou_ivy',displayName:null},senderType,messageType:'text',text:`知识库 ${senderType}`,occurredAt:start.toISOString()},start).source).source;
      ids.push(saveFounderEvidence(h.sources,source.id,'知识库',start));if(senderType==='user')trustedSourceId=source.id;
    }
    h.topics.createTopic({displayName:'知识库',stage:'idea',evidenceIds:ids,createdAt:start});
    const input=buildFounderStreamInput(h.sources,h.topics,[trustedSourceId],chat);
    expect(input.currentTopics).toHaveLength(1);expect(input.currentTopics[0]!.evidenceExcerpts).toEqual([{sourceId:trustedSourceId,excerpt:'知识库'}]);
    expect(input.sources).toHaveLength(1);expect(h.topics.listCurrentTopics()[0]?.evidenceIds).toEqual(ids);
    await h.app.close();h.db.close();
  });
  it('extends a pending analysis deadline immediately when a later webhook arrives', async () => {
    const h=harness();await h.app.inject({method:'POST',url:'/webhooks/feishu/events',payload:event()});await h.runtime.runOnce();
    h.setNow(new Date(start.getTime()+299_000));await h.app.inject({method:'POST',url:'/webhooks/feishu/events',payload:event('om_2')});
    expect(h.db.client.prepare("SELECT updated_at FROM batch_jobs WHERE type='analyze_founder_stream_batch'").get())
      .toEqual({updated_at:'2026-09-21T00:09:59.000Z'});
    h.setNow(new Date(start.getTime()+300_000));await h.runtime.runOnce();expect(h.calls()).toBe(0);
    h.setNow(new Date(start.getTime()+598_999));await h.runtime.runOnce();expect(h.calls()).toBe(0);
    h.setNow(new Date(start.getTime()+600_000));await h.runtime.runOnce();expect(h.calls()).toBe(1);
    expect(h.inputs[0]?.sources).toHaveLength(2);await h.app.close();h.db.close();
  });
  it.each(['app',undefined])('does not analyze historical sender type %s, even with an Ivy-like author ID', async senderType => {
    const h=harness();
    const captured=captureGroupMessageSource({chatId:chat,messageId:'om_history',threadId:null,rootId:null,
      author:{openId:'ou_ivy',displayName:'Ivy'},messageType:'text',text:'知识库',occurredAt:start.toISOString()},start);
    if(senderType) captured.source.metadata.senderType=senderType;
    const source=h.sources.saveSource(captured.source).source;
    h.jobs.enqueueFounderStreamBatch({chatId:chat,since:'2026-09-01T00:00:00Z',until:start.toISOString(),sourceIds:[source.id],capturedAt:start});
    await h.runtime.runOnce();expect(h.calls()).toBe(0);expect(h.topics.listCurrentTopics()).toHaveLength(0);
    expect(h.db.client.prepare('SELECT status FROM batch_jobs').get()).toEqual({status:'completed'});
    expect(h.sources.getSource(source.id)?.contentText).toBe('知识库');await h.app.close();h.db.close();
  });
  it('splits large persisted history into bounded durable batches without losing any source IDs', async () => {
    const h=harness();const ids=Array.from({length:501},(_,i)=>`ctxsrc_history_${i}`);
    h.jobs.enqueueFounderStreamBatch({chatId:chat,since:'2026-09-01T00:00:00Z',until:start.toISOString(),sourceIds:ids,capturedAt:start});
    await h.runtime.runOnce();
    const rows=h.db.client.prepare("SELECT payload FROM batch_jobs WHERE status='queued'").all() as {payload:string}[];
    expect(rows.length).toBeGreaterThan(1);
    const chunks=rows.map(r=>JSON.parse(r.payload).sourceIds as string[]);
    expect(chunks.every(c=>c.length<=20)).toBe(true);expect(chunks.flat().sort()).toEqual(ids.slice().sort());
    expect(h.calls()).toBe(0);await h.app.close();h.db.close();
  });
  it('does not reconcile or send when all stream flags are disabled', async () => {
    const h=harness();let calls=0;
    const runtime=createFounderStreamRuntime({client:h.db.client,jobRepository:h.jobs,
      flags:{captureEnabled:false,analysisEnabled:false,groupDeliveryEnabled:false},approvedChatIds:[chat],ivyPrivateChatId:'oc_private',
      policy:{reconcilePending(){calls++}}});
    await runtime.runOnce();expect(calls).toBe(0);await h.app.close();h.db.close();
  });
  it('rejects raw text in an analysis job rather than forwarding it to Codex', async () => {
    const h=harness();h.jobs.enqueueFounderStreamBatch({chatId:chat,since:'2026-09-01T00:00:00Z',until:start.toISOString(),sourceIds:['ctxsrc_fake'],capturedAt:start});
    h.db.client.prepare("UPDATE batch_jobs SET payload=json_set(payload,'$.rawText','secret chat')").run();
    await h.runtime.runOnce();expect(h.calls()).toBe(0);
    expect(h.db.client.prepare('SELECT status FROM batch_jobs').get()).toEqual({status:'failed'});
    await h.app.close();h.db.close();
  });
  it('preserves every historical evidence ID when the bounded model window joins a new source', async () => {
    const h = harness(); const evidenceIds: string[] = [];
    for (let i=0;i<25;i++) {
      const source = h.sources.saveSource(captureGroupMessageSource({ chatId:chat,messageId:`om_old_${i}`,threadId:null,rootId:null,
        author:{openId:'ou_ivy',displayName:null},senderType:'user',messageType:'text',text:`知识库 old ${i}`,occurredAt:start.toISOString() },start).source).source;
      evidenceIds.push(saveFounderEvidence(h.sources,source.id,'知识库',start));
    }
    h.topics.createTopic({ displayName:'知识库',stage:'idea',evidenceIds,createdAt:start });
    await h.app.inject({method:'POST',url:'/webhooks/feishu/events',payload:event()}); await h.runtime.runOnce();
    h.setNow(new Date(start.getTime()+300_000)); await h.runtime.runOnce();
    expect(h.inputs[0]?.currentTopics[0]?.evidenceExcerpts.length).toBeLessThanOrEqual(20);
    expect(h.topics.listCurrentTopics()[0]?.evidenceIds).toEqual(expect.arrayContaining(evidenceIds));
    expect(h.topics.listCurrentTopics()[0]?.evidenceIds).toHaveLength(26);
    await h.app.close(); h.db.close();
  });
  it('stores correction receipts durably, sends only under delivery flag and retries safely', async () => {
    const h = harness();
    new AlignmentRepository(h.db.client).configureFounderIdentity({founder:'ivy',sourceSystem:'feishu',externalAuthorId:'ou_ivy',configuredAt:start});
    const topic=h.topics.createTopic({displayName:'讨论',stage:'exploring',createdAt:start});
    const map=renderFounderWorkMap({since:'2026-09-01T00:00:00.000Z',until:start.toISOString(),topics:[{...topic,evidence:[]}],uncertainGrouping:[],coverageGaps:[]})[0]!;
    const outbox=new OutboxRepository(h.db.client); outbox.enqueueFounderWorkMap({...map,mapId:'map',targetChatId:chat},start);
    outbox.acknowledgeFounderWorkMapDelivery({mapId:'map',page:1,messageId:'om_map',deliveredAt:start});
    const payload=event(); Object.assign(payload.event.message,{parent_id:'om_map',content:JSON.stringify({text:'这个只是想法，还不是项目'})});
    await h.app.inject({method:'POST',url:'/webhooks/feishu/events',payload});
    expect(h.topics.listCurrentTopics()[0]?.stage).toBe('idea');
    expect(h.jobs.list()).toHaveLength(0);
    expect(h.db.client.prepare("SELECT status FROM outbox WHERE idempotency_key LIKE 'founder-feedback:%'").get()).toEqual({status:'pending'});
    const keys:string[]=[]; let allow=false;
    const runtime=createFounderStreamRuntime({client:h.db.client,jobRepository:h.jobs,flags:{captureEnabled:true,analysisEnabled:true,groupDeliveryEnabled:true},
      approvedChatIds:[chat],ivyPrivateChatId:'oc_private',now:()=>start,delivery:{
        async sendTextMessage(input){keys.push(input.idempotencyKey!);if(!allow)throw new Error('network');return{messageId:'om_receipt'}},
        async sendInteractiveCard(){throw new Error('unexpected card')}
      }});
    await runtime.runOnce(); expect(keys).toHaveLength(1);
    allow=true; h.db.client.prepare("UPDATE outbox SET next_attempt_at=NULL WHERE idempotency_key LIKE 'founder-feedback:%'").run();
    await runtime.runOnce(); await runtime.runOnce(); expect(keys).toEqual([`founder-feedback:${chat}:om_1`,`founder-feedback:${chat}:om_1`]);
    expect(h.db.client.prepare("SELECT status,delivered_message_id FROM outbox WHERE idempotency_key LIKE 'founder-feedback:%'").get()).toEqual({status:'delivered',delivered_message_id:'om_receipt'});
    await h.app.close(); h.db.close();
  });
  it('returns before analysis, deduplicates event and message IDs and rejects unrelated groups', async () => {
    const h = harness();
    for (const payload of [event(), event(), event('om_1', 'evt_retry'), event('om_other', 'evt_other', '', 'user', 'oc_other')]) {
      expect((await h.app.inject({ method: 'POST', url: '/webhooks/feishu/events', payload })).statusCode).toBe(200);
    }
    expect(h.calls()).toBe(0);
    expect(h.jobs.list().map(j => j.key)).toEqual(['capture_group_message:om_1']);
    expect(h.db.client.prepare('SELECT COUNT(*) n FROM context_sources').get()).toEqual({ n: 1 });
    await h.app.close(); h.db.close();
  });
  it('debounces by chat/thread for 300 seconds with ID-only analysis payload', async () => {
    const h = harness();
    for (const payload of [event('om_1'), event('om_2'), event('om_3', 'evt_3', 'omt_other')]) {
      await h.app.inject({ method: 'POST', url: '/webhooks/feishu/events', payload }); await h.runtime.runOnce();
    }
    const rows = h.db.client.prepare("SELECT payload FROM batch_jobs WHERE type = 'analyze_founder_stream_batch'").all() as { payload: string }[];
    expect(rows).toHaveLength(2); expect(rows.map(r => JSON.parse(r.payload).sourceIds.length).sort()).toEqual([1, 2]);
    expect(JSON.stringify(rows)).not.toContain('知识库');
    h.setNow(new Date(start.getTime() + 299_999)); await h.runtime.runOnce(); expect(h.calls()).toBe(0);
    h.setNow(new Date(start.getTime() + 300_000)); await h.runtime.runOnce(); expect(h.calls()).toBe(1);
    expect(h.topics.listCurrentTopics()).toHaveLength(1);
    await h.app.close(); h.db.close();
  });
  it('capture-only never analyzes and bot output stays audit-only', async () => {
    const h = harness({ captureEnabled: true, analysisEnabled: false, groupDeliveryEnabled: false });
    await h.app.inject({ method: 'POST', url: '/webhooks/feishu/events', payload: event('om_bot', 'evt_bot', '', 'app') });
    expect(h.db.client.prepare('SELECT COUNT(*) n FROM context_sources').get()).toEqual({ n: 0 });
    expect(h.db.client.prepare('SELECT COUNT(*) n FROM founder_stream_events').get()).toEqual({ n: 1 });
    await h.app.inject({ method: 'POST', url: '/webhooks/feishu/events', payload: event() });
    await h.runtime.runOnce(); expect(h.jobs.list().map(j => j.kind)).toEqual(['capture_group_message']);
    expect(h.calls()).toBe(0); await h.app.close(); h.db.close();
  });
  it('passes immutable source occurrence time to the perspective analyzer', async () => {
    const h = harness();
    new AlignmentRepository(h.db.client).configureFounderIdentity({ founder:'ivy',sourceSystem:'feishu',externalAuthorId:'ou_ivy',configuredAt:start });
    const source = h.sources.saveSource(captureGroupMessageSource({ chatId:chat,messageId:'om_timed',threadId:null,rootId:null,
      author:{openId:'ou_ivy',displayName:null},senderType:'user',messageType:'text',text:'知识库先从买家问答开始',
      occurredAt:'2026-09-20T08:30:00.000Z' },start).source).source;
    let evidence: readonly { occurredAt?: string }[] = [];
    const runtime=createFounderStreamRuntime({client:h.db.client,jobRepository:h.jobs,flags:{captureEnabled:true,analysisEnabled:true,groupDeliveryEnabled:false},
      approvedChatIds:[chat],ivyPrivateChatId:'oc_private',now:()=>new Date(start.getTime()+600_000),
      analyzer:{async analyze(input){return{topics:[{displayName:'知识库',stage:'exploring',outcome:null,currentAction:null,confidence:'high',
        sourceIds:[source.id],evidenceExcerpts:[{sourceId:source.id,excerpt:'知识库先从买家问答开始'}],
        joinDecision:{kind:'new',topicId:null,confidence:'high',sharedTerms:[]},splitSuggestions:[]}]}}},
      perspectiveAnalyzer:{async analyze(input){evidence=input.evidence;return{observations:[],alignmentProposals:[]}}}});
    h.jobs.enqueueFounderStreamBatch({chatId:chat,since:source.occurredAt,until:source.occurredAt,sourceIds:[source.id],capturedAt:start});
    await runtime.runOnce();
    expect(evidence).toEqual([expect.objectContaining({ sourceId:source.id,founder:'ivy',occurredAt:'2026-09-20T08:30:00.000Z' })]);
    await h.app.close();h.db.close();
  });
});

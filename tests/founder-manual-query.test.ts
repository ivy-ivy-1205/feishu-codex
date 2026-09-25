import { describe, expect, it } from 'vitest';
import { createSqliteDatabase } from '../src/db/client.js';
import { migrateDatabase } from '../src/db/migrate.js';
import { JobRepository } from '../src/repositories/job-repository.js';
import { AlignmentRepository } from '../src/repositories/alignment-repository.js';
import { createFounderStreamRuntime } from '../src/services/founder-stream-worker.js';
import { parseFounderManualQuery } from '../src/services/founder-manual-query.js';
import { buildFounderManualQueryMessages } from '../src/services/founder-manual-query.js';
import { TopicRepository } from '../src/repositories/topic-repository.js';
import { ContextSourceRepository } from '../src/repositories/context-source-repository.js';
import { captureGroupMessageSource } from '../src/services/group-message-source-capture.js';

const chatId='oc_a84d5b6ca478220d0a37964b50776edb';
const at=new Date('2026-09-25T10:00:00.000Z');

function event(text:string,openId='ou_ivy',messageId='om_query'){
  return {header:{event_id:`evt_${messageId}`,create_time:String(at.getTime())},event:{
    sender:{sender_type:'user',sender_id:{open_id:openId}},message:{message_id:messageId,chat_id:chatId,
      message_type:'text',content:JSON.stringify({text}),create_time:String(at.getTime())}}};
}

describe('founder manual queries',()=>{
  it('recognizes only the three approved commands',()=>{
    expect(parseFounderManualQuery('查看工作地图')).toEqual({kind:'work_map'});
    expect(parseFounderManualQuery(' 查看对齐：Smart Listing ')).toEqual({kind:'topic_alignment',topicName:'Smart Listing'});
    expect(parseFounderManualQuery('查看对齐: AI 选房经验与知识库')).toEqual({kind:'topic_alignment',topicName:'AI 选房经验与知识库'});
    expect(parseFounderManualQuery('查看待对齐')).toEqual({kind:'open_alignment'});
    expect(parseFounderManualQuery('请查看工作地图')).toBeNull();
    expect(parseFounderManualQuery('查看对齐：')).toBeNull();
  });

  it('does not persist an authorized query as business context and queues an auditable response',()=>{
    const db=createSqliteDatabase(':memory:');migrateDatabase(db.client);
    new AlignmentRepository(db.client).configureFounderIdentity({founder:'ivy',sourceSystem:'feishu',externalAuthorId:'ou_ivy',configuredAt:at});
    const runtime=createFounderStreamRuntime({client:db.client,jobRepository:new JobRepository(db.client),
      flags:{captureEnabled:true,analysisEnabled:true,groupDeliveryEnabled:false,manualQueryEnabled:true},
      approvedChatIds:[chatId],ivyPrivateChatId:'oc_private',now:()=>at,
      analyzer:{async analyze(){return{topics:[]}}}});
    expect(runtime.route.ingest(event('查看待对齐'))).toMatchObject({status:'manual_query_queued'});
    expect((db.client.prepare("SELECT count(*) n FROM context_sources WHERE source_type='group_message'").get() as {n:number}).n).toBe(0);
    const row=db.client.prepare("SELECT payload FROM outbox WHERE status='pending'").get() as {payload:string};
    const payload=JSON.parse(row.payload);
    expect(payload.kind).toBe('founder_manual_query');
    expect(JSON.stringify(payload.card)).toContain('处理状态');
    expect(JSON.stringify(payload.card)).toContain('待处理');
    expect(JSON.stringify(payload.card)).toContain('未补偿失败');
    db.close();
  });

  it('rejects non-founder commands without recording them as project evidence',()=>{
    const db=createSqliteDatabase(':memory:');migrateDatabase(db.client);
    const runtime=createFounderStreamRuntime({client:db.client,jobRepository:new JobRepository(db.client),
      flags:{captureEnabled:true,analysisEnabled:true,groupDeliveryEnabled:false,manualQueryEnabled:true},
      approvedChatIds:[chatId],ivyPrivateChatId:'oc_private',now:()=>at,
      analyzer:{async analyze(){return{topics:[]}}}});
    expect(runtime.route.ingest(event('查看工作地图','ou_stranger'))).toEqual({status:'rejected',reason:'founder_identity_required'});
    expect((db.client.prepare('SELECT count(*) n FROM context_sources').get() as {n:number}).n).toBe(0);
    db.close();
  });

  it('delivers manual query responses while automatic group delivery remains off',async()=>{
    const db=createSqliteDatabase(':memory:');migrateDatabase(db.client);
    new AlignmentRepository(db.client).configureFounderIdentity({founder:'ivy',sourceSystem:'feishu',externalAuthorId:'ou_ivy',configuredAt:at});
    new TopicRepository(db.client).createTopic({displayName:'可纠正项目',stage:'active_project',createdAt:at});
    const sent:Record<string,unknown>[]=[];
    const runtime=createFounderStreamRuntime({client:db.client,jobRepository:new JobRepository(db.client),
      flags:{captureEnabled:true,analysisEnabled:true,groupDeliveryEnabled:false,manualQueryEnabled:true},
      approvedChatIds:[chatId],ivyPrivateChatId:'oc_private',now:()=>at,
      analyzer:{async analyze(){return{topics:[]}}},delivery:{
        async sendTextMessage(){return{messageId:'om_text'}},
        async sendInteractiveCard(input){sent.push(input.card);return{messageId:'om_manual_response'}}}});
    runtime.route.ingest(event('查看工作地图'));
    await runtime.afterTick();
    expect(sent).toHaveLength(1);
    expect((db.client.prepare("SELECT status FROM outbox WHERE idempotency_key LIKE 'founder-manual-query:%'").get() as {status:string}).status).toBe('delivered');
    const delivered=new (await import('../src/repositories/outbox-repository.js')).OutboxRepository(db.client)
      .findDeliveredFounderMessage(chatId,'om_manual_response');
    expect(delivered).toMatchObject({kind:'founder_work_map',itemRefs:[{kind:'topic'}]});
    expect((db.client.prepare("SELECT count(*) n FROM outbox WHERE idempotency_key LIKE 'alignment-question:%' AND status='delivered'").get() as {n:number}).n).toBe(0);
    db.close();
  });

  it('separates confirmed consensus, personal views and a missing founder expression',()=>{
    const db=createSqliteDatabase(':memory:');migrateDatabase(db.client);
    const topics=new TopicRepository(db.client),alignment=new AlignmentRepository(db.client),sources=new ContextSourceRepository(db.client);
    alignment.configureFounderIdentity({founder:'ivy',sourceSystem:'feishu',externalAuthorId:'ou_ivy',configuredAt:at});
    alignment.configureFounderIdentity({founder:'james',sourceSystem:'feishu',externalAuthorId:'ou_james',configuredAt:at});
    const topic=topics.createTopic({displayName:'Smart Listing',stage:'active_project',outcome:'验证房源服务',createdAt:at});
    const evidence=(id:string,openId:string,text:string)=>{const captured=captureGroupMessageSource({chatId,messageId:id,threadId:null,rootId:null,
      author:{openId,displayName:null},senderType:'user',messageType:'text',text,occurredAt:at.toISOString()},at);
      const source=sources.saveSource(captured.source).source;return sources.saveEvidence({sourceId:source.id,excerpt:text,
        locator:{...captured.messageLocator,sourceVersion:source.sourceVersion,contentHash:source.contentHash},evidenceLevel:'primary_statement',capturedAt:at}).evidence.id};
    const ivy=evidence('om_ivy','ou_ivy','先验证房源页面');
    alignment.savePerspective({topicId:topic.id,kind:'ivy_view',expectedVersion:0,statement:'先验证房源页面',confidence:1,
      evidenceIds:[ivy],decisionKey:'next',speechAct:'view',observedAt:at});
    const message=buildFounderManualQueryMessages({client:db.client,query:{kind:'topic_alignment',topicName:'Smart Listing'},
      queryMessageId:'om_q',chatId,approvedChatIds:[chatId],now:at})[0]!;
    const body=JSON.stringify(message.card);
    expect(body).toContain('Ivy 的理解');
    expect(body).toContain('缺少 James 的明确表达');
    expect(body).toContain('暂无双方明确确认的共识');
    expect(body).not.toContain('当前共识：先验证房源页面');
    db.close();
  });

  it('reports both founders missing when neither has an attributable view',()=>{
    const db=createSqliteDatabase(':memory:');migrateDatabase(db.client);
    new TopicRepository(db.client).createTopic({displayName:'空白项目',stage:'idea',createdAt:at});
    const body=JSON.stringify(buildFounderManualQueryMessages({client:db.client,query:{kind:'topic_alignment',topicName:'空白项目'},
      queryMessageId:'om_empty',chatId,approvedChatIds:[chatId],now:at})[0]!.card);
    expect(body).toContain('缺少双方的明确表达');
    db.close();
  });

  it('counts persisted history coverage gaps and keeps every response below the Feishu card limit',()=>{
    const db=createSqliteDatabase(':memory:');migrateDatabase(db.client);
    const sources=new ContextSourceRepository(db.client);
    sources.saveSource({sourceSystem:'feishu',sourceType:'feishu_sync_coverage',externalId:'coverage-1',logicalKey:'coverage-1',
      occurredAt:at.toISOString(),authors:[],locatorUri:null,contentFormat:'application/json',contentText:JSON.stringify({
        gaps:[{code:'FILE_TEXT_UNREADABLE',sourceRef:'file-1',reason:'unreadable'}]}),metadata:{chatId},availabilityStatus:'available',capturedAt:at});
    const topics=new TopicRepository(db.client);
    const topic=topics.createTopic({displayName:'大量分歧项目',stage:'active_project',createdAt:at});
    for(let index=0;index<100;index++)db.client.prepare(`INSERT INTO alignment_issues
      (id,topic_id,decision_key,dimension,evidence_set_hash,candidate_json,status,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(`issue_${index}`,topic.id,`decision_${index}`,'direction',`hash_${index}`,JSON.stringify({
        id:`issue_${index}`,status:'candidate',topicId:topic.id,decisionKey:`decision_${index}`,dimension:'direction',
        ivy:{evidenceId:`ivy_${index}`,statement:`Ivy 方案 ${index} ${'甲'.repeat(100)}`},
        james:{evidenceId:`james_${index}`,statement:`James 方案 ${index} ${'乙'.repeat(100)}`},
        actionConsequence:{evidenceId:`ivy_${index}`,excerpt:'立即推进'},actionHorizon:null,
        evidenceIds:[`ivy_${index}`,`james_${index}`],evidenceSetHash:`hash_${index}`}),
      'candidate',at.toISOString(),at.toISOString());
    const message=buildFounderManualQueryMessages({client:db.client,query:{kind:'topic_alignment',topicName:'大量分歧项目'},
      queryMessageId:'om_large',chatId,approvedChatIds:[chatId],now:at})[0]!;
    const body=JSON.stringify(message.card);
    expect(Buffer.byteLength(body,'utf8')).toBeLessThanOrEqual(28_000);
    expect(body).toContain('不可读/跳过缺口：1');
    expect(body).toContain('仅展示前');
    db.close();
  });
});

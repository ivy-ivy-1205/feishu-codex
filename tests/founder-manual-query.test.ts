import { describe, expect, it } from 'vitest';
import { FounderWhiteboardPublishError } from '../src/services/founder-whiteboard.js';
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
  it('recognizes the three board uses and keeps the previous alignment commands compatible',()=>{
    expect(parseFounderManualQuery('查看工作地图')).toEqual({kind:'work_map'});
    expect(parseFounderManualQuery('查看项目进展：Smart Listing')).toEqual({kind:'project_progress',topicName:'Smart Listing'});
    expect(parseFounderManualQuery('查看分歧：Smart Listing')).toEqual({kind:'topic_alignment',topicName:'Smart Listing'});
    expect(parseFounderManualQuery('查看分歧')).toEqual({kind:'open_alignment'});
    expect(parseFounderManualQuery(' 查看对齐：Smart Listing ')).toEqual({kind:'topic_alignment',topicName:'Smart Listing'});
    expect(parseFounderManualQuery('查看对齐: AI 选房经验与知识库')).toEqual({kind:'topic_alignment',topicName:'AI 选房经验与知识库'});
    expect(parseFounderManualQuery('查看待对齐')).toEqual({kind:'open_alignment'});
    expect(parseFounderManualQuery('请查看工作地图')).toBeNull();
    expect(parseFounderManualQuery('查看对齐：')).toBeNull();
    expect(parseFounderManualQuery('查看项目进展：')).toBeNull();
  });

  it('lets the configured James identity invoke the work map',()=>{
    const db=createSqliteDatabase(':memory:');migrateDatabase(db.client);
    new AlignmentRepository(db.client).configureFounderIdentity({founder:'james',sourceSystem:'feishu',externalAuthorId:'ou_james',configuredAt:at});
    const runtime=createFounderStreamRuntime({client:db.client,jobRepository:new JobRepository(db.client),
      flags:{captureEnabled:true,analysisEnabled:true,groupDeliveryEnabled:false,manualQueryEnabled:true},
      approvedChatIds:[chatId],ivyPrivateChatId:'oc_private',now:()=>at,
      analyzer:{async analyze(){return{topics:[]}}}});
    expect(runtime.route.ingest(event('查看工作地图','ou_james','om_james_query'))).toMatchObject({status:'manual_query_queued'});
    db.close();
  });

  it('renders project progress as current stage, completed, next and blockers without inventing completion',()=>{
    const db=createSqliteDatabase(':memory:');migrateDatabase(db.client);
    new TopicRepository(db.client).createTopic({displayName:'Smart Listing',stage:'active_project',outcome:'验证房源服务',createdAt:at});
    const message=buildFounderManualQueryMessages({client:db.client,query:{kind:'project_progress',topicName:'Smart Listing'},
      queryMessageId:'om_progress',chatId,approvedChatIds:[chatId],now:at})[0]!;
    const body=JSON.stringify(message.card);
    expect(body).toContain('项目进展');
    expect(body).toContain('当前阶段');
    expect(body).toContain('已完成');
    expect(body).toContain('待推进');
    expect(body).toContain('卡点与依赖');
    expect(body).toContain('没有明确标注');
    db.close();
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
    expect(JSON.stringify(payload.card)).toContain('最后防漏复核');
    expect(JSON.stringify(payload.card)).toContain('待处理');
    expect(JSON.stringify(payload.card)).toContain('未补偿分析来源');
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
    await runtime.runManualQueriesOnce();
    expect(sent).toHaveLength(1);
    expect((db.client.prepare("SELECT status FROM outbox WHERE idempotency_key LIKE 'founder-manual-query:%'").get() as {status:string}).status).toBe('delivered');
    const delivered=new (await import('../src/repositories/outbox-repository.js')).OutboxRepository(db.client)
      .findDeliveredFounderMessage(chatId,'om_manual_response');
    expect(delivered).toMatchObject({kind:'founder_work_map',itemRefs:[{kind:'topic'}]});
    expect((db.client.prepare("SELECT count(*) n FROM outbox WHERE idempotency_key LIKE 'alignment-question:%' AND status='delivered'").get() as {n:number}).n).toBe(0);
    db.close();
  });

  it('reuses a persisted whiteboard when card delivery retries',async()=>{
    const db=createSqliteDatabase(':memory:');migrateDatabase(db.client);
    new AlignmentRepository(db.client).configureFounderIdentity({founder:'ivy',sourceSystem:'feishu',externalAuthorId:'ou_ivy',configuredAt:at});
    new TopicRepository(db.client).createTopic({displayName:'Smart Listing',stage:'active_project',createdAt:at});
    let publishes=0,sends=0;const cards:Record<string,unknown>[]=[];
    const runtime=createFounderStreamRuntime({client:db.client,jobRepository:new JobRepository(db.client),
      flags:{captureEnabled:true,analysisEnabled:true,groupDeliveryEnabled:false,manualQueryEnabled:true},
      approvedChatIds:[chatId],ivyPrivateChatId:'oc_private',now:()=>at,
      analyzer:{async analyze(){return{topics:[]}}},whiteboardPublisher:{async publish(){publishes++;return{
        documentId:'doc_1',whiteboardId:'board_1',url:'https://example.test/docx/doc_1',paletteId:'coral',previewImageKey:'img_preview'}}},delivery:{
        async sendTextMessage(){return{messageId:'om_text'}},
        async sendInteractiveCard(input){cards.push(input.card);if(sends++===0)throw new Error('temporary');return{messageId:'om_after_retry'}}}});
    runtime.route.ingest(event('查看工作地图'));
    await runtime.runManualQueriesOnce();
    const pending=db.client.prepare("SELECT payload FROM outbox WHERE status='pending'").get() as {payload:string};
    expect(JSON.parse(pending.payload).boardArtifact.url).toBe('https://example.test/docx/doc_1');
    await runtime.runManualQueriesOnce();
    expect(publishes).toBe(1);
    expect(JSON.stringify(cards.at(-1))).toContain('https://example.test/docx/doc_1');
    db.close();
  });

  it('shows the editable board context and action before the full text on every page',async()=>{
    const db=createSqliteDatabase(':memory:');migrateDatabase(db.client);
    new AlignmentRepository(db.client).configureFounderIdentity({founder:'ivy',sourceSystem:'feishu',externalAuthorId:'ou_ivy',configuredAt:at});
    const topics=new TopicRepository(db.client);
    for(let index=1;index<=13;index++)topics.createTopic({displayName:`项目 ${index}`,stage:'active_project',createdAt:at});
    const sent:Record<string,unknown>[]=[];
    const runtime=createFounderStreamRuntime({client:db.client,jobRepository:new JobRepository(db.client),
      flags:{captureEnabled:true,analysisEnabled:true,groupDeliveryEnabled:false,manualQueryEnabled:true},
      approvedChatIds:[chatId],ivyPrivateChatId:'oc_private',now:()=>at,
      analyzer:{async analyze(){return{topics:[]}}},whiteboardPublisher:{async publish(){return{
        documentId:'doc_1',whiteboardId:'board_1',url:'https://example.test/docx/doc_1',paletteId:'coral',previewImageKey:'img_preview'}}},delivery:{
        async sendTextMessage(){return{messageId:'om_text'}},
        async sendInteractiveCard(input){sent.push(input.card);return{messageId:`om_page_${sent.length}`}}}});
    runtime.route.ingest(event('查看工作地图'));
    await runtime.runManualQueriesOnce();
    expect(sent).toHaveLength(2);
    const first=sent[0]!.elements as {tag?:unknown;img_key?:unknown;mode?:unknown;text?:{content?:unknown};actions?:{url?:unknown}[]}[];
    expect(first[0]).toMatchObject({tag:'img',img_key:'img_preview',mode:'fit_horizontal'});
    expect(first[1]).toMatchObject({tag:'div',text:{content:expect.stringContaining('可编辑看板已生成')}});
    expect(first[1]).toMatchObject({text:{content:expect.stringContaining('Coral')}});
    expect(first[2]).toMatchObject({tag:'action',actions:[{type:'default',text:{content:'打开可编辑白板'},url:'https://example.test/docx/doc_1'}]});
    expect(Buffer.byteLength(JSON.stringify(sent[0]),'utf8')).toBeLessThan(30_000);
    const second=sent[1]!.elements as {tag?:unknown}[];
    expect(second.some(element=>element.tag==='img')).toBe(false);
    db.close();
  });

  it('keeps the complete text response and makes a whiteboard publishing failure visible',async()=>{
    const db=createSqliteDatabase(':memory:');migrateDatabase(db.client);
    new AlignmentRepository(db.client).configureFounderIdentity({founder:'ivy',sourceSystem:'feishu',externalAuthorId:'ou_ivy',configuredAt:at});
    new TopicRepository(db.client).createTopic({displayName:'Smart Listing',stage:'active_project',createdAt:at});
    let sentCard:Record<string,unknown>|undefined;
    const runtime=createFounderStreamRuntime({client:db.client,jobRepository:new JobRepository(db.client),
      flags:{captureEnabled:true,analysisEnabled:true,groupDeliveryEnabled:false,manualQueryEnabled:true},
      approvedChatIds:[chatId],ivyPrivateChatId:'oc_private',now:()=>at,
      analyzer:{async analyze(){return{topics:[]}}},whiteboardPublisher:{async publish(){throw new Error('permission denied')}},delivery:{
        async sendTextMessage(){return{messageId:'om_text'}},
        async sendInteractiveCard(input){sentCard=input.card;return{messageId:'om_fallback'}}}});
    runtime.route.ingest(event('查看工作地图'));
    await runtime.runManualQueriesOnce();
    expect(JSON.stringify(sentCard)).toContain('看板生成失败');
    const delivered=db.client.prepare("SELECT payload FROM outbox WHERE status='delivered'").get() as {payload:string};
    expect(JSON.parse(delivered.payload).boardFailure.code).toBe('FOUNDER_WHITEBOARD_PUBLISH_FAILED');
    db.close();
  });

  it('still delivers the inline overview when only editable board creation fails',async()=>{
    const db=createSqliteDatabase(':memory:');migrateDatabase(db.client);
    new AlignmentRepository(db.client).configureFounderIdentity({founder:'ivy',sourceSystem:'feishu',externalAuthorId:'ou_ivy',configuredAt:at});
    new TopicRepository(db.client).createTopic({displayName:'Smart Listing',stage:'active_project',createdAt:at});
    let sentCard:Record<string,unknown>|undefined;
    const runtime=createFounderStreamRuntime({client:db.client,jobRepository:new JobRepository(db.client),
      flags:{captureEnabled:true,analysisEnabled:true,groupDeliveryEnabled:false,manualQueryEnabled:true},
      approvedChatIds:[chatId],ivyPrivateChatId:'oc_private',now:()=>at,
      analyzer:{async analyze(){return{topics:[]}}},whiteboardPublisher:{async publish(){
        throw new FounderWhiteboardPublishError('img_preview',new Error('board unavailable'))}},delivery:{
        async sendTextMessage(){return{messageId:'om_text'}},
        async sendInteractiveCard(input){sentCard=input.card;return{messageId:'om_preview_only'}}}});
    runtime.route.ingest(event('查看工作地图'));
    await runtime.runManualQueriesOnce();
    const elements=sentCard?.elements as {tag?:unknown;img_key?:unknown}[];
    expect(elements[0]).toMatchObject({tag:'img',img_key:'img_preview'});
    expect(JSON.stringify(sentCard)).toContain('群内总览已生成');
    expect(JSON.stringify(sentCard)).not.toContain('打开可编辑看板');
    db.close();
  });

  it('delivers a manual query while a long founder analysis is still running',async()=>{
    const db=createSqliteDatabase(':memory:');migrateDatabase(db.client);
    const jobs=new JobRepository(db.client),sources=new ContextSourceRepository(db.client);
    new AlignmentRepository(db.client).configureFounderIdentity({founder:'ivy',sourceSystem:'feishu',externalAuthorId:'ou_ivy',configuredAt:at});
    const captured=captureGroupMessageSource({chatId,messageId:'om_business',threadId:null,rootId:null,
      author:{openId:'ou_ivy',displayName:null},senderType:'user',messageType:'text',text:'新的业务讨论',occurredAt:at.toISOString()},at);
    const source=sources.saveSource(captured.source).source;
    jobs.enqueueFounderStreamBatch({chatId,since:at.toISOString(),until:at.toISOString(),sourceIds:[source.id],capturedAt:at});
    let release!:()=>void,started!:()=>void;
    const analysisStarted=new Promise<void>(resolve=>{started=resolve});
    const blocked=new Promise<void>(resolve=>{release=resolve});
    const sent:Record<string,unknown>[]=[];
    const runtime=createFounderStreamRuntime({client:db.client,jobRepository:jobs,intervalMs:1,
      flags:{captureEnabled:true,analysisEnabled:true,groupDeliveryEnabled:false,manualQueryEnabled:true},
      approvedChatIds:[chatId],ivyPrivateChatId:'oc_private',now:()=>at,
      analyzer:{async analyze(){started();await blocked;return{topics:[]}}},delivery:{
        async sendTextMessage(){return{messageId:'om_text'}},
        async sendInteractiveCard(input){sent.push(input.card);return{messageId:'om_manual_while_busy'}}}});
    runtime.start();
    await analysisStarted;
    runtime.route.ingest(event('查看待对齐','ou_ivy','om_query_while_busy'));
    await new Promise(resolve=>setTimeout(resolve,30));
    expect(sent).toHaveLength(1);
    expect((db.client.prepare("SELECT status FROM outbox WHERE idempotency_key LIKE 'founder-manual-query:%'").get() as {status:string}).status).toBe('delivered');
    release();await new Promise(resolve=>setTimeout(resolve,5));await runtime.stop();db.close();
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
    expect(body).toContain('Ivy 的当前个人理解');
    expect(body).toContain('缺少 James 的当前表达');
    expect(body).toContain('暂无双方明确确认的共识');
    expect(body).not.toContain('当前共识：先验证房源页面');
    db.close();
  });

  it('reports both founders missing when neither has an attributable view',()=>{
    const db=createSqliteDatabase(':memory:');migrateDatabase(db.client);
    new TopicRepository(db.client).createTopic({displayName:'空白项目',stage:'idea',createdAt:at});
    const body=JSON.stringify(buildFounderManualQueryMessages({client:db.client,query:{kind:'topic_alignment',topicName:'空白项目'},
      queryMessageId:'om_empty',chatId,approvedChatIds:[chatId],now:at})[0]!.card);
    expect(body).toContain('缺少双方的当前表达');
    db.close();
  });

  it('treats an Ivy-confirmed baseline as confirmed structure and an older founder statement as history',()=>{
    const db=createSqliteDatabase(':memory:');migrateDatabase(db.client);
    const topics=new TopicRepository(db.client),alignment=new AlignmentRepository(db.client),sources=new ContextSourceRepository(db.client);
    alignment.configureFounderIdentity({founder:'ivy',sourceSystem:'feishu',externalAuthorId:'ou_ivy',configuredAt:at});
    alignment.configureFounderIdentity({founder:'james',sourceSystem:'feishu',externalAuthorId:'ou_james',configuredAt:at});
    const old=captureGroupMessageSource({chatId,messageId:'om_old_status',threadId:null,rootId:null,
      author:{openId:'ou_james',displayName:null},senderType:'user',messageType:'text',text:'未接入账号，未部署。',
      occurredAt:'2026-09-10T00:00:00.000Z'},new Date('2026-09-10T00:00:00.000Z'));
    const source=sources.saveSource(old.source).source;
    const evidence=sources.saveEvidence({sourceId:source.id,excerpt:'未接入账号，未部署。',locator:{...old.messageLocator,
      sourceVersion:source.sourceVersion,contentHash:source.contentHash},evidenceLevel:'primary_statement',capturedAt:new Date('2026-09-10T00:00:00.000Z')}).evidence.id;
    const topic=topics.createTopic({displayName:'AiJia 合伙人对齐室',stage:'active_project',outcome:'系统已经进入影子运行',
      rationale:'Ivy confirmed Founder work map baseline',evidenceIds:[evidence],createdAt:new Date('2026-09-24T00:00:00.000Z')});
    alignment.savePerspective({topicId:topic.id,kind:'james_view',expectedVersion:0,statement:'未接入账号，未部署。',confidence:1,
      evidenceIds:[evidence],decisionKey:'status',speechAct:'view',observedAt:new Date('2026-09-10T00:00:00.000Z')});
    const body=JSON.stringify(buildFounderManualQueryMessages({client:db.client,query:{kind:'topic_alignment',topicName:'AiJia 合伙人对齐室'},
      queryMessageId:'om_baseline',chatId,approvedChatIds:[chatId],now:at})[0]!.card);
    expect(body).toContain('已确认项目结构／目标（Ivy 确认）');
    expect(body).toContain('系统已经进入影子运行');
    expect(body).toContain('James 的历史表达');
    expect(body).toContain('未接入账号，未部署。');
    expect(body).toContain('缺少 James 的当前表达');
    expect(body).not.toContain('James 的理解\n- 未接入账号，未部署。');
    const overview=JSON.stringify(buildFounderManualQueryMessages({client:db.client,query:{kind:'open_alignment'},
      queryMessageId:'om_overview',chatId,approvedChatIds:[chatId],now:at})[0]!.card);
    expect(overview).toContain('AiJia 合伙人对齐室：缺少 James 的当前表达');
    expect(overview).not.toContain('缺少 Ivy 的明确表达');
    db.close();
  });

  it('counts persisted history coverage gaps and keeps every response below the Feishu card limit',()=>{
    const db=createSqliteDatabase(':memory:');migrateDatabase(db.client);
    const sources=new ContextSourceRepository(db.client);
    sources.saveSource({sourceSystem:'feishu',sourceType:'feishu_sync_coverage',externalId:'coverage-1',logicalKey:'coverage-1',
      occurredAt:at.toISOString(),authors:[],locatorUri:null,contentFormat:'application/json',contentText:JSON.stringify({
        gaps:[{code:'FILE_TEXT_UNREADABLE',sourceRef:'file-1',reason:'unreadable'}]}),metadata:{chatId},availabilityStatus:'available',capturedAt:at});
    sources.saveSource({sourceSystem:'feishu',sourceType:'feishu_sync_coverage',externalId:'daily-coverage',logicalKey:'daily-coverage',
      occurredAt:'2026-09-09T00:00:00.000Z',authors:[],locatorUri:null,contentFormat:'application/json',contentText:JSON.stringify({
        requestedRange:{until:'2026-09-09T00:00:00.000Z'},sourceCoverage:{termination:'next_cursor_null'}}),
      metadata:{chatId,syncPurpose:'daily_reconciliation'},availabilityStatus:'available',capturedAt:new Date('2026-09-09T00:00:00.000Z')});
    sources.saveSource({sourceSystem:'feishu',sourceType:'feishu_sync_coverage',externalId:'manual-coverage',logicalKey:'manual-coverage',
      occurredAt:'2026-09-10T00:00:00.000Z',authors:[],locatorUri:null,contentFormat:'application/json',contentText:JSON.stringify({
        requestedRange:{until:'2026-09-10T00:00:00.000Z'},sourceCoverage:{termination:'next_cursor_null'}}),
      metadata:{chatId},availabilityStatus:'available',capturedAt:new Date('2026-09-10T00:00:00.000Z')});
    sources.saveSource({sourceSystem:'feishu',sourceType:'feishu_sync_gap',externalId:'gap-duplicate',logicalKey:'gap-duplicate',
      occurredAt:at.toISOString(),authors:[],locatorUri:null,contentFormat:'application/json',contentText:JSON.stringify({
        code:'FILE_TEXT_UNREADABLE',sourceRef:'file-1',reason:'same gap persisted separately'}),metadata:{chatId},availabilityStatus:'available',capturedAt:at});
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
    expect(body).toContain('最后防漏复核：2026-09-10T00:00:00.000Z');
    expect(body).toContain('仅展示前');
    db.close();
  });

  it('reports unique unanalyzed sources separately from failed capture jobs',()=>{
    const db=createSqliteDatabase(':memory:');migrateDatabase(db.client);
    const topics=new TopicRepository(db.client),sources=new ContextSourceRepository(db.client);
    topics.createTopic({displayName:'Smart Listing',stage:'active_project',createdAt:at});
    const save=(id:string,occurredAt:string)=>{
      const captured=captureGroupMessageSource({chatId,messageId:id,threadId:null,rootId:null,author:{openId:'ou_ivy',displayName:null},
        senderType:'user',messageType:'text',text:`语料 ${id}`,occurredAt},new Date(occurredAt));
      return sources.saveSource(captured.source).source.id;
    };
    const recovered=save('om_recovered','2026-09-23T00:00:00.000Z');
    const missing=save('om_missing','2026-09-24T00:00:00.000Z');
    const insert=(id:string,type:string,status:string,payload:unknown,updatedAt:string)=>db.client.prepare(`INSERT INTO batch_jobs
      (id,type,stable_key,payload,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)`)
      .run(id,type,id,JSON.stringify(payload),status,'2026-09-25T00:00:00.000Z',updatedAt);
    insert('analysis_done','analyze_founder_stream_batch','completed',{chatId,sourceIds:[recovered]},'2026-09-25T01:00:00.000Z');
    insert('analysis_failed_1','analyze_founder_stream_batch','failed',{chatId,sourceIds:[recovered,missing]},'2026-09-25T02:00:00.000Z');
    insert('analysis_failed_2','analyze_founder_stream_batch','failed',{chatId,sourceIds:[missing]},'2026-09-25T03:00:00.000Z');
    insert('attachment_failed','capture_founder_attachment','failed',{chatId,messageId:'om_file',attempt:3},'2026-09-25T04:00:00.000Z');
    const body=JSON.stringify(buildFounderManualQueryMessages({client:db.client,query:{kind:'work_map'},queryMessageId:'om_status',
      chatId,approvedChatIds:[chatId],now:at})[0]!.card);
    expect(body).toContain('最新已分析语料：2026-09-23T00:00:00.000Z');
    expect(body).toContain('未补偿分析来源：1；采集失败任务：1');
    expect(body).not.toContain('未补偿失败：');
    db.close();
  });
});

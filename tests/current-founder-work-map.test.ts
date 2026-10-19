import { describe, expect, it } from 'vitest';
import { createSqliteDatabase } from '../src/db/client.js';
import { migrateDatabase } from '../src/db/migrate.js';
import { AlignmentRepository } from '../src/repositories/alignment-repository.js';
import { ContextSourceRepository } from '../src/repositories/context-source-repository.js';
import { TopicRepository } from '../src/repositories/topic-repository.js';
import { buildCurrentFounderWorkMap, enqueueCurrentFounderWorkMap } from '../src/services/current-founder-work-map.js';
import { captureGroupMessageSource } from '../src/services/group-message-source-capture.js';

const chatId='oc_a84d5b6ca478220d0a37964b50776edb';

function fixture(){
  const db=createSqliteDatabase(':memory:');migrateDatabase(db.client);
  const topics=new TopicRepository(db.client),alignment=new AlignmentRepository(db.client),sources=new ContextSourceRepository(db.client);
  alignment.configureFounderIdentity({founder:'ivy',sourceSystem:'feishu',externalAuthorId:'ou_ivy',configuredAt:new Date('2026-09-01T00:00:00Z')});
  alignment.configureFounderIdentity({founder:'james',sourceSystem:'feishu',externalAuthorId:'ou_james',configuredAt:new Date('2026-09-01T00:00:00Z')});
  const parent=topics.createTopic({displayName:'A 线',stage:'active_project',outcome:'当前已确认方向',createdAt:new Date('2026-09-10T00:00:00Z')});
  const child=topics.createTopic({displayName:'子项目',stage:'active_project',createdAt:new Date('2026-09-11T00:00:00Z')});
  topics.addRelation({fromTopicId:child.id,toTopicId:parent.id,relationType:'part_of',rationale:'confirmed',createdAt:new Date('2026-09-11T00:01:00Z')});
  const add=(messageId:string,openId:string,text:string,occurredAt:string)=>{
    const captured=captureGroupMessageSource({chatId,messageId,threadId:null,rootId:null,author:{openId,displayName:null},messageType:'text',text,occurredAt},new Date(occurredAt));
    const source=sources.saveSource(captured.source).source;
    return sources.saveEvidence({sourceId:source.id,excerpt:text,locator:{...captured.messageLocator,sourceVersion:source.sourceVersion,contentHash:source.contentHash},evidenceLevel:'primary_statement',capturedAt:new Date(occurredAt)}).evidence.id;
  };
  const historical=add('om_old','ou_james','旧状态：还没有部署。','2026-09-02T00:00:00Z');
  const unresolved=add('om_new','ou_ivy','建议增加每周提醒。','2026-09-20T00:00:00Z');
  const shared=add('om_shared','ou_ivy','双方确认先人工发布。','2026-09-21T00:00:00Z');
  alignment.savePerspective({topicId:parent.id,kind:'james_view',expectedVersion:0,statement:'旧状态：还没有部署。',confidence:1,evidenceIds:[historical],decisionKey:'status',speechAct:'view',observedAt:new Date('2026-09-02T00:00:00Z')});
  alignment.savePerspective({topicId:child.id,kind:'ivy_view',expectedVersion:0,statement:'建议增加每周提醒。',confidence:1,evidenceIds:[unresolved],decisionKey:'frequency',speechAct:'decision_proposal',observedAt:new Date('2026-09-20T00:00:00Z')});
  alignment.savePerspective({topicId:child.id,kind:'shared_decision',expectedVersion:0,statement:'双方确认先人工发布。',confidence:1,evidenceIds:[shared],decisionKey:'publisher',speechAct:'explicit_agreement',observedAt:new Date('2026-09-21T00:00:00Z')});
  return{db,parent,child,topics,alignment,sources,add};
}

describe('current founder work map publisher',()=>{
  it('projects current, historical and unresolved states and keeps hierarchy visible',()=>{
    const h=fixture();
    const result=buildCurrentFounderWorkMap({client:h.db.client,chatId,since:'2026-08-31T00:00:00Z',until:'2026-09-24T00:00:00Z',approvedChatIds:[chatId],expectedCanonicalTopicCount:2});
    const body=JSON.stringify(result.cards);
    expect(result.canonicalTopicCount).toBe(2);
    expect(body).toContain('当前共识（双方，2026-09-21）');
    expect(body).toContain('历史记录：1 条，可用“查看对齐：A 线”查看');
    expect(body).toContain('待对齐（Ivy，2026-09-20）');
    expect(body).toContain('↳ 子项目｜子项目');
    expect(result.boardView).toMatchObject({kind:'work_map',since:'2026-08-31T00:00:00Z',until:'2026-09-24T00:00:00Z'});
    expect(result.boardView.topics).toEqual(expect.arrayContaining([
      expect.objectContaining({id:h.parent.id,name:'A 线',kind:'project'}),
      expect.objectContaining({id:h.child.id,name:'子项目',parentName:'A 线',kind:'project'})
    ]));
  });

  it('previews without writes and requires both the delivery gate and exact target before enqueue',()=>{
    const h=fixture();
    const input={client:h.db.client,chatId,since:'2026-08-31T00:00:00Z',until:'2026-09-24T00:00:00Z',approvedChatIds:[chatId],expectedCanonicalTopicCount:2};
    const preview=buildCurrentFounderWorkMap(input);
    expect((h.db.client.prepare('SELECT count(*) count FROM outbox').get() as {count:number}).count).toBe(0);
    expect(()=>enqueueCurrentFounderWorkMap({...input,confirmedChatId:chatId,groupDeliveryEnabled:false})).toThrow(/DELIVERY_DISABLED/);
    expect(()=>enqueueCurrentFounderWorkMap({...input,confirmedChatId:'oc_wrong',groupDeliveryEnabled:true})).toThrow(/TARGET_NOT_CONFIRMED/);
    const published=enqueueCurrentFounderWorkMap({...input,confirmedChatId:chatId,groupDeliveryEnabled:true});
    expect(published.mapId).toBe(preview.mapId);
    expect(published.created).toBe(preview.cards.length);
  });

  it('fails closed when the approved target or canonical count drifts',()=>{
    const h=fixture();
    expect(()=>buildCurrentFounderWorkMap({client:h.db.client,chatId,since:'2026-08-31T00:00:00Z',until:'2026-09-24T00:00:00Z',approvedChatIds:[],expectedCanonicalTopicCount:2})).toThrow(/CHAT_NOT_APPROVED/);
    expect(()=>buildCurrentFounderWorkMap({client:h.db.client,chatId,since:'2026-08-31T00:00:00Z',until:'2026-09-24T00:00:00Z',approvedChatIds:[chatId],expectedCanonicalTopicCount:9})).toThrow(/TOPIC_COUNT_MISMATCH/);
  });
  it('refuses a manual publish while another delivery is pending',()=>{
    const h=fixture();
    h.db.client.prepare(`INSERT INTO outbox(id,destination,payload,idempotency_key,status,created_at)
      VALUES('pending-fixture',?,'{}','pending-fixture','pending','2026-09-24T00:00:00Z')`).run(chatId);
    expect(()=>enqueueCurrentFounderWorkMap({client:h.db.client,chatId,since:'2026-08-31T00:00:00Z',until:'2026-09-24T00:00:00Z',
      approvedChatIds:[chatId],expectedCanonicalTopicCount:2,confirmedChatId:chatId,groupDeliveryEnabled:true})).toThrow(/QUEUE_NOT_IDLE/);
  });
  it('does not render a project name repeated as a founder viewpoint',()=>{
    const h=fixture();
    const label=h.topics.createTopic({displayName:'合伙人对齐室',stage:'active_project',createdAt:new Date('2026-09-12T00:00:00Z')});
    const evidence=h.add('om_label','ou_james','项目暂定名称：合伙人对齐室','2026-09-13T00:00:00Z');
    h.alignment.savePerspective({topicId:label.id,kind:'james_view',expectedVersion:0,statement:'项目暂定名称：合伙人对齐室',confidence:1,evidenceIds:[evidence],decisionKey:'name',speechAct:'view',observedAt:new Date('2026-09-13T00:00:00Z')});
    const result=buildCurrentFounderWorkMap({client:h.db.client,chatId,since:'2026-08-31T00:00:00Z',until:'2026-09-24T00:00:00Z',approvedChatIds:[chatId],expectedCanonicalTopicCount:3});
    const body=JSON.stringify(result.cards);
    expect(body).not.toContain('历史提议（James，2026-09-13）：项目暂定名称：合伙人对齐室');
    expect(body).not.toContain('待对齐（James，2026-09-13）：项目暂定名称：合伙人对齐室');
  });
  it('keeps canonical integrity counts while hiding Space-managed and orphan project or idea topics from the daily map',()=>{
    const h=fixture();
    const orphan=h.topics.createTopic({displayName:'未归类讨论',stage:'active_project',createdAt:new Date('2026-09-12T00:00:00Z')});
    const candidate=h.topics.createTopic({displayName:'零散候选项目',stage:'project_candidate',createdAt:new Date('2026-09-13T00:00:00Z')});
    const exploring=h.topics.createTopic({displayName:'零散探索话题',stage:'exploring',createdAt:new Date('2026-09-14T00:00:00Z')});
    const orphanIdea=h.topics.createTopic({displayName:'零散观点',stage:'idea',createdAt:new Date('2026-09-15T00:00:00Z')});
    const linkedIdea=h.topics.createTopic({displayName:'主线观点',stage:'idea',createdAt:new Date('2026-09-16T00:00:00Z')});
    h.topics.addRelation({fromTopicId:linkedIdea.id,toTopicId:h.parent.id,relationType:'part_of',rationale:'属于主线的观点',
      createdAt:new Date('2026-09-16T00:01:00Z')});
    h.db.client.prepare(`INSERT INTO founder_topic_visibility(topic_id,visibility,source_message_id,updated_at)
      VALUES(?,'space_managed','om_correction','2026-09-21T00:00:00Z')`).run(h.child.id);
    h.db.client.prepare(`INSERT INTO founder_work_map_preferences(chat_id,hide_orphan_active,source_message_id,updated_at)
      VALUES(?,1,'om_correction','2026-09-21T00:00:00Z')`).run(chatId);
    const result=buildCurrentFounderWorkMap({client:h.db.client,chatId,since:'2026-08-31T00:00:00Z',until:'2026-09-24T00:00:00Z',
      approvedChatIds:[chatId],expectedCanonicalTopicCount:7});
    expect(result.canonicalTopicCount).toBe(7);
    expect(JSON.stringify(result.cards)).not.toContain('子项目');
    expect(JSON.stringify(result.cards)).not.toContain('未归类讨论');
    expect(result.boardView.topics.map((topic)=>topic.id)).toEqual([h.parent.id,linkedIdea.id]);
    expect(result.boardView.topics).not.toEqual(expect.arrayContaining([
      expect.objectContaining({id:orphan.id}),expect.objectContaining({id:candidate.id}),expect.objectContaining({id:exploring.id}),
      expect.objectContaining({id:orphanIdea.id})
    ]));
  });

  it('cleans legacy display-name punctuation and summarizes founder corrections without repeating the full reply',()=>{
    const h=fixture();
    const correctionText='这里对于工作地图中的部分内容进行 update/修正：这是一段不应在每个项目下重复的批量纠正原文。';
    const evidence=h.add('om_correction','ou_ivy',correctionText,'2026-09-22T00:00:00Z');
    h.topics.createTopic({displayName:'：\nB_Ivy交接包_V2',stage:'closed',outcome:'交接完成',evidenceIds:[evidence],createdAt:new Date('2026-09-22T00:01:00Z')});
    h.db.client.prepare(`INSERT INTO founder_feedback_corrections
      (id,chat_id,source_message_id,author_open_id,binding_message_id,evidence_id,input_hash,correction_json,result_json,created_at)
      VALUES('correction_1',?,'om_correction','ou_ivy','om_map',?,'hash','{}','{"status":"applied"}','2026-09-22T00:02:00Z')`)
      .run(chatId,evidence);
    const result=buildCurrentFounderWorkMap({client:h.db.client,chatId,since:'2026-08-31T00:00:00Z',until:'2026-09-24T00:00:00Z',
      approvedChatIds:[chatId],expectedCanonicalTopicCount:3});
    const body=JSON.stringify(result.cards);
    expect(body).toContain('项目｜B_Ivy交接包_V2（已结束）');
    expect(body).not.toContain('： B_Ivy交接包_V2');
    expect(body).toContain('来源：Ivy 工作地图纠正 · 2026-09-22T00:00:00.000Z');
    expect(body).not.toContain('这是一段不应在每个项目下重复的批量纠正原文');
  });

  it('shows one card for compatible canonical topics with the same cleaned name without deleting either topic',()=>{
    const h=fixture();
    const line=h.topics.createTopic({displayName:'自媒体生产线',stage:'active_project',createdAt:new Date('2026-09-12T00:00:00Z')});
    const baseline=h.topics.createTopic({displayName:'EP00《挺好》',stage:'closed',outcome:'已经发布',
      rationale:'Ivy confirmed Founder work map baseline',createdAt:new Date('2026-09-13T00:00:00Z')});
    h.topics.addRelation({fromTopicId:baseline.id,toTopicId:line.id,relationType:'part_of',rationale:'confirmed',createdAt:new Date('2026-09-13T00:01:00Z')});
    const duplicate=h.topics.createTopic({displayName:'｜EP00《挺好',stage:'closed',outcome:'已结束',
      rationale:'founder stream analysis',createdAt:new Date('2026-10-15T00:00:00Z')});
    const result=buildCurrentFounderWorkMap({client:h.db.client,chatId,since:'2026-08-31T00:00:00Z',until:'2026-10-15T01:00:00Z',
      approvedChatIds:[chatId],expectedCanonicalTopicCount:5});
    expect(result.canonicalTopicCount).toBe(5);
    expect(result.boardView.topics.filter(topic=>topic.name==='EP00《挺好》')).toEqual([
      expect.objectContaining({id:baseline.id,parentName:'自媒体生产线',stage:'closed'})
    ]);
    expect(result.boardView.topics.some(topic=>topic.id===duplicate.id)).toBe(false);
  });

  it('keeps conflicting same-name topics separate and labels them for confirmation',()=>{
    const h=fixture();
    h.topics.createTopic({displayName:'同名方向',stage:'active_project',outcome:'继续推进',createdAt:new Date('2026-09-12T00:00:00Z')});
    h.topics.createTopic({displayName:'｜同名方向',stage:'closed',outcome:'已经结束',createdAt:new Date('2026-09-13T00:00:00Z')});
    const result=buildCurrentFounderWorkMap({client:h.db.client,chatId,since:'2026-08-31T00:00:00Z',until:'2026-10-15T01:00:00Z',
      approvedChatIds:[chatId],expectedCanonicalTopicCount:4});
    const names=result.boardView.topics.filter(topic=>topic.name.includes('同名方向')).map(topic=>topic.name);
    expect(names).toEqual(['同名方向（同名待确认）','同名方向（同名待确认）']);
  });

  it('carries a caller-supplied Space freshness summary through to the rendered card for a bound topic only',()=>{
    const h=fixture();
    const freshness=new Map([[h.parent.id,{status:'stale' as const,lastSuccessfulSyncAt:'2026-08-01T00:00:00.000Z',
      pageUpdatedAt:'2026-08-01T00:00:00.000Z',lastErrorCode:null,coverageIncomplete:false,gapCount:0}]]);
    const result=buildCurrentFounderWorkMap({client:h.db.client,chatId,since:'2026-08-31T00:00:00Z',until:'2026-09-24T00:00:00Z',
      approvedChatIds:[chatId],expectedCanonicalTopicCount:2,spaceFreshnessByTopicId:freshness});
    const body=JSON.stringify(result.cards);
    expect(body).toContain('Space 内容可能滞后');
    const parentCardText=result.cards.flatMap(card=>(card.card.elements as {text?:{content?:string}}[]))
      .map(el=>el.text?.content??'').find(text=>text.includes('A 线'));
    expect(parentCardText).toContain('Space');
    const childCardText=result.cards.flatMap(card=>(card.card.elements as {text?:{content?:string}}[]))
      .map(el=>el.text?.content??'').find(text=>text.includes('子项目'));
    expect(childCardText).not.toContain('Space');
  });

  it('marks a not-closed topic dormant after 30 days without activity and lists it at the end of the text card',()=>{
    const h=fixture();
    const old=h.add('om_kb','ou_ivy','知识库：等待 Jimmy 回复。','2026-09-02T00:00:00Z');
    const kb=h.topics.createTopic({displayName:'AI 选房经验与知识库',stage:'active_project',outcome:'等待 Jimmy',evidenceIds:[old],createdAt:new Date('2026-09-02T00:00:00Z')});
    const fresh=h.add('om_sl','ou_ivy','Smart Listing 本周上线买家空间。','2026-10-12T00:00:00Z');
    const sl=h.topics.createTopic({displayName:'Smart Listing',stage:'active_project',evidenceIds:[fresh],createdAt:new Date('2026-09-02T00:00:00Z')});
    const result=buildCurrentFounderWorkMap({client:h.db.client,chatId,since:'2026-08-31T00:00:00Z',until:'2026-10-19T00:00:00Z',approvedChatIds:[chatId],expectedCanonicalTopicCount:4});
    const board=new Map(result.boardView.topics.map(topic=>[topic.id,topic]));
    expect(board.get(kb.id)).toMatchObject({dormant:true,lastActivityAt:'2026-09-02T00:00:00Z'});
    expect(board.get(sl.id)).toMatchObject({lastActivityAt:'2026-10-12T00:00:00Z'});
    expect(board.get(sl.id)?.dormant).toBeFalsy();
    const lines=result.cards.flatMap(card=>JSON.stringify(card.card)).join('');
    // The fixture's own topics have no activity after mid-September, so they are dormant too.
    expect(lines).toContain('暂停 / 长期无动态 3 项');
    const dormantAt=lines.indexOf('暂停 / 长期无动态 3 项');
    expect(dormantAt).toBeGreaterThan(-1);
    expect(lines.indexOf('AI 选房经验与知识库')).toBeGreaterThan(dormantAt);
    expect(lines).toContain('最近动态 2026-09-02');
    expect(lines.indexOf('Smart Listing')).toBeLessThan(dormantAt);
  });

  it('keeps a quiet parent on the map while any child is active, and never marks closed topics dormant',()=>{
    const h=fixture();
    const recent=h.add('om_child','ou_ivy','子项目本周有进展。','2026-10-15T00:00:00Z');
    h.topics.appendVersion({topicId:h.child.id,expectedVersion:1,displayName:'子项目',stage:'active_project',outcome:null,rationale:'test',
      evidenceIds:[recent],changedAt:new Date('2026-10-15T00:00:00Z')});
    const closed=h.topics.createTopic({displayName:'EP00《挺好》',stage:'active_project',createdAt:new Date('2026-08-01T00:00:00Z')});
    h.topics.appendVersion({topicId:closed.id,expectedVersion:1,displayName:'EP00《挺好》',stage:'closed',outcome:'已发布',rationale:'closed',
      evidenceIds:[],changedAt:new Date('2026-08-20T00:00:00Z')});
    const result=buildCurrentFounderWorkMap({client:h.db.client,chatId,since:'2026-08-31T00:00:00Z',until:'2026-10-19T00:00:00Z',approvedChatIds:[chatId],expectedCanonicalTopicCount:3});
    const board=new Map(result.boardView.topics.map(topic=>[topic.id,topic]));
    expect(board.get(h.parent.id)?.dormant).toBeFalsy();
    expect(board.get(h.child.id)?.dormant).toBeFalsy();
    expect(board.get(closed.id)).toMatchObject({stage:'closed',closedAt:'2026-08-20T00:00:00.000Z'});
    expect(board.get(closed.id)?.dormant).toBeFalsy();
  });

  it('moves a paused topic into the reminder section even with recent activity, and brings it back once resumed',()=>{
    const h=fixture();
    const recent=h.add('om_kb','ou_ivy','知识库：暂停，等 Jimmy 反馈。','2026-10-18T00:00:00Z');
    const kb=h.topics.createTopic({displayName:'AI 选房经验与知识库',stage:'paused',outcome:'等 Jimmy 反馈',evidenceIds:[recent],
      createdAt:new Date('2026-10-18T00:00:00Z')});
    const until='2026-10-19T00:00:00Z';
    const paused=buildCurrentFounderWorkMap({client:h.db.client,chatId,since:'2026-08-31T00:00:00Z',until,approvedChatIds:[chatId],expectedCanonicalTopicCount:3});
    expect(paused.boardView.topics.find(topic=>topic.id===kb.id)).toMatchObject({stage:'paused',dormant:true,lastActivityAt:'2026-10-18T00:00:00Z'});
    h.topics.appendVersion({topicId:kb.id,expectedVersion:1,displayName:'AI 选房经验与知识库',stage:'active_project',outcome:'Jimmy 已回复',
      rationale:'resumed',evidenceIds:[recent],changedAt:new Date('2026-10-18T12:00:00Z')});
    const resumed=buildCurrentFounderWorkMap({client:h.db.client,chatId,since:'2026-08-31T00:00:00Z',until,approvedChatIds:[chatId],expectedCanonicalTopicCount:3});
    expect(resumed.boardView.topics.find(topic=>topic.id===kb.id)?.dormant).toBeFalsy();
  });

  it('keeps a paused parent in its line while a child is still active',()=>{
    const h=fixture();
    const recent=h.add('om_child','ou_ivy','子项目本周有进展。','2026-10-15T00:00:00Z');
    h.topics.appendVersion({topicId:h.parent.id,expectedVersion:1,displayName:h.parent.displayName,stage:'paused',outcome:null,rationale:'test',
      evidenceIds:[],changedAt:new Date('2026-10-15T00:00:00Z')});
    h.topics.appendVersion({topicId:h.child.id,expectedVersion:1,displayName:'子项目',stage:'active_project',outcome:null,rationale:'test',
      evidenceIds:[recent],changedAt:new Date('2026-10-15T00:00:00Z')});
    const result=buildCurrentFounderWorkMap({client:h.db.client,chatId,since:'2026-08-31T00:00:00Z',until:'2026-10-19T00:00:00Z',approvedChatIds:[chatId],expectedCanonicalTopicCount:2});
    expect(result.boardView.topics.find(topic=>topic.id===h.parent.id)?.dormant).toBeFalsy();
  });

  it('never marks an A/B/C line root dormant',()=>{
    const h=fixture();
    const root=h.topics.createTopic({displayName:'自媒体生产线',stage:'active_project',createdAt:new Date('2026-08-01T00:00:00Z')});
    const result=buildCurrentFounderWorkMap({client:h.db.client,chatId,since:'2026-08-31T00:00:00Z',until:'2026-10-19T00:00:00Z',approvedChatIds:[chatId],expectedCanonicalTopicCount:3});
    expect(result.boardView.topics.find(topic=>topic.id===root.id)?.dormant).toBeFalsy();
  });
});

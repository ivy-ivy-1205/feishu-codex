import { expect, it } from 'vitest';
import { createSqliteDatabase } from '../src/db/client.js';
import { migrateDatabase } from '../src/db/migrate.js';
import { ContextSourceRepository } from '../src/repositories/context-source-repository.js';
import { captureGroupMessageSource } from '../src/services/group-message-source-capture.js';
import { buildFounderWorkMapPreview } from '../src/services/founder-work-map-preview.js';

it('builds a reviewable map with founder views without changing the database', async () => {
  const db=createSqliteDatabase(':memory:');migrateDatabase(db.client);const sources=new ContextSourceRepository(db.client);
  const at=new Date('2026-09-10T10:00:00.000Z');
  const ivy=sources.saveSource(captureGroupMessageSource({chatId:'oc_group',messageId:'om_ivy',threadId:null,rootId:null,
    author:{openId:'ou_ivy',displayName:null},senderType:'user',messageType:'text',text:'官网项目，目标是交付首页，今天开始整理首页结构。',occurredAt:at.toISOString()},at).source).source;
  const james=sources.saveSource(captureGroupMessageSource({chatId:'oc_group',messageId:'om_james',threadId:null,rootId:null,
    author:{openId:'ou_james',displayName:null},senderType:'user',messageType:'text',text:'官网项目先完成文案，页面结构可以后做。',occurredAt:new Date(at.getTime()+1000).toISOString()},at).source).source;
  const capturedAt=new Date('2026-09-21T00:00:00.000Z');
  const syncRef='feishu:chat:oc_group:sync:2026-09-21T00:00:00.000Z';
  sources.saveSource({sourceSystem:'feishu',sourceType:'feishu_sync_coverage',externalId:`${syncRef}:coverage`,logicalKey:`${syncRef}:coverage`,
    occurredAt:capturedAt.toISOString(),authors:[],locatorUri:null,contentFormat:'application/json',contentText:JSON.stringify({
      chatId:'oc_group',requestedRange:{since:'2026-09-01T00:00:00.000Z',until:'2026-09-20T00:00:00.000Z'}}),
    metadata:{chatId:'oc_group'},availabilityStatus:'available',capturedAt});
  sources.saveSource({sourceSystem:'feishu',sourceType:'feishu_sync_gap',externalId:`${syncRef}:gap:FILE_TEXT_UNREADABLE:1`,logicalKey:`${syncRef}:gap:FILE_TEXT_UNREADABLE:1`,
    occurredAt:capturedAt.toISOString(),authors:[],locatorUri:null,contentFormat:'application/json',contentText:JSON.stringify({code:'FILE_TEXT_UNREADABLE'}),
    metadata:{chatId:'oc_group'},availabilityStatus:'unknown',capturedAt});
  const before=db.client.prepare('SELECT (SELECT count(*) FROM context_sources) sources,(SELECT count(*) FROM context_topics) topics,(SELECT count(*) FROM outbox) outbox').get();
  const result=await buildFounderWorkMapPreview({client:db.client,chatId:'oc_group',since:'2026-09-01T00:00:00.000Z',until:'2026-09-20T00:00:00.000Z',
    sourceIds:[ivy.id,james.id],founderOpenIds:{ivy:'ou_ivy',james:'ou_james'},
    analyzer:{async analyze(){return{topics:[{displayName:'官网项目',stage:'active_project',outcome:'交付首页',currentAction:'今天开始整理首页结构',confidence:'high',
      sourceIds:[ivy.id,james.id],evidenceExcerpts:[{sourceId:ivy.id,excerpt:ivy.contentText},{sourceId:james.id,excerpt:james.contentText}],
      joinDecision:{kind:'new',topicId:null,confidence:'high',sharedTerms:[]},splitSuggestions:[]}]}}},
    perspectiveAnalyzer:{async analyze(input){const i=input.evidence.find(e=>e.founder==='ivy')!,j=input.evidence.find(e=>e.founder==='james')!;return{
      observations:[{topicId:i.topicIds[0]!,evidenceId:i.id,statement:'今天开始整理首页结构',speechAct:'decision_proposal',decisionKey:'execution-order',confidence:0.9,observedAt:new Date(i.occurredAt)},
        {topicId:j.topicIds[0]!,evidenceId:j.id,statement:'官网项目先完成文案',speechAct:'decision_proposal',decisionKey:'execution-order',confidence:0.9,observedAt:new Date(j.occurredAt)}],
      alignmentProposals:[{topicId:i.topicIds[0]!,decisionKey:'execution-order',dimension:'direction',ivy:{evidenceId:i.id,statement:'今天开始整理首页结构'},james:{evidenceId:j.id,statement:'官网项目先完成文案'},actionConsequence:null,actionHorizon:null}]}}}});
  expect(result.coverage).toEqual({status:'partial',gapsByCode:{FILE_TEXT_UNREADABLE:1}});
  expect(result.topics[0]).toMatchObject({displayName:'官网项目',stage:'active_project',outcome:'交付首页',currentAction:'今天开始整理首页结构'});
  expect(result.topics[0]?.perspectives.map(p=>p.founder)).toEqual(['ivy','james']);
  expect(result.alignmentProposals).toHaveLength(1);
  expect(result.evidence).toEqual(expect.arrayContaining([
    expect.objectContaining({sourceId:ivy.id,messageId:'om_ivy',founder:'ivy'}),
    expect.objectContaining({sourceId:james.id,messageId:'om_james',founder:'james'})
  ]));
  expect(JSON.stringify(result.evidence)).not.toContain('ou_ivy');
  expect(JSON.stringify(result.evidence)).not.toContain('ou_james');
  expect(JSON.stringify(result.cards)).toContain('文件正文不可读：1');
  expect(db.client.prepare('SELECT (SELECT count(*) FROM context_sources) sources,(SELECT count(*) FROM context_topics) topics,(SELECT count(*) FROM outbox) outbox').get()).toEqual(before);
  db.close();
});

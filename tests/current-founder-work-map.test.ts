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
    expect(body).toContain('历史提议（James，2026-09-02）');
    expect(body).toContain('待对齐（Ivy，2026-09-20）');
    expect(body).toContain('归属：A 线');
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
});

import {describe,it,expect} from 'vitest';
import {createSqliteDatabase} from '../src/db/client.js';
import {migrateDatabase} from '../src/db/migrate.js';
import {ContextSourceRepository} from '../src/repositories/context-source-repository.js';
import {AlignmentRepository} from '../src/repositories/alignment-repository.js';
import {AlignmentIssueRepository} from '../src/repositories/alignment-issue-repository.js';
import {TopicRepository} from '../src/repositories/topic-repository.js';
import {OutboxRepository} from '../src/repositories/outbox-repository.js';
import {captureMinuteTranscriptSource} from '../src/services/context-source-capture.js';
import {saveFounderEvidence} from '../src/services/founder-stream-worker.js';
import {PerspectiveReconciler,type PerspectiveObservation} from '../src/services/perspective-reconciler.js';
import {AlignmentDetector} from '../src/services/alignment-detector.js';
import {AlignmentNotificationPolicy} from '../src/services/alignment-notification-policy.js';
import {evidenceOrder,compareEvidence} from '../src/services/evidence-order.js';
import {captureGroupMessageSource} from '../src/services/group-message-source-capture.js';

function setup(){
  const db=createSqliteDatabase(':memory:');migrateDatabase(db.client);const at=new Date('2030-01-01T12:00:00Z');
  const sources=new ContextSourceRepository(db.client),alignment=new AlignmentRepository(db.client);
  for(const founder of ['ivy','james'] as const)alignment.configureFounderIdentity({founder,sourceSystem:'feishu',externalAuthorId:`ou_${founder}`,configuredAt:at});
  const topic=new TopicRepository(db.client).createTopic({displayName:'知识库',stage:'active_project',createdAt:at});
  const texts=['按 A 方案推进，今天开始实施','按 B 方案推进，今天开始实施','按 A 方案推进','同意按 A 方案推进'];
  const source=sources.saveSource(captureMinuteTranscriptSource({minuteId:'obcn_order',title:'会议',startedAt:'2030-01-01T10:00:00Z',endedAt:'2030-01-01T11:00:00Z',
    transcript:texts.map((text,i)=>({text,speakerName:i%2?'James':'Ivy',speakerOpenId:i%2?'ou_james':'ou_ivy',startMs:i,endMs:i+1}))},at).source).source;
  const ids=texts.map(text=>saveFounderEvidence(sources,source.id,text,at));
  // The third text is a prefix of the first; bind the exact intended third segment.
  ids[2]=sources.saveEvidence({sourceId:source.id,excerpt:texts[2]!,locator:{kind:'minute_segment',sourceVersion:source.sourceVersion,contentHash:source.contentHash,
    segmentOrdinal:2,speakerName:'Ivy',startMs:2,endMs:3},evidenceLevel:'primary_statement',capturedAt:at}).evidence.id;
  const reconciler=new PerspectiveReconciler(alignment);
  const observations:PerspectiveObservation[]=[{topicId:topic.id,evidenceId:ids[2]!,statement:texts[2]!,speechAct:'decision_proposal',decisionKey:'release',confidence:1,observedAt:at},
    {topicId:topic.id,evidenceId:ids[3]!,statement:texts[3]!,speechAct:'explicit_agreement',decisionKey:'release',confidence:1,observedAt:at}];
  const candidate=new AlignmentDetector().propose({topicId:topic.id,decisionKey:'release',dimension:'direction',ivy:{evidenceId:ids[0],statement:'按 A 方案推进'},james:{evidenceId:ids[1],statement:'按 B 方案推进'},
    actionConsequence:{evidenceId:ids[0],excerpt:'今天开始实施'},actionHorizon:{evidenceId:ids[0],excerpt:'今天',startsAt:'2030-01-01T00:00:00Z',endsAt:'2030-01-02T00:00:00Z'}});
  const policy=new AlignmentNotificationPolicy(new AlignmentIssueRepository(db.client),alignment,new OutboxRepository(db.client));
  return{db,at,ids,source,sources,alignment,reconciler,observations,candidate,policy};
}
describe('trusted evidence ordering',()=>{
  it('leaves an untimed meeting with unknown end open instead of inventing an ordering against a later group point',()=>{
    const h=setup(),old=h.source;
    const metadata={...old.metadata};delete metadata.endedAt;
    const {id:_id,sourceVersion:_sourceVersion,contentHash:_contentHash,contentState:_contentState,
      rawTextExpiresAt:_rawTextExpiresAt,redactedAt:_redactedAt,capturedAt:_capturedAt,...oldInput}=old;
    const source=h.sources.saveSource({...oldInput,externalId:'obcn_open',logicalKey:'open-minute',metadata,capturedAt:h.at}).source;
    const id=saveFounderEvidence(h.sources,source.id,'按 A 方案推进',h.at);
    const group=h.sources.saveSource(captureGroupMessageSource({chatId:'oc_test',messageId:'late_group',threadId:null,rootId:null,
      author:{openId:'ou_james',displayName:'James'},senderType:'user',messageType:'text',text:'同意按 A 方案推进',occurredAt:'2030-01-01T11:30:00Z'},h.at).source).source;
    expect(compareEvidence(h.db.client,saveFounderEvidence(h.sources,group.id,'同意按 A 方案推进',h.at),id)).toBeNull();
    const other=saveFounderEvidence(h.sources,source.id,'按 B 方案推进，今天开始实施',h.at);
    const full=saveFounderEvidence(h.sources,source.id,'按 A 方案推进，今天开始实施',h.at);
    const candidate=new AlignmentDetector().propose({topicId:h.candidate.topicId,decisionKey:'open',dimension:'direction',
      ivy:{evidenceId:full,statement:'按 A 方案推进'},james:{evidenceId:other,statement:'按 B 方案推进'},
      actionConsequence:{evidenceId:full,excerpt:'今天开始实施'},actionHorizon:{evidenceId:full,excerpt:'今天',startsAt:'2030-01-01T00:00:00Z',endsAt:'2030-01-02T00:00:00Z'}});
    expect(h.policy.evaluate(candidate,h.at).send).toBe(false);h.db.close();
  });
  it('cannot order an untimed minute proposal against a group agreement during that meeting, but can after it ends',()=>{
    const h=setup();h.reconciler.reconcile(h.observations[0]!);
    const send=(messageId:string,occurredAt:string)=>{
      const captured=captureGroupMessageSource({chatId:'oc_test',messageId,threadId:null,rootId:null,author:{openId:'ou_james',displayName:'James'},
        senderType:'user',messageType:'text',text:'同意按 A 方案推进',occurredAt},h.at);
      const source=h.sources.saveSource(captured.source).source;
      const id=saveFounderEvidence(h.sources,source.id,'同意按 A 方案推进',h.at);
      h.reconciler.reconcile({...h.observations[1]!,evidenceId:id});return id;
    };
    const overlap=send('inside','2030-01-01T10:30:00Z');
    expect(compareEvidence(h.db.client,overlap,h.ids[2]!)).toBeNull();
    expect(h.alignment.getCurrentPerspective(h.candidate.topicId,'shared_decision')).toBeNull();
    const later=send('after','2030-01-01T11:30:00Z');
    expect(compareEvidence(h.db.client,later,h.ids[2]!)).toBe(1);
    expect(h.alignment.getCurrentPerspective(h.candidate.topicId,'shared_decision')).not.toBeNull();h.db.close();
  });
  it('recognizes a later agreement in the same untimed minute without pretending ordinal is elapsed milliseconds',()=>{
    const h=setup();h.reconciler.reconcileBatch([...h.observations].reverse());
    expect(h.alignment.getCurrentPerspective(h.candidate.topicId,'shared_decision')).not.toBeNull();
    expect(evidenceOrder(h.db.client,h.ids[3]!)?.occurredAt).toBe(Date.parse('2030-01-01T10:00:00Z'));
    expect(compareEvidence(h.db.client,h.ids[3]!,h.ids[0]!)).toBe(1);
    expect(h.policy.evaluate(h.candidate,h.at)).toEqual({send:false,reason:'naturally_resolved'});h.db.close();
  });
  it('uses a verified media offset only when explicit timing provenance is present',()=>{
    const h=setup();const source=h.sources.saveSource(captureMinuteTranscriptSource({minuteId:'obcn_clock',title:'时间',startedAt:'2030-01-01T10:00:00Z',endedAt:'2030-01-01T11:00:00Z',
      transcript:[{speakerName:'Ivy',speakerOpenId:'ou_ivy',startMs:60_000,endMs:61_000,text:'已确认',timingKind:'media_offset' as const},
        {speakerName:'Ivy',speakerOpenId:'ou_ivy',startMs:10_000,endMs:11_000,text:'早先发言',timingKind:'media_offset' as const}]},h.at).source).source;
    const id=saveFounderEvidence(h.sources,source.id,'已确认',h.at);
    expect(evidenceOrder(h.db.client,id)?.occurredAt).toBe(Date.parse('2030-01-01T10:01:00Z'));
    expect(compareEvidence(h.db.client,id,saveFounderEvidence(h.sources,source.id,'早先发言',h.at))).toBe(1);h.db.close();
  });
});

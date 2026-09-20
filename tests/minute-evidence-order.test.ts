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

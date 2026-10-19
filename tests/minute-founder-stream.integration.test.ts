import { describe, expect, it, vi } from 'vitest';
import { createSqliteDatabase } from '../src/db/client.js';
import { migrateDatabase } from '../src/db/migrate.js';
import { JobRepository } from '../src/repositories/job-repository.js';
import { MeetingRepository } from '../src/repositories/meeting-repository.js';
import { OutboxRepository } from '../src/repositories/outbox-repository.js';
import { ContextSourceRepository } from '../src/repositories/context-source-repository.js';
import { TopicRepository } from '../src/repositories/topic-repository.js';
import { AlignmentRepository } from '../src/repositories/alignment-repository.js';
import { createFounderStreamRuntime, saveFounderEvidence, type FounderPerspectiveAnalysisPort } from '../src/services/founder-stream-worker.js';
import { captureGroupMessageSource } from '../src/services/group-message-source-capture.js';
import { captureMinuteTranscriptSource } from '../src/services/context-source-capture.js';
import { processMinuteJob, type MeetingWorkerDependencies } from '../src/services/meeting-worker.js';
import { createWorkerRuntime } from '../src/composition/worker-runtime.js';
import { FeishuMessageDeliveryAdapter } from '../src/adapters/feishu.js';
import { founderSourceText } from '../src/services/founder-card.js';
import type { MinuteContext } from '../src/ports/feishu.js';

const chat = 'oc_a84d5b6ca478220d0a37964b50776edb';
const at = new Date('2030-01-01T00:00:00Z');
const minute: MinuteContext = { minuteId:'obcn_fixture', title:'讨论', startedAt:'2029-12-31T00:00:00Z',
  endedAt:'2029-12-31T00:30:00Z', transcript:[{speakerName:'Ivy',startMs:0,endMs:1000,text:'知识库，交付销售演示稿，今天起草。'}] };
function harness(failAnalysis=false, perspectiveAnalyzer?: FounderPerspectiveAnalysisPort, context=minute) {
  const db=createSqliteDatabase(':memory:');migrateDatabase(db.client);
  const jobs=new JobRepository(db.client),meetings=new MeetingRepository(db.client),outbox=new OutboxRepository(db.client);
  const sources=new ContextSourceRepository(db.client),topics=new TopicRepository(db.client),alignment=new AlignmentRepository(db.client);
  const seen: string[][]=[];
  const founder=createFounderStreamRuntime({client:db.client,jobRepository:jobs,approvedChatIds:[chat],ivyPrivateChatId:'oc_private',
    flags:{captureEnabled:true,analysisEnabled:true,groupDeliveryEnabled:false},now:()=>at,
    perspectiveAnalyzer:perspectiveAnalyzer??{async analyze(input){seen.push([...input.sourceIds]);return{observations:[],alignmentProposals:[]}}},
    analyzer:{async analyze(input){if(failAnalysis)throw new Error('offline'); const source=input.sources.find(s=>s.sourceType==='minute_transcript')!;
      return{topics:[{displayName:'知识库',stage:'active_project',outcome:'交付销售演示稿',currentAction:'今天起草',confidence:'high',
        sourceIds:[source.id],evidenceExcerpts:[{sourceId:source.id,excerpt:'知识库，交付销售演示稿，今天起草。'}],
        joinDecision:{kind:'exact_continuation',topicId:input.currentTopics[0]!.id,confidence:'high',sharedTerms:['知识库']},splitSuggestions:[]}]};}}});
  const group=sources.saveSource(captureGroupMessageSource({chatId:chat,messageId:'om_idea',threadId:null,rootId:null,
    author:{openId:'ou_ivy',displayName:'Ivy'},senderType:'user',messageType:'text',text:'知识库',occurredAt:'2029-12-30T00:00:00Z'},at).source).source;
  topics.createTopic({displayName:'知识库',stage:'idea',evidenceIds:[saveFounderEvidence(sources,group.id,'知识库',at)],createdAt:at});
  meetings.ingestMinute({minuteId:minute.minuteId,eventId:'evt_minute'});jobs.enqueueProcessMinute(minute.minuteId);
  const dependencies:MeetingWorkerDependencies={reader:{async getMinute(){return context}},
    summarizer:{async summarize(){return{oneLineConclusion:'推进知识库',progress:[],decisions:[],risks:[],todos:[{title:'起草演示稿',description:'整理销售演示稿',risk:'low',capability:'content_draft',projectKey:null,subprojectKey:null,projectConfidence:'low',projectEvidence:'会议',projectPrompt:'起草演示稿'}]}}},
    meetingRepository:meetings,jobRepository:jobs,outboxRepository:outbox,targetChatId:'oc_private',now:()=>at,founder};
  const process=()=>processMinuteJob(jobs.leaseNextProcessMinute(at)!,dependencies);
  return{db,jobs,meetings,outbox,sources,topics,alignment,founder,process,group,seen,dependencies};
}
describe('Minutes and founder stream share context but not failure domains',()=>{
  it('the shared worker still delivers the personalized summary when founder enqueue is unavailable',async()=>{
    const h=harness();vi.spyOn(h.jobs,'enqueueFounderStreamBatch').mockImplementation(()=>{throw new Error('queue unavailable')});
    const runtime=createWorkerRuntime({enabled:true,founder:h.founder,meetingRepository:h.meetings,jobRepository:h.jobs,
      outboxRepository:h.outbox,reader:h.dependencies.reader,summarizer:h.dependencies.summarizer,targetChatId:'oc_private',now:()=>at,
      delivery:new FeishuMessageDeliveryAdapter({async getMinuteBasicInfo(){return{}},async exportMinuteTranscript(){return[]},
        async sendTextMessage(){return{messageId:'om_summary'}},async sendInteractiveMessage(){return{messageId:'om_summary'}}})});
    await runtime.runOnce();await runtime.runOnce();
    expect(h.meetings.findSummaryByMinute(minute.minuteId)?.summaryMessageId).toBe('om_summary');
    expect(h.db.client.prepare("SELECT COUNT(*) n FROM outbox WHERE status='delivered'").get()).toEqual({n:1});h.db.close();
  });
  it('preserves the handoff marker on the first immutable source when Phase 1E also captures the transcript',async()=>{
    const h=harness();h.dependencies.context={enabled:true,sourceRepository:h.sources,extractorVersion:'v1',promptVersion:'v1',sourceMaxBytes:200_000,sourceMaxSegments:1000};
    await h.process();await h.founder.runOnce();
    const source=h.sources.listSources().filter(s=>s.sourceType==='minute_transcript');expect(source).toHaveLength(1);
    expect(source[0]?.metadata).toMatchObject({founderStreamEligible:true,founderStreamChatId:chat});
    expect(h.topics.listCurrentTopics()[0]?.stage).toBe('active_project');h.db.close();
  });
  it('recovers only explicitly marked minute handoffs for the current approved stream',async()=>{
    const h=harness();
    for(const target of [undefined,'oc_other',chat]){
      const captured=captureMinuteTranscriptSource({...minute,minuteId:`obcn_scope_${target??'old'}`},at);
      if(target)Object.assign(captured.source.metadata,{founderStreamEligible:true,founderStreamChatId:target});
      h.sources.saveSource(captured.source);
    }
    await h.founder.afterTick();
    const rows=h.db.client.prepare("SELECT payload FROM batch_jobs WHERE type='analyze_founder_stream_batch'").all() as {payload:string}[];
    expect(rows).toHaveLength(1);
    const id=JSON.parse(rows[0]!.payload).sourceIds[0];expect(h.sources.getSource(id)?.externalId).toBe(`obcn_scope_${chat}`);h.db.close();
  });
  it('persists only the configured founder view from the shared structured port, never consensus by display name',async()=>{
    const h=harness(false,{async analyze(input){const e=input.evidence.find(e=>e.excerpt.includes('交付'))!;
      return{observations:[{topicId:input.topicIds[0]!,evidenceId:e.id,statement:'交付销售演示稿',speechAct:'view',decisionKey:null,confidence:0.9,observedAt:at}],alignmentProposals:[]};
    }},{...minute,transcript:[{...minute.transcript[0]!,speakerOpenId:'ou_ivy'}]});
    h.alignment.configureFounderIdentity({founder:'ivy',sourceSystem:'feishu',externalAuthorId:'ou_ivy',configuredAt:at});
    await h.process();await h.founder.runOnce();const topic=h.topics.listCurrentTopics()[0]!;
    expect(h.alignment.getCurrentPerspective(topic.id,'ivy_view')?.statement).toBe('交付销售演示稿');
    expect(h.alignment.getCurrentPerspective(topic.id,'shared_decision')).toBeNull();h.db.close();
  });
  it('rejects structured observations outside the bounded topic/evidence set atomically',async()=>{
    const h=harness(false,{async analyze(input){return{observations:[{topicId:input.topicIds[0]!,evidenceId:'outside',statement:'错误',speechAct:'view',decisionKey:null,confidence:1,observedAt:at}],alignmentProposals:[]}}});
    await h.process();await h.founder.runOnce();
    expect(h.topics.listCurrentTopics()[0]?.stage).toBe('idea');
    expect(h.db.client.prepare('SELECT COUNT(*) n FROM topic_perspective_versions').get()).toEqual({n:0});
    expect(h.db.client.prepare("SELECT status FROM batch_jobs WHERE type='analyze_founder_stream_batch'").get()).toEqual({status:'retry'});h.db.close();
  });
  it('joins an earlier chat idea with later meeting action without duplicate summary/Todo',async()=>{
    const h=harness();expect(await h.process()).toBe('completed');
    const saved=h.sources.listSources().find(s=>s.sourceType==='minute_transcript');expect(saved).toBeDefined();
    await h.founder.runOnce();await h.founder.captureMinute(minute);await h.founder.runOnce();
    expect(h.topics.listCurrentTopics()).toHaveLength(1);expect(h.topics.listCurrentTopics()[0]?.stage).toBe('active_project');
    expect(h.topics.listCurrentTopics()[0]?.evidenceIds.map(id=>h.sources.getEvidence(id)?.sourceId).sort()).toEqual([h.group.id,saved!.id].sort());
    expect(h.seen[0]).toEqual(expect.arrayContaining([h.group.id,saved!.id]));
    expect(h.db.client.prepare('SELECT COUNT(*) n FROM meeting_todos').get()).toEqual({n:1});
    expect(h.db.client.prepare('SELECT COUNT(*) n FROM outbox').get()).toEqual({n:1});
    expect(h.db.client.prepare("SELECT COUNT(*) n FROM batch_jobs WHERE type='analyze_founder_stream_batch'").get()).toEqual({n:1});h.db.close();
  });
  it('keeps the immutable source and summary on enqueue failure and retries handoff independently',async()=>{
    const h=harness();const spy=vi.spyOn(h.jobs,'enqueueFounderStreamBatch').mockImplementation(()=>{throw new Error('queue fault')});
    expect(await h.process()).toBe('completed');expect(h.meetings.findSummaryByMinute(minute.minuteId)).not.toBeNull();
    expect(h.sources.listSources().filter(s=>s.sourceType==='minute_transcript')).toHaveLength(1);
    spy.mockRestore();await h.founder.afterTick();await h.founder.runOnce();
    expect(h.topics.listCurrentTopics()[0]?.stage).toBe('active_project');
    expect(h.db.client.prepare('SELECT COUNT(*) n FROM outbox').get()).toEqual({n:1});h.db.close();
  });
  it('analysis failure retries only its job and never repeats existing meeting summary',async()=>{
    const h=harness(true);await h.process();await h.founder.runOnce();
    expect(h.meetings.findSummaryByMinute(minute.minuteId)).not.toBeNull();
    expect(h.db.client.prepare("SELECT status FROM batch_jobs WHERE type='analyze_founder_stream_batch'").get()).toEqual({status:'retry'});
    expect(h.db.client.prepare('SELECT COUNT(*) n FROM outbox').get()).toEqual({n:1});h.db.close();
  });
  it('does not infer a founder from speaker display name, but accepts verified configured per-segment ID',()=>{
    const h=harness();h.alignment.configureFounderIdentity({founder:'ivy',sourceSystem:'feishu',externalAuthorId:'ou_ivy',configuredAt:at});
    for(const identified of [false,true]){
      const source=h.sources.saveSource(captureMinuteTranscriptSource({...minute,minuteId:`obcn_${identified}`,
        transcript:[{...minute.transcript[0]!,...(identified?{speakerOpenId:'ou_ivy'}:{})}]},at).source).source;
      const evidence=saveFounderEvidence(h.sources,source.id,'知识库',at);
      expect(h.alignment.resolveFounderForEvidence(evidence)).toBe(identified?'ivy':null);
    }h.db.close();
  });
  it('renders a safe external minute reference and never exposes an internal source ID',()=>{
    const h=harness();const source=h.sources.saveSource(captureMinuteTranscriptSource(minute,at).source).source;
    const evidence=h.sources.getEvidence(saveFounderEvidence(h.sources,source.id,'知识库',at))!;
    const text=founderSourceText({...evidence,occurredAt:source.occurredAt,minuteToken:source.externalId});
    expect(text).toContain('obcn_fixture');expect(text).not.toContain(source.id);
    expect(founderSourceText({...evidence,occurredAt:source.occurredAt,minuteToken:'https://evil.test/ctxsrc_secret'})).not.toContain('evil.test');h.db.close();
  });
});

import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createSqliteDatabase } from '../src/db/client.js';
import { migrateDatabase } from '../src/db/migrate.js';
import { JobRepository } from '../src/repositories/job-repository.js';
import { ContextSourceRepository } from '../src/repositories/context-source-repository.js';
import { TopicRepository } from '../src/repositories/topic-repository.js';
import { createFounderStreamRuntime } from '../src/services/founder-stream-worker.js';
import type { FounderStreamInput } from '../src/ports/founder-stream-analyzer.js';
import { captureGroupMessageSource } from '../src/services/group-message-source-capture.js';
import { saveFounderEvidence } from '../src/services/founder-stream-worker.js';
import { AlignmentRepository } from '../src/repositories/alignment-repository.js';
import { OutboxRepository } from '../src/repositories/outbox-repository.js';
import { renderFounderWorkMap } from '../src/services/founder-work-map-renderer.js';

const chat = 'oc_a84d5b6ca478220d0a37964b50776edb';
const start = new Date('2026-09-21T00:00:00.000Z');
function harness(flags = { captureEnabled: true, analysisEnabled: true, groupDeliveryEnabled: false }) {
  const db = createSqliteDatabase(':memory:'); migrateDatabase(db.client);
  const jobs = new JobRepository(db.client); const topics = new TopicRepository(db.client);
  const sources = new ContextSourceRepository(db.client);
  let now = start, calls = 0;
  const inputs: FounderStreamInput[] = [];
  const runtime = createFounderStreamRuntime({ client: db.client, jobRepository: jobs, flags,
    approvedChatIds: [chat], ivyPrivateChatId: 'oc_private', now: () => now,
    analyzer: { async analyze(input) { calls++; inputs.push(input); return { topics: [{
      displayName: '知识库', stage: 'idea', outcome: null, currentAction: null, confidence: 'high',
      sourceIds: [input.sources[0]!.id], evidenceExcerpts: [{ sourceId: input.sources[0]!.id, excerpt: '知识库' }],
      joinDecision: input.currentTopics.length ? { kind: 'exact_continuation', topicId: input.currentTopics[0]!.id,
        confidence: 'high', sharedTerms: ['知识库'] } : { kind: 'new', topicId: null, confidence: 'high', sharedTerms: [] }, splitSuggestions: []
    }] }; } }
  });
  const app = buildApp({ readiness: () => ({ ready: true }), verificationToken: 'verify', encryptKey: 'encrypt',
    logger: false, ingestMinute: () => ({ status: 'ignored' }), routeReply: () => ({ kind: 'reject', reason: 'wrong_chat' }),
    founderStream: runtime.route });
  return { db, jobs, sources, topics, runtime, app, inputs, calls: () => calls, setNow: (value: Date) => { now = value; } };
}
function event(id = 'om_1', eventId = `evt_${id}`, thread = '', sender = 'user', chatId = chat) {
  return { schema: '2.0', header: { token: 'verify', event_id: eventId, event_type: 'im.message.receive_v1', create_time: String(start.getTime()) },
    event: { sender: { sender_type: sender, sender_id: { open_id: 'ou_ivy' } }, message: {
      message_id: id, chat_id: chatId, chat_type: 'group', thread_id: thread, message_type: 'text',
      content: JSON.stringify({ text: `知识库 ${id}` }), create_time: String(start.getTime()) } } };
}
describe('founder stream durable wiring', () => {
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
});

import type Database from 'better-sqlite3';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import { ContextSourceRepository, type ContextSourceRecord } from '../repositories/context-source-repository.js';
import { JobRepository, LeaseLostError, type FounderStreamJob } from '../repositories/job-repository.js';
import { TopicRepository } from '../repositories/topic-repository.js';
import { OutboxRepository } from '../repositories/outbox-repository.js';
import { AlignmentRepository } from '../repositories/alignment-repository.js';
import { AlignmentIssueRepository } from '../repositories/alignment-issue-repository.js';
import { AlignmentNotificationPolicy } from './alignment-notification-policy.js';
import { routeFounderFeedback } from './founder-feedback-router.js';
import { captureGroupMessageSource } from './group-message-source-capture.js';
import { DurableJobConsumer } from './job-consumer.js';
import { reconcileTopics } from './topic-reconciler.js';
import { validateFounderStreamInput, type FounderStreamAnalyzer, type FounderStreamInput, type FounderStreamCurrentTopic } from '../ports/founder-stream-analyzer.js';
import type { PerspectiveObservation } from './perspective-reconciler.js';
import type { AlignmentProposal } from '../domain/alignment.js';
import type { MinuteContext } from '../ports/feishu.js';
import { captureMinuteTranscriptSource } from './context-source-capture.js';
import { PerspectiveReconciler } from './perspective-reconciler.js';
import { AlignmentDetector } from './alignment-detector.js';
import { renderAlignmentQuestion } from './alignment-question-renderer.js';
import { stableId } from './canonical-json.js';

export interface FounderPerspectiveAnalysisPort {
  analyze(input: { sourceIds: readonly string[]; topicIds: readonly string[];
    evidence: readonly { id: string; sourceId: string; topicIds: readonly string[]; excerpt: string; founder: 'ivy' | 'james' | null }[] }): Promise<{
    observations: readonly PerspectiveObservation[]; alignmentProposals: readonly AlignmentProposal[];
  }>;
}
export interface FounderStreamRoute { ingest(envelope: unknown): Record<string, unknown> | null }
export interface FounderStreamOptions {
  client: Database.Database; jobRepository: JobRepository; flags: AppConfig['founderStream'];
  approvedChatIds: readonly string[]; ivyPrivateChatId: string; analyzer?: FounderStreamAnalyzer;
  perspectiveAnalyzer?: FounderPerspectiveAnalysisPort;
  now?: () => Date; intervalMs?: number;
  policy?: Pick<AlignmentNotificationPolicy, 'reconcilePending'>;
  delivery?: { sendTextMessage(input: { chatId: string; text: string; idempotencyKey?: string }): Promise<{ messageId: string }>;
    sendInteractiveCard(input: { chatId: string; card: Record<string, unknown>; idempotencyKey?: string }): Promise<{ messageId: string }> };
}
const approvedGroup = 'oc_a84d5b6ca478220d0a37964b50776edb';
const incoming = z.object({ header: z.object({ event_id: z.string().min(1), create_time: z.string() }), event: z.object({
  sender: z.object({ sender_type: z.string(), sender_id: z.object({ open_id: z.string().optional() }).passthrough() }),
  message: z.object({ message_id: z.string().min(1), chat_id: z.string().min(1), message_type: z.string(),
    content: z.string(), create_time: z.string().optional(), thread_id: z.string().nullable().optional(),
    parent_id: z.string().nullable().optional(), root_id: z.string().nullable().optional() })
}) });

export function createFounderStreamRuntime(options: FounderStreamOptions) {
  if (options.jobRepository.client !== options.client) throw new Error('founder repositories must share one database');
  if (options.flags.analysisEnabled && !options.flags.captureEnabled) throw new Error('analysis requires capture');
  if (options.flags.groupDeliveryEnabled && (!options.flags.captureEnabled || !options.flags.analysisEnabled)) throw new Error('delivery requires capture and analysis');
  const now = options.now ?? (() => new Date());
  const sources = new ContextSourceRepository(options.client), topics = new TopicRepository(options.client);
  const outbox = new OutboxRepository(options.client);
  const perspectives = new AlignmentRepository(options.client);
  const perspectiveReconciler = new PerspectiveReconciler(perspectives);
  const notificationPolicy = new AlignmentNotificationPolicy(new AlignmentIssueRepository(options.client), perspectives, outbox);
  const policy = options.policy ?? new AlignmentNotificationPolicy(new AlignmentIssueRepository(options.client), new AlignmentRepository(options.client), outbox);
  const allowed = (chatId: string) => chatId === approvedGroup && options.approvedChatIds.includes(chatId);
  const route: FounderStreamRoute = { ingest(raw) {
    const chatId = (raw as { event?: { message?: { chat_id?: string } } })?.event?.message?.chat_id;
    if (chatId === options.ivyPrivateChatId) return null;
    if (!chatId || !allowed(chatId) || !options.flags.captureEnabled) return { status: 'ignored' };
    const parsed = incoming.safeParse(raw); if (!parsed.success) return { status: 'rejected', reason: 'invalid_group_event' };
    const { header, event } = parsed.data, message = event.message;
    const at = parseTime(message.create_time ?? header.create_time); if (!at) return { status: 'rejected', reason: 'invalid_time' };
    return options.client.transaction(() => {
      if (options.client.prepare('SELECT 1 FROM founder_stream_events WHERE event_id=? OR message_id=?').get(header.event_id, message.message_id)) return { status: 'duplicate' };
      const stamp = now(), text = messageText(message.message_type, message.content);
      let disposition = event.sender.sender_type !== 'user' ? 'bot_audit' : !text ? 'skipped_media' : 'captured';
      let decision: ReturnType<typeof routeFounderFeedback> | undefined;
      if (disposition === 'captured') {
        const replyTo = message.parent_id || message.root_id || null;
        const correctionLike = /^(?:第\s*\d+\s*项(?:改|只是|拆)|\d+\s*(?:和|与)\s*\d+\s*是同一个|这个(?:只是想法|改名为|改为|拆分为)|暂停\s*\d+\s*项)/u.test(text!);
        if ((replyTo && outbox.findDeliveredFounderMessage(chatId, replyTo)) || correctionLike) {
          decision = routeFounderFeedback({ chatId, openId: event.sender.sender_id.open_id ?? '', messageId: message.message_id,
            replyTo, text, occurredAt: at, threadId: message.thread_id || null, rootId: message.root_id || null },
          { client: options.client, approvedChatIds: [chatId], now });
          if (decision.kind !== 'reject' || decision.reason !== 'unrelated_message') {
            disposition = 'feedback';
            if ('text' in decision) enqueueFeedback(options.client, chatId, message.message_id, decision.text, stamp);
          }
        }
        if (disposition === 'captured') {
          const captured = captureGroupMessageSource({ chatId, messageId: message.message_id, threadId: message.thread_id || null,
            rootId: message.root_id || null, author: { openId: event.sender.sender_id.open_id ?? null, displayName: null },
            messageType: message.message_type, senderType: 'user', text: text!, occurredAt: at }, stamp);
          const source = sources.saveSource(captured.source).source;
          options.jobRepository.enqueueGroupCapture({ messageId: message.message_id, chatId, sourceIds: [source.id],
            threadId: message.thread_id || message.root_id || null, capturedAt: stamp });
        }
      }
      options.client.prepare('INSERT INTO founder_stream_events(event_id,message_id,chat_id,disposition,received_at) VALUES(?,?,?,?,?)')
        .run(header.event_id, message.message_id, chatId, disposition, stamp.toISOString());
      return decision ? { status: 'founder_feedback_decision', decision } : { status: disposition };
    }).immediate();
  } };
  async function process(job: FounderStreamJob) {
    try {
      if (!allowed(job.chatId)) throw new Error('unapproved founder group');
      if (job.kind === 'capture_group_message') {
        options.client.transaction(() => {
          if (!options.jobRepository.ownsLease(job, now())) throw new LeaseLostError(job.key);
          if (options.flags.analysisEnabled) options.jobRepository.debounceFounderStream({ ...job, now: now() });
          options.jobRepository.markCompleted(job, now());
        }).immediate();
      } else {
        if (job.sourceIds.length > 20) {
          options.client.transaction(() => {
            const stamp=now();if(!options.jobRepository.ownsLease(job,stamp))throw new LeaseLostError(job.key);
            const ordered=job.sourceIds.slice().sort((a,b)=>(sources.getSource(a)?.occurredAt??a).localeCompare(sources.getSource(b)?.occurredAt??b));
            for(let offset=0;offset<ordered.length;offset+=20) options.jobRepository.enqueueFounderStreamBatch({
              chatId:job.chatId,since:stamp.toISOString(),until:stamp.toISOString(),sourceIds:ordered.slice(offset,offset+20),capturedAt:stamp });
            options.jobRepository.markCompleted(job,stamp);
          }).immediate();
          return 'completed' as const;
        }
        if (!options.analyzer) throw new Error('founder analyzer unavailable');
        const input = buildFounderStreamInput(sources, topics, job.sourceIds, job.chatId);
        const analysis = input.sources.length ? await options.analyzer.analyze(input) : { topics: [] };
        const plan = reconcileTopics(input, analysis);
        const plannedAt = now();
        const prepared = plan.topics.map(item => ({ item,
          topicId: item.topicId ?? stableId('topic', `${new Date(plannedAt.getTime()+item.proposalIndex).toISOString()}\n${item.proposal.displayName.trim()}`),
          ids: item.evidenceExcerpts.map(e => saveFounderEvidence(sources,e.sourceId,e.excerpt,plannedAt)) }));
        const scopedEvidence = new Map<string, { id:string;sourceId:string;topicIds:string[];excerpt:string;founder:'ivy'|'james'|null }>();
        for (const row of prepared) {
          const previous = input.currentTopics.find(t=>t.id===row.topicId)?.evidenceExcerpts ?? [];
          const ids = [...row.ids,...previous.map(e=>saveFounderEvidence(sources,e.sourceId,e.excerpt,plannedAt))];
          for(const id of ids) {
            const evidence=sources.getEvidence(id)!;
            const existing=scopedEvidence.get(id);
            if(existing) { if(!existing.topicIds.includes(row.topicId)) existing.topicIds.push(row.topicId); }
            else scopedEvidence.set(id,{id,sourceId:evidence.sourceId,topicIds:[row.topicId],excerpt:evidence.excerpt,founder:perspectives.resolveFounderForEvidence(id)});
          }
        }
        const perspectiveResult = options.perspectiveAnalyzer && prepared.length ? await options.perspectiveAnalyzer.analyze({
          sourceIds:input.sources.map(s=>s.id),topicIds:prepared.map(p=>p.topicId),evidence:[...scopedEvidence.values()]
        }) : { observations:[],alignmentProposals:[] };
        const assertScoped = (topicId:string,evidenceIds:readonly string[]) => {
          if(!prepared.some(p=>p.topicId===topicId) || evidenceIds.some(id=>!scopedEvidence.get(id)?.topicIds.includes(topicId)))
            throw new Error('FOUNDER_PERSPECTIVE_OUT_OF_SCOPE');
        };
        options.client.transaction(() => {
          const stamp = now(); if (!options.jobRepository.ownsLease(job, stamp)) throw new LeaseLostError(job.key);
          for (const {item,ids} of prepared) {
            const old = item.topicId ? topics.listCurrentTopics().find(t => t.id === item.topicId) : undefined;
            const evidenceIds = [...new Set([...(old?.evidenceIds ?? []), ...ids])];
            const rationale = JSON.stringify({ origin: 'founder_stream', jobKey: job.key, needsConfirmation: item.relations });
            if (item.action === 'join') topics.appendVersion({ topicId: item.topicId!, expectedVersion: item.expectedVersion!,
              displayName: item.proposal.displayName, stage: item.proposal.stage, outcome: item.proposal.outcome,
              evidenceIds, rationale, changedAt: stamp });
            else topics.createTopic({ displayName: item.proposal.displayName, stage: item.proposal.stage, outcome: item.proposal.outcome,
              evidenceIds, rationale, createdAt: new Date(plannedAt.getTime() + item.proposalIndex) });
          }
          for(const observation of perspectiveResult.observations) {
            assertScoped(observation.topicId,[observation.evidenceId]);
            const evidence=sources.getEvidence(observation.evidenceId)!;
            perspectiveReconciler.reconcile({...observation,observedAt:new Date(sources.getSource(evidence.sourceId)!.occurredAt)});
          }
          for(const proposal of perspectiveResult.alignmentProposals) {
            const candidate=new AlignmentDetector().propose(proposal);
            assertScoped(candidate.topicId,candidate.evidenceIds);
            const card=renderAlignmentQuestion({issue:{...candidate,status:'ready',createdAt:stamp.toISOString(),updatedAt:stamp.toISOString(),deliveredMessageId:null},
              topicName:prepared.find(p=>p.topicId===candidate.topicId)!.item.proposal.displayName,
              evidence:candidate.evidenceIds.map(id=>{
                const e=sources.getEvidence(id)!,s=sources.getSource(e.sourceId)!;
                return {...e,occurredAt:s.occurredAt,...(s.sourceType==='minute_transcript'?{minuteToken:s.externalId}:{})};
              })});
            notificationPolicy.prepare(candidate,{targetChatId:job.chatId,card:card.card},stamp);
          }
          policy.reconcilePending(stamp);
          options.jobRepository.markCompleted(job, stamp);
        }).immediate();
      }
      return 'completed' as const;
    } catch (error) {
      if (error instanceof LeaseLostError) return 'lost_lease' as const;
      try { options.jobRepository.retryFounderStream(job, now()); } catch (failure) {
        if (failure instanceof LeaseLostError) return 'lost_lease' as const; throw failure;
      }
      return 'retry' as const;
    }
  }
  const supportedKinds: FounderStreamJob['kind'][] = !options.flags.captureEnabled ? [] : options.flags.analysisEnabled ?
    ['capture_group_message','analyze_founder_stream_batch'] : ['capture_group_message'];
  const afterTick = async () => {
      if (!options.flags.analysisEnabled) return;
      // The immutable source survives an enqueue failure. Stable source-set keys
      // allow a later tick/restart to repair just the downstream handoff.
      if (allowed(approvedGroup)) for(const source of sources.listSources().filter(s=>s.sourceType==='minute_transcript' && s.availabilityStatus==='available' && minuteEligible(s,approvedGroup))) {
        try { enqueueMinute(source); } catch { /* Retry on the next independent tick. */ }
      }
      policy.reconcilePending(now());
      if (!options.flags.groupDeliveryEnabled || !options.delivery) return;
      await deliverFounderMessages(options, outbox, policy, now, allowed);
  };
  const consumer = new DurableJobConsumer({ now, intervalMs: options.intervalMs,
    leaseNext: at => options.jobRepository.leaseNextSupportedJob(at,supportedKinds),
    process: job => process(job as FounderStreamJob), afterTick
  });
  function enqueueMinute(source: ContextSourceRecord) {
    return options.jobRepository.enqueueFounderStreamBatch({chatId:approvedGroup,sourceIds:[source.id],since:source.occurredAt,until:now().toISOString(),capturedAt:now()});
  }
  function captureMinute(context: MinuteContext) {
    if(!options.flags.captureEnabled || !allowed(approvedGroup))return;
    const source=sources.saveSource(captureMinuteTranscriptSource(context,now(),{maxBytes:200_000,maxSegments:10_000},approvedGroup).source).source;
    if(options.flags.analysisEnabled && minuteEligible(source,approvedGroup))enqueueMinute(source);
  }
  return { route, process, afterTick, captureMinute,
    minuteCaptureChatId:options.flags.captureEnabled && allowed(approvedGroup)?approvedGroup:undefined,
    supportedKinds, runOnce: () => consumer.runOnce(), start: () => { if (options.flags.captureEnabled) consumer.start(); },
    stop: () => consumer.stop(), isConsumptionAvailable: () => consumer.isConsumptionAvailable() };
}

export function buildFounderStreamInput(sources: ContextSourceRepository, topics: TopicRepository, sourceIds: readonly string[], chatId: string): FounderStreamInput {
  const selected = new Map<string, ContextSourceRecord>();
  const trustedSource = (id: string) => {
    const source = sources.getSource(id);
    if (!source || source.availabilityStatus !== 'available' || !['group_message','minute_transcript'].includes(source.sourceType) ||
      (source.sourceType === 'group_message' && source.metadata.chatId !== chatId)) return null;
    if(source.sourceType==='minute_transcript' && !minuteEligible(source,chatId))return null;
    if (source.sourceType === 'group_message' && (source.metadata.senderType !== 'user' ||
      sources.client.prepare("SELECT 1 FROM outbox WHERE delivered_message_id=? AND status='delivered'").get(source.externalId))) return null;
    return source;
  };
  const include = (id: string) => {
    const source = trustedSource(id);
    if (source) selected.set(id, source);
    return source;
  };
  for (const id of sourceIds) {
    const source=sources.getSource(id);if(!source)throw new Error('FOUNDER_SOURCE_UNAVAILABLE');
    if(source.sourceType==='group_message' && (source.metadata.senderType!=='user' ||
      sources.client.prepare("SELECT 1 FROM outbox WHERE delivered_message_id=? AND status='delivered'").get(source.externalId))) continue;
    if(!include(id))throw new Error('FOUNDER_SOURCE_UNAVAILABLE');
  }
  if(selected.size===0)return {sources:[],currentTopics:[]};
  const currentTopics: FounderStreamCurrentTopic[] = [];
  for (const topic of topics.listCurrentTopics().slice(-200)) {
    // Filter first: a legacy/unknown author on one evidence item must not hide
    // independently trusted evidence attached to the same topic.
    const full = topic.evidenceIds.map(id => sources.getEvidence(id)).filter(e => e !== null)
      .filter(e => trustedSource(e.sourceId) !== null)
      .sort((a,b) => trustedSource(b.sourceId)!.occurredAt.localeCompare(trustedSource(a.sourceId)!.occurredAt) ||
        b.capturedAt.localeCompare(a.capturedAt) || b.id.localeCompare(a.id));
    const nameAnchor = full.find(e => e.excerpt.includes(topic.displayName));
    if (!nameAnchor) continue;
    const outcomeAnchor = topic.outcome === null ? undefined : full.find(e => e.excerpt.includes(topic.outcome!));
    const anchors = outcomeAnchor ? [nameAnchor, outcomeAnchor] : [nameAnchor];
    const bounded = [...new Map([...anchors, ...full].map(e => [e.id,e])).values()].slice(0,20);
    const addedSourceIds = new Set(bounded.filter(e => !selected.has(e.sourceId)).map(e => e.sourceId));
    if (selected.size + addedSourceIds.size > 500) continue;
    for (const evidence of bounded) include(evidence.sourceId);
    currentTopics.push({ id: topic.id, currentVersion: topic.currentVersion, displayName: topic.displayName,
      stage: topic.stage, outcome: outcomeAnchor ? topic.outcome : null, evidenceExcerpts: bounded.map(e => ({ sourceId:e.sourceId,excerpt:e.excerpt })) });
  }
  return validateFounderStreamInput({ sources: [...selected.values()], currentTopics });
}
function minuteEligible(source:ContextSourceRecord,chatId:string):boolean {
  return source.metadata.founderStreamEligible===true && source.metadata.founderStreamChatId===chatId;
}
export function saveFounderEvidence(repository: ContextSourceRepository, sourceId: string, excerpt: string, capturedAt: Date): string {
  const source = repository.getSource(sourceId); if (!source) throw new Error('source missing');
  let locator: unknown;
  if (source.sourceType === 'group_message') locator = { kind: 'group_message', sourceVersion: source.sourceVersion,
    contentHash: source.contentHash, chatId: source.metadata.chatId, messageId: source.externalId,
    threadId: source.metadata.threadId ?? null, authorOpenId: source.authors[0]?.openId ?? null, occurredAt: source.occurredAt };
  else {
    const segment = (source.metadata.segments as Record<string, unknown>[] | undefined)?.find(s => typeof s.text === 'string' && s.text.includes(excerpt));
    if (!segment) throw new Error('minute evidence must fit one segment');
    locator = { kind: 'minute_segment', sourceVersion: source.sourceVersion, contentHash: source.contentHash,
      segmentOrdinal:segment.segmentOrdinal,speakerName:segment.speakerName,startMs:segment.startMs,endMs:segment.endMs };
  }
  return repository.saveEvidence({ sourceId, excerpt, locator: locator as never, evidenceLevel:'primary_statement', capturedAt }).evidence.id;
}
function enqueueFeedback(client: Database.Database, chatId: string, messageId: string, text: string, at: Date) {
  const key = `founder-feedback:${chatId}:${messageId}`;
  client.prepare(`INSERT INTO outbox(id,destination,payload,idempotency_key,status,created_at)
    VALUES(?,?,?,?, 'pending',?) ON CONFLICT(idempotency_key) DO NOTHING`).run(key,chatId,
    JSON.stringify({ kind:'founder_feedback', targetChatId:chatId, text }),key,at.toISOString());
}
async function deliverFounderMessages(options: FounderStreamOptions, outbox: OutboxRepository,
  policy: Pick<AlignmentNotificationPolicy,'reconcilePending'>, now: () => Date, allowed: (id:string)=>boolean) {
  for (const message of outbox.listPendingAlignmentQuestions(now())) {
    policy.reconcilePending(now());
    if (!allowed(message.targetChatId) || !outbox.listPendingAlignmentQuestions(now()).some(m => m.issueId===message.issueId)) continue;
    try {
      const sent = await options.delivery!.sendInteractiveCard({ chatId: message.targetChatId, card: message.card,
        idempotencyKey: `alignment-question:${message.issueId}:${message.evidenceSetHash}` });
      outbox.acknowledgeAlignmentQuestionDelivery({ ...message, messageId:sent.messageId, deliveredAt:now() });
    } catch { outbox.markAlignmentQuestionRetry({ ...message,errorCode:'FOUNDER_DELIVERY_FAILED',retryAt:new Date(now().getTime()+30_000) }); }
  }
  const rows = options.client.prepare(`SELECT idempotency_key,payload FROM outbox WHERE status='pending'
    AND (next_attempt_at IS NULL OR next_attempt_at<=?)`).all(now().toISOString()) as {idempotency_key:string;payload:string}[];
  for (const row of rows) {
    const message = JSON.parse(row.payload);
    if (!['founder_feedback','founder_work_map'].includes(message.kind) || !allowed(message.targetChatId)) continue;
    policy.reconcilePending(now());
    try {
      const sent = message.kind==='founder_feedback' ? await options.delivery!.sendTextMessage({chatId:message.targetChatId,text:message.text,idempotencyKey:row.idempotency_key}) :
        await options.delivery!.sendInteractiveCard({chatId:message.targetChatId,card:message.card,idempotencyKey:row.idempotency_key});
      if (!sent.messageId.trim() || sent.messageId.startsWith('pending:')) throw new Error('invalid delivery');
      if (message.kind==='founder_work_map') outbox.acknowledgeFounderWorkMapDelivery({...message,messageId:sent.messageId,deliveredAt:now()});
      else options.client.prepare("UPDATE outbox SET status='delivered',delivered_message_id=?,delivered_at=? WHERE idempotency_key=? AND status='pending'")
        .run(sent.messageId,now().toISOString(),row.idempotency_key);
    } catch { options.client.prepare('UPDATE outbox SET attempt_count=attempt_count+1,next_attempt_at=?,last_error_code=? WHERE idempotency_key=? AND status=\'pending\'')
      .run(new Date(now().getTime()+30_000).toISOString(),'FOUNDER_DELIVERY_FAILED',row.idempotency_key); }
  }
}
function parseTime(value:string):string|null {
  const ms=/^\d+$/.test(value)? Number(value)*(value.length<=10?1000:1):Date.parse(value);
  return Number.isFinite(ms) && !Number.isNaN(new Date(ms).getTime())?new Date(ms).toISOString():null;
}
function messageText(type:string,content:string):string|null {
  try {
    const value=JSON.parse(content); if(type==='text') return typeof value.text==='string' && value.text.trim()?value.text:null;
    if(type!=='post') return null;
    const post=Array.isArray(value.content)?value:Object.values(value).find((v:any)=>Array.isArray(v?.content)) as any;
    const text=[post?.title??'',...(post?.content??[]).flat().map((leaf:any)=>leaf.tag==='text'?leaf.text:'')].join('\n').trim();
    return text||null;
  } catch { return null; }
}

import type Database from 'better-sqlite3';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import { ContextSourceRepository, type ContextSourceRecord } from '../repositories/context-source-repository.js';
import { JobRepository, LeaseLostError, type FounderDurableJob, type FounderStreamJob, type FounderStreamSpaceJob } from '../repositories/job-repository.js';
import { SpaceSyncRepository } from '../repositories/space-sync-repository.js';
import { confirmedSpaceProjectTopic, loadSpaceBatchSources, spaceCommentExcerpt } from './space-batch-processor.js';
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
import { canonicalJson, stableId } from './canonical-json.js';
import { topicCorrectionSchema } from './topic-correction-service.js';
import type { CurrentTopic, TopicVersion } from '../domain/topic.js';
import type { FeishuContextGap } from './feishu-context-sync.js';
import { isSelfMediaProposal, projectFounderWorkMap, type FounderWorkMapClassification } from './founder-work-map-classification.js';
import { parseFeishuAttachment } from './feishu-attachment-parser.js';
import { classifyFounderFailure, type FounderFailureStage } from './founder-analysis-failure.js';
import { buildFounderManualQueryMessages, enqueueFounderManualQuery, isConfiguredFounder, parseFounderManualQuery } from './founder-manual-query.js';
import { FounderWhiteboardPublishError, founderPalettes, type FounderWhiteboardArtifact } from './founder-whiteboard.js';
import type { FounderBoardView } from './founder-board-view.js';
import { founderBatchOperationsSchema } from './founder-batch-correction.js';

export interface FounderPerspectiveAnalysisPort {
  analyze(input: { sourceIds: readonly string[]; topicIds: readonly string[];
    evidence: readonly { id: string; sourceId: string; topicIds: readonly string[]; excerpt: string;
      founder: 'ivy' | 'james' | null; occurredAt: string }[] }): Promise<{
    observations: readonly PerspectiveObservation[]; alignmentProposals: readonly AlignmentProposal[];
  }>;
}
export interface FounderStreamRoute { ingest(envelope: unknown): Record<string, unknown> | null }
export interface FounderStreamOptions {
  client: Database.Database; jobRepository: JobRepository; flags: Omit<AppConfig['founderStream'],'manualQueryEnabled'|'dailyReconciliationEnabled'|'reconciliationBootstrapSince'|'whiteboardEnabled'> &
    {manualQueryEnabled?:boolean;dailyReconciliationEnabled?:boolean};
  approvedChatIds: readonly string[]; ivyPrivateChatId: string; analyzer?: FounderStreamAnalyzer;
  classifier?: { classify(analysis: Awaited<ReturnType<FounderStreamAnalyzer['analyze']>>): Promise<FounderWorkMapClassification> };
  attachmentReader?: { read(input:{messageId:string;fileKey:string;fileName:string}):Promise<{body:Buffer;mimeType:string}> };
  perspectiveAnalyzer?: FounderPerspectiveAnalysisPort;
  now?: () => Date; intervalMs?: number;
  /** Admits space_page_snapshot/space_page_comment batches scoped by projectKey, independent of captureEnabled/approvedChatIds. */
  spaceAnalysisEnabled?: boolean;
  policy?: Pick<AlignmentNotificationPolicy, 'reconcilePending'>;
  dailyReconciliation?:{bootstrapSince:string;run(input:{since:string;until:string;now:Date}):Promise<unknown>};
  whiteboardPublisher?:{publish(input:{title:string;chatId:string;cards:readonly Record<string,unknown>[];
    previousPaletteId?:string|null;view?:FounderBoardView}):Promise<FounderWhiteboardArtifact>};
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
  if (options.flags.manualQueryEnabled && (!options.flags.captureEnabled || !options.flags.analysisEnabled)) throw new Error('manual query requires capture and analysis');
  if (options.flags.dailyReconciliationEnabled && !options.dailyReconciliation) throw new Error('daily reconciliation runner is required');
  const now = options.now ?? (() => new Date());
  const sources = new ContextSourceRepository(options.client), topics = new TopicRepository(options.client);
  const spaceSync = new SpaceSyncRepository(options.client);
  const outbox = new OutboxRepository(options.client);
  const perspectives = new AlignmentRepository(options.client);
  const perspectiveReconciler = new PerspectiveReconciler(perspectives);
  const notificationPolicy = new AlignmentNotificationPolicy(new AlignmentIssueRepository(options.client), perspectives, outbox);
  const policy = options.policy ?? new AlignmentNotificationPolicy(new AlignmentIssueRepository(options.client), new AlignmentRepository(options.client), outbox);
  const dayMs=24*60*60*1_000;
  const latestAudit=latestDailyCoverageAttemptAt(options.client,approvedGroup);
  let nextDailyReconciliationAt=latestAudit===undefined?now().getTime():latestAudit+dayMs;
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
      const manualQuery=text?parseFounderManualQuery(text):null;
      if(manualQuery){
        if(!options.flags.manualQueryEnabled)return{status:'ignored',reason:'manual_query_disabled'};
        const openId=event.sender.sender_id.open_id??'';
        if(event.sender.sender_type!=='user'||!isConfiguredFounder(options.client,openId))return{status:'rejected',reason:'founder_identity_required'};
        const messages=buildFounderManualQueryMessages({client:options.client,query:manualQuery,queryMessageId:message.message_id,
          chatId,approvedChatIds:options.approvedChatIds,now:stamp});
        enqueueFounderManualQuery(options.client,messages,stamp);
        options.client.prepare('INSERT INTO founder_stream_events(event_id,message_id,chat_id,disposition,received_at) VALUES(?,?,?,?,?)')
          .run(header.event_id,message.message_id,chatId,'feedback',stamp.toISOString());
        return{status:'manual_query_queued',pages:messages.length};
      }
      const attachment=message.message_type==='file'?fileAttachment(message.content):null;
      const attachmentQueued=event.sender.sender_type==='user'&&Boolean(attachment&&options.attachmentReader);
      let disposition = event.sender.sender_type !== 'user' ? 'bot_audit' : !text ? 'skipped_media' : 'captured';
      let decision: ReturnType<typeof routeFounderFeedback> | undefined;
      if (disposition === 'skipped_media') {
        const captured = captureGroupMessageSource({ chatId, messageId: message.message_id, threadId: message.thread_id || null,
          rootId: message.root_id || null, author: { openId: event.sender.sender_id.open_id ?? null, displayName: null },
          messageType: message.message_type, senderType: 'user', text: '', occurredAt: at }, stamp);
        const gapCode = liveGapCode(message.message_type);
        const source = sources.saveSource({ ...captured.source, availabilityStatus: 'unknown',
          metadata: { ...captured.source.metadata, gapCode } }).source;
        if(!attachmentQueued)sources.saveSource({ ...captured.source, sourceType: 'feishu_sync_gap',
          logicalKey: `${captured.source.logicalKey}:gap:${gapCode}`, contentFormat: 'application/json',
          contentText: JSON.stringify({ code: gapCode, sourceRef: source.logicalKey,
            reason: 'No reliable text available; media was not downloaded or analyzed.' }),
          metadata: { chatId, messageId: message.message_id, sourceId: source.id, messageType: message.message_type } });
        else options.jobRepository.enqueueFounderAttachment({messageId:message.message_id,chatId,fileKey:attachment!.fileKey,
          fileName:attachment!.fileName,threadId:message.thread_id||message.root_id||null,occurredAt:at,
          authorOpenId:event.sender.sender_id.open_id??null,capturedAt:stamp});
      }
      if (disposition === 'captured') {
        const replyTo = message.parent_id || message.root_id || null;
        const correctionLike = /^(?:第\s*\d+\s*项(?:改|只是|拆)|\d+\s*(?:和|与)\s*\d+\s*是同一个|这个(?:只是想法|改名为|改为|拆分为)|暂停\s*\d+\s*项|确认修正\s+feedbackdraft_[a-f0-9]{32})/u.test(text!);
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
      return decision ? { status: 'founder_feedback_decision', decision } : { status: attachmentQueued?'attachment_queued':disposition };
    }).immediate();
  } };
  async function process(job: FounderDurableJob) {
    let failureStage: FounderFailureStage = 'input';
    try {
      if (job.kind === 'analyze_founder_stream_space_batch') {
        if (!spaceSync.getBindingByProjectKey(job.projectKey)) throw new Error('unregistered space project');
        if (job.sourceIds.length > 20) {
          options.client.transaction(() => {
            const stamp=now();if(!options.jobRepository.ownsLease(job,stamp))throw new LeaseLostError(job.key);
            const ordered=job.sourceIds.slice().sort((a,b)=>(sources.getSource(a)?.occurredAt??a).localeCompare(sources.getSource(b)?.occurredAt??b));
            for(let offset=0;offset<ordered.length;offset+=20) options.jobRepository.enqueueSpaceStreamBatch({
              projectKey:job.projectKey,since:stamp.toISOString(),until:stamp.toISOString(),sourceIds:ordered.slice(offset,offset+20),capturedAt:stamp });
            options.jobRepository.markCompleted(job,stamp);
          }).immediate();
          return 'completed' as const;
        }
        // Space pages are periodically published snapshots of work done elsewhere. They
        // refine a project card a human already mapped; they never extract, create,
        // rename or restage topics — see docs/2026-10-19-space-to-context-sync-cloud-code-handoff.md §8.2.
        const target = confirmedSpaceProjectTopic(options.client, topics, job.projectKey);
        if (!target) throw new Error('SPACE_PROJECT_TOPIC_UNCONFIRMED');
        const loaded = loadSpaceBatchSources(sources, spaceSync, job.sourceIds, job.projectKey);
        const plannedAt = now();
        failureStage = 'new_evidence_persistence';
        const commentEvidenceIds = loaded.comments.flatMap(comment => {
          const excerpt = spaceCommentExcerpt(comment);
          return excerpt ? [saveFounderEvidence(sources, comment.id, excerpt, plannedAt)] : [];
        });
        failureStage = 'persistence';
        options.client.transaction(() => {
          const stamp = now(); if (!options.jobRepository.ownsLease(job, stamp)) throw new LeaseLostError(job.key);
          const current = topics.listCurrentTopics().find(t => t.id === target.id);
          if (!current) throw new Error('SPACE_PROJECT_TOPIC_UNCONFIRMED');
          const added = commentEvidenceIds.filter(id => !current.evidenceIds.includes(id));
          if (added.length) topics.appendVersion({ topicId: current.id, expectedVersion: current.currentVersion,
            displayName: current.displayName, stage: current.stage, outcome: current.outcome,
            evidenceIds: [...new Set([...current.evidenceIds, ...added])].sort(),
            rationale: JSON.stringify({ origin: 'space_sync', jobKey: job.key, projectKey: job.projectKey }), changedAt: stamp });
          options.jobRepository.markCompleted(job, stamp);
        }).immediate();
        return 'completed' as const;
      }
      if (!allowed(job.chatId)) throw new Error('unapproved founder group');
      if(job.kind==='capture_founder_attachment'){
        if(!options.attachmentReader)throw new Error('founder attachment reader unavailable');
        const resource=await options.attachmentReader.read({messageId:job.messageId,fileKey:job.fileKey,fileName:job.fileName});
        let text:string;
        try{text=await parseFeishuAttachment(resource.body,resource.mimeType,job.fileName,{maxBytes:80*1024*1024,maxChars:180_000});}
        catch(error){
          const reason=error instanceof Error?error.message:'ATTACHMENT_PARSE_FAILED';
          if(!reason.startsWith('ATTACHMENT_'))throw error;
          options.client.transaction(()=>{
            const stamp=now();if(!options.jobRepository.ownsLease(job,stamp))throw new LeaseLostError(job.key);
            saveAttachmentGap(sources,job,reason,stamp);options.jobRepository.markCompleted(job,stamp);
          }).immediate();return 'completed' as const;
        }
        if(!text.trim())throw new Error('ATTACHMENT_TEXT_UNAVAILABLE');
        options.client.transaction(()=>{
          const stamp=now();if(!options.jobRepository.ownsLease(job,stamp))throw new LeaseLostError(job.key);
          const captured=captureGroupMessageSource({chatId:job.chatId,messageId:`${job.messageId}:file`,threadId:job.threadId,rootId:null,
            author:{openId:job.authorOpenId,displayName:null},messageType:'file',senderType:'user',text,occurredAt:job.occurredAt},stamp);
          captured.source.externalId=`${job.messageId}:file`;captured.source.logicalKey=`feishu:chat:${job.chatId}:message:${job.messageId}:file`;
          captured.source.metadata={...captured.source.metadata,sourceMessageId:job.messageId,
            attachmentTitle:job.fileName,mimeType:resource.mimeType};
          captured.source.rawTextExpiresAt=new Date(stamp.getTime()+90*24*60*60_000);
          const source=sources.saveSource(captured.source).source;
          options.jobRepository.enqueueGroupCapture({messageId:`${job.messageId}:file`,chatId:job.chatId,sourceIds:[source.id],threadId:job.threadId,capturedAt:stamp});
          options.jobRepository.markCompleted(job,stamp);
        }).immediate();
      } else if (job.kind === 'capture_group_message') {
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
        failureStage = 'topic_analysis';
        const analysis = input.sources.length ? await options.analyzer.analyze(input) : { topics: [] };
        failureStage = 'semantic_classification';
        const classified = options.classifier ? projectFounderWorkMap(analysis, await options.classifier.classify(analysis))
          : { analysis, supportingByDisplayName: {} as Record<string, never[]>, canonicalNames: {} as Record<string,string> };
        failureStage = 'topic_reconciliation';
        const plan = reconcileTopics(input, classified.analysis);
        const exactCanonicalNames = new Map<number, string>();
        const canonicalByName = new Map<string, ReturnType<TopicRepository['listCanonicalTopics']>>();
        for(const topic of topics.listCanonicalTopics()){
          const key=normalizeTopicName(topic.displayName),matches=canonicalByName.get(key)??[];matches.push(topic);canonicalByName.set(key,matches);
        }
        const mediaLine=canonicalByName.get(normalizeTopicName('自媒体生产线'))?.find(topic=>topic.stage!=='closed');
        const ambiguousProposalIndexes=new Set<number>();
        for (const item of plan.topics) {
          if (item.action !== 'create') continue;
          const candidateNames=[item.proposal.displayName,classified.canonicalNames[item.proposal.displayName]].filter((value):value is string=>Boolean(value));
          const candidates=[...new Map(candidateNames.flatMap(name=>canonicalByName.get(normalizeTopicName(name))??[])
            .filter(topic=>item.proposal.stage==='closed'?topic.stage==='closed':topic.stage!=='closed').map(topic=>[topic.id,topic])).values()];
          if (candidates.length>1){ambiguousProposalIndexes.add(item.proposalIndex);continue}
          if (candidates.length===0) continue;
          const exact=candidates[0]!;
          item.action = 'join';
          item.topicId = exact.id;
          item.expectedVersion = exact.currentVersion;
          exactCanonicalNames.set(item.proposalIndex, exact.displayName);
        }
        const plannedTopics=plan.topics.filter(item=>!ambiguousProposalIndexes.has(item.proposalIndex));
        failureStage = 'evidence_preparation';
        // The model can suggest a continuation, but it cannot revoke a founder's
        // accepted correction. Bind its evidence to the protected topic instead
        // of creating a renamed/reactivated duplicate.
        for (const item of plannedTopics) {
          const target = topics.listCurrentTopics().find(t => t.id === item.proposal.joinDecision.topicId);
          if (target && topicAuthority(options.client, topics, target)) {
            item.action = 'join'; item.topicId = target.id; item.expectedVersion = target.currentVersion;
          }
        }
        const plannedAt = now();
        failureStage = 'new_evidence_persistence';
        const prepared = plannedTopics.map(item => ({ item,
          topicId: item.topicId ?? stableId('topic', `${new Date(plannedAt.getTime()+item.proposalIndex).toISOString()}\n${item.proposal.displayName.trim()}`),
          ids: item.proposal.evidenceExcerpts.map(e => saveFounderEvidence(sources,e.sourceId,e.excerpt,plannedAt)) }));
        const byTopic = new Map<string, typeof prepared>();
        for(const row of prepared) byTopic.set(row.topicId,[...(byTopic.get(row.topicId) ?? []),row]);
        const scopedEvidence = new Map<string, { id:string;sourceId:string;topicIds:string[];excerpt:string;
          founder:'ivy'|'james'|null;occurredAt:string }>();
        for (const row of prepared) {
          // Historical perspectives already live in the immutable repository.
          // Re-analyzing inherited evidence creates duplicate observations and lets
          // legacy locators block an otherwise valid new batch.
          for(const id of row.ids) {
            failureStage = 'evidence_record_loading';
            const evidence=sources.getEvidence(id);if(!evidence)throw new Error('FOUNDER_EXISTING_EVIDENCE_MISSING');
            const existing=scopedEvidence.get(id);
            if(existing) { if(!existing.topicIds.includes(row.topicId)) existing.topicIds.push(row.topicId); }
            else {
              failureStage = 'founder_attribution';
              const founder=perspectives.resolveFounderForEvidence(id);
              failureStage = 'source_occurrence_lookup';
              const source=sources.getSource(evidence.sourceId);if(!source)throw new Error('FOUNDER_SOURCE_UNAVAILABLE');
              scopedEvidence.set(id,{id,sourceId:evidence.sourceId,topicIds:[row.topicId],excerpt:evidence.excerpt,
                founder,occurredAt:source.occurredAt});
            }
          }
        }
        failureStage = 'perspective_analysis';
        const perspectiveResult = options.perspectiveAnalyzer && prepared.length ? await options.perspectiveAnalyzer.analyze({
          sourceIds:input.sources.map(s=>s.id),topicIds:[...byTopic.keys()].sort(),evidence:[...scopedEvidence.values()]
        }) : { observations:[],alignmentProposals:[] };
        const assertScoped = (topicId:string,evidenceIds:readonly string[]) => {
          if(!prepared.some(p=>p.topicId===topicId) || evidenceIds.some(id=>!scopedEvidence.get(id)?.topicIds.includes(topicId)))
            throw new Error('FOUNDER_PERSPECTIVE_OUT_OF_SCOPE');
        };
        failureStage = 'persistence';
        options.client.transaction(() => {
          const stamp = now(); if (!options.jobRepository.ownsLease(job, stamp)) throw new LeaseLostError(job.key);
          // One CAS/version per target. Several validated suggestions can point
          // to the same human-protected topic; none may overwrite or drop another.
          for (const [,rows] of [...byTopic.entries()].sort(([a],[b])=>a.localeCompare(b))) {
            const {item}=rows[0]!;
            const old = item.topicId ? topics.listCurrentTopics().find(t => t.id === item.topicId) : undefined;
            const evidenceIds = [...new Set([...(old?.evidenceIds ?? []), ...rows.flatMap(row=>row.ids)])].sort();
            const authority = old ? topicAuthority(options.client, topics, old) : null;
            const suggestions = authority ? stableUnique(rows.map(row=>({status:'needs_confirmation',
              displayName:row.item.proposal.displayName,stage:row.item.proposal.stage,outcome:row.item.proposal.outcome,
              currentAction:row.item.proposal.currentAction,evidenceIds:[...new Set(row.ids)].sort(),
              evidenceAfterCorrection:row.item.proposal.evidenceExcerpts.every(e=>Date.parse(sources.getSource(e.sourceId)!.occurredAt)>Date.parse(authority.occurredAt))}))) : [];
            const rationale = JSON.stringify({ origin: 'founder_stream', jobKey: job.key,
              canonicalName: classified.canonicalNames[item.proposal.displayName] ?? null,
              supportingItems: classified.supportingByDisplayName[item.proposal.displayName] ?? [],
              needsConfirmation: stableUnique(rows.flatMap(row=>row.item.relations)),
              ...(authority ? { humanAuthority: { correctionId: authority.correctionId, evidenceId: authority.evidenceId,
                occurredAt: authority.occurredAt }, suggestions,
                ...(suggestions.length===1?{suggestion:suggestions[0]}:{}) } : {}) });
            if (item.action === 'join') topics.appendVersion({ topicId: item.topicId!, expectedVersion: item.expectedVersion!,
              displayName: authority?.snapshot.displayName ?? exactCanonicalNames.get(item.proposalIndex) ?? item.proposal.displayName,
              stage: authority?.snapshot.stage ?? item.proposal.stage,
              outcome: authority ? authority.snapshot.outcome : item.proposal.outcome,
              evidenceIds, rationale, changedAt: stamp });
            else topics.createTopic({ displayName: item.proposal.displayName, stage: item.proposal.stage, outcome: item.proposal.outcome,
              evidenceIds, rationale, createdAt: new Date(plannedAt.getTime() + item.proposalIndex) });
          }
          if(mediaLine)for(const [topicId,rows] of byTopic){
            if(topicId!==mediaLine.id&&rows.some(row=>row.item.action==='create'&&isSelfMediaProposal(row.item.proposal)))
              topics.addRelation({fromTopicId:topicId,toTopicId:mediaLine.id,relationType:'part_of',
                rationale:'Ivy confirmed self-media materials belong to the B-line production stream',createdAt:stamp});
          }
          for(const observation of perspectiveResult.observations) {
            assertScoped(observation.topicId,[observation.evidenceId]);
          }
          perspectiveReconciler.reconcileBatch(perspectiveResult.observations);
          for(const proposal of perspectiveResult.alignmentProposals) {
            const candidate=new AlignmentDetector().propose(proposal);
            assertScoped(candidate.topicId,candidate.evidenceIds);
            const card=renderAlignmentQuestion({issue:{...candidate,status:'ready',createdAt:stamp.toISOString(),updatedAt:stamp.toISOString(),deliveredMessageId:null},
              topicName:prepared.find(p=>p.topicId===candidate.topicId)!.item.proposal.displayName,
              evidence:candidate.evidenceIds.map(id=>{
                const e=sources.getEvidence(id)!,s=sources.getSource(e.sourceId)!;
                return {...e,occurredAt:s.occurredAt,...(s.sourceType==='minute_transcript'?{minuteToken:s.externalId}:{})};
              })});
            if (options.flags.groupDeliveryEnabled) {
              notificationPolicy.prepare(candidate,{targetChatId:job.chatId,card:card.card},stamp);
            } else {
              notificationPolicy.recordShadowCandidate(candidate,stamp);
            }
          }
          policy.reconcilePending(stamp);
          options.jobRepository.markCompleted(job, stamp);
        }).immediate();
      }
      return 'completed' as const;
    } catch (error) {
      if (error instanceof LeaseLostError) return 'lost_lease' as const;
      if(job.kind==='capture_founder_attachment'&&job.attempt>=2){
        try{options.client.transaction(()=>{const stamp=now();if(!options.jobRepository.ownsLease(job,stamp))throw new LeaseLostError(job.key);
          saveAttachmentGap(sources,job,'ATTACHMENT_READ_FAILED',stamp);options.jobRepository.markCompleted(job,stamp)}).immediate();return 'completed' as const;}
        catch(failure){if(failure instanceof LeaseLostError)return 'lost_lease' as const;throw failure}
      }
      try { options.jobRepository.retryFounderStream(job, now(), { stage: failureStage, code: classifyFounderFailure(error) }); } catch (failure) {
        if (failure instanceof LeaseLostError) return 'lost_lease' as const; throw failure;
      }
      return 'retry' as const;
    }
  }
  const supportedKinds: FounderDurableJob['kind'][] = [
    ...(!options.flags.captureEnabled ? [] : options.flags.analysisEnabled ?
      ['capture_group_message','capture_founder_attachment','analyze_founder_stream_batch'] as const : ['capture_group_message','capture_founder_attachment'] as const),
    ...(options.spaceAnalysisEnabled ? ['analyze_founder_stream_space_batch'] as const : [])
  ];
  const afterTick = async () => {
      if(options.flags.dailyReconciliationEnabled&&options.dailyReconciliation&&now().getTime()>=nextDailyReconciliationAt){
        const stamp=now();nextDailyReconciliationAt=stamp.getTime()+dayMs;
        const since=latestCompleteDailyCoverageUntil(options.client,approvedGroup)??options.dailyReconciliation.bootstrapSince;
        try{if(Date.parse(since)<stamp.getTime())await options.dailyReconciliation.run({since,until:stamp.toISOString(),now:stamp})}
        catch{/* A failed daily audit waits until the next daily window; history reads persist their own safe gaps. */}
      }
      // Independent of Feishu's captureEnabled/analysisEnabled — Space sync has its own gate.
      if (options.spaceAnalysisEnabled) recoverSpaceAnalysis();
      if (!options.flags.analysisEnabled) return;
      if (allowed(approvedGroup)) recoverGroupAnalysis();
      // The immutable source survives an enqueue failure. Stable source-set keys
      // allow a later tick/restart to repair just the downstream handoff.
      if (allowed(approvedGroup)) for(const source of sources.listSources().filter(s=>s.sourceType==='minute_transcript' && s.availabilityStatus==='available' && minuteEligible(s,approvedGroup))) {
        try { enqueueMinute(source); } catch { /* Retry on the next independent tick. */ }
      }
      policy.reconcilePending(now());
      if (!options.delivery) return;
      if (options.flags.groupDeliveryEnabled) await deliverFounderMessages(options, outbox, policy, now, allowed);
      if (!options.flags.manualQueryEnabled) await deliverFounderFeedbackMessages(options,now,allowed);
  };
  const consumer = new DurableJobConsumer({ now, intervalMs: options.intervalMs,
    leaseNext: at => options.jobRepository.leaseNextSupportedJob(at,supportedKinds),
    process: job => process(job as FounderDurableJob), afterTick
  });
  const manualQueryConsumer = new DurableJobConsumer({ now, intervalMs: options.intervalMs,
    leaseNext: () => null, process: async () => 'completed',
    afterTick: async () => { if(options.flags.manualQueryEnabled&&options.delivery){
      await deliverManualQueryMessages(options,now,allowed);
      await deliverFounderFeedbackMessages(options,now,allowed);
    } }
  });
  function enqueueMinute(source: ContextSourceRecord) {
    return options.jobRepository.enqueueFounderStreamBatch({chatId:approvedGroup,sourceIds:[source.id],since:source.occurredAt,until:now().toISOString(),capturedAt:now()});
  }
  function recoverGroupAnalysis() {
    // Durable job membership is the downstream receipt, including terminal
    // failures (operator retry, never an unbounded auto-requeue). A pending
    // capture owns its handoff and debounce deadline until it completes.
    options.client.transaction(() => {
      const claimed = new Set<string>();
      const rows = options.client.prepare("SELECT type,status,payload FROM batch_jobs WHERE type IN ('capture_group_message','analyze_founder_stream_batch')")
        .all() as { type:string;status:string;payload:string }[];
      for (const row of rows) {
        try {
          const payload = JSON.parse(row.payload);
          if (payload.chatId !== approvedGroup || !Array.isArray(payload.sourceIds)) continue;
          if (row.type === 'analyze_founder_stream_batch' || row.status !== 'completed')
            for (const id of payload.sourceIds) if (typeof id === 'string') claimed.add(id);
        } catch { /* Invalid jobs remain diagnostic failures, not source authority. */ }
      }
      const stamp = now();
      const groupSources = sources.listSources().filter(source => source.sourceType === 'group_message' &&
        source.contentState === 'cleartext' && source.metadata.chatId === approvedGroup &&
        source.metadata.senderType === 'user');
      const threadOf = (source:ContextSourceRecord) => String(source.metadata.threadId || source.metadata.rootId || '');
      const latestArrival = new Map<string,number>();
      for(const source of groupSources) latestArrival.set(threadOf(source),Math.max(latestArrival.get(threadOf(source))??0,Date.parse(source.capturedAt)));
      const pending = groupSources.filter(source =>
        source.availabilityStatus === 'available' && source.metadata.chatId === approvedGroup &&
        source.metadata.senderType === 'user' && source.contentText.trim() && !claimed.has(source.id) &&
        latestArrival.get(threadOf(source))! + 300_000 <= stamp.getTime() &&
        !options.client.prepare("SELECT 1 FROM outbox WHERE delivered_message_id=? AND status='delivered'").get(source.externalId) &&
        !options.client.prepare('SELECT 1 FROM founder_feedback_corrections WHERE chat_id=? AND source_message_id=?').get(approvedGroup,source.externalId))
        .sort((a,b)=>a.occurredAt.localeCompare(b.occurredAt)||a.id.localeCompare(b.id));
      for (const thread of new Set(pending.map(threadOf))) {
        const threadSources=pending.filter(s=>threadOf(s)===thread);
        for(let offset=0;offset<threadSources.length;offset+=20){
          const batch=threadSources.slice(offset,offset+20);
          options.jobRepository.enqueueFounderStreamBatch({chatId:approvedGroup,sourceIds:batch.map(s=>s.id),
            since:batch[0]!.occurredAt,until:stamp.toISOString(),capturedAt:stamp,recoveryThreadId:thread||null});
        }
      }
    }).immediate();
  }
  /** Mirrors recoverGroupAnalysis, scoped by projectKey (via project_space_bindings) instead of chatId. */
  function recoverSpaceAnalysis() {
    options.client.transaction(() => {
      const claimed = new Set<string>();
      const rows = options.client.prepare("SELECT payload FROM batch_jobs WHERE type='analyze_founder_stream_space_batch'")
        .all() as { payload: string }[];
      for (const row of rows) {
        try {
          const payload = JSON.parse(row.payload);
          if (!Array.isArray(payload.sourceIds)) continue;
          for (const id of payload.sourceIds) if (typeof id === 'string') claimed.add(id);
        } catch { /* Invalid jobs remain diagnostic failures, not source authority. */ }
      }
      const stamp = now();
      const spaceSources = sources.listSources().filter(source =>
        ['space_page_snapshot','space_page_comment'].includes(source.sourceType) &&
        source.contentState === 'cleartext' && source.availabilityStatus === 'available' &&
        typeof source.metadata.pageId === 'string' && !claimed.has(source.id));
      const projectKeyByPageId = new Map<string,string|null>();
      const projectKeyFor = (pageId: string): string | null => {
        if (!projectKeyByPageId.has(pageId)) projectKeyByPageId.set(pageId, spaceSync.getBindingByPageId(pageId)?.projectKey ?? null);
        return projectKeyByPageId.get(pageId)!;
      };
      const byProject = new Map<string, ContextSourceRecord[]>();
      for (const source of spaceSources) {
        const projectKey = projectKeyFor(source.metadata.pageId as string);
        // Unmapped projects stay unclaimed, so registering the mapping later picks them up.
        if (!projectKey || !confirmedSpaceProjectTopic(options.client, topics, projectKey)) continue;
        byProject.set(projectKey, [...(byProject.get(projectKey) ?? []), source]);
      }
      for (const [projectKey, projectSources] of byProject) {
        const ordered = projectSources.slice().sort((a,b)=>a.occurredAt.localeCompare(b.occurredAt)||a.id.localeCompare(b.id));
        for (let offset=0; offset<ordered.length; offset+=20) {
          const batch = ordered.slice(offset, offset+20);
          options.jobRepository.enqueueSpaceStreamBatch({ projectKey, since: batch[0]!.occurredAt, until: stamp.toISOString(),
            sourceIds: batch.map(s=>s.id), capturedAt: stamp });
        }
      }
    }).immediate();
  }
  function captureMinute(context: MinuteContext) {
    if(!options.flags.captureEnabled || !allowed(approvedGroup))return;
    const source=sources.saveSource(captureMinuteTranscriptSource(context,now(),{maxBytes:200_000,maxSegments:10_000},approvedGroup).source).source;
    if(options.flags.analysisEnabled && minuteEligible(source,approvedGroup))enqueueMinute(source);
  }
  return { route, process, afterTick, captureMinute,
    minuteCaptureChatId:options.flags.captureEnabled && allowed(approvedGroup)?approvedGroup:undefined,
    supportedKinds, runOnce: () => consumer.runOnce(), runManualQueriesOnce:()=>manualQueryConsumer.runOnce(),
    startManualQueries:()=>{if(options.flags.manualQueryEnabled&&options.delivery)manualQueryConsumer.start()},
    stopManualQueries:()=>manualQueryConsumer.stop(),
    start: () => { if (options.flags.captureEnabled) consumer.start(); if(options.flags.manualQueryEnabled&&options.delivery)manualQueryConsumer.start(); },
    stop: async () => {await Promise.all([consumer.stop(),manualQueryConsumer.stop()]);},
    isConsumptionAvailable: () => consumer.isConsumptionAvailable() };
}
async function deliverManualQueryMessages(options:FounderStreamOptions,now:()=>Date,allowed:(id:string)=>boolean){
  const rows=options.client.prepare(`SELECT idempotency_key,payload FROM outbox WHERE status='pending'
    AND (next_attempt_at IS NULL OR next_attempt_at<=?) ORDER BY created_at,id`).all(now().toISOString()) as {idempotency_key:string;payload:string}[];
  const artifacts=new Map<string,FounderWhiteboardArtifact>();
  const failures=new Map<string,{code:'FOUNDER_WHITEBOARD_PUBLISH_FAILED';at:string}>();
  for(const row of rows){
    let message:any;try{message=JSON.parse(row.payload)}catch{continue}
    const manual=message?.kind==='founder_manual_query'||(message?.kind==='founder_work_map'&&typeof message.manualQueryMessageId==='string');
    if(!manual||!allowed(message.targetChatId)||!message.card)continue;
    const queryMessageId=message.kind==='founder_manual_query'?message.queryMessageId:message.manualQueryMessageId;
    const knownFailure=failures.get(queryMessageId);
    if(knownFailure){message.boardFailure=knownFailure;message.card=withWhiteboardFailure(message.card)}
    if(options.whiteboardPublisher&&!message.boardArtifact&&!message.boardFailure){
      try{
        let artifact=artifacts.get(queryMessageId);
        if(!artifact){
          const grouped=rows.flatMap(candidate=>{try{const value=JSON.parse(candidate.payload);const id=value.kind==='founder_manual_query'?
            value.queryMessageId:value.manualQueryMessageId;return id===queryMessageId&&value.card?[value]:[]}catch{return[]}});
          const previous=options.client.prepare(`SELECT payload FROM outbox WHERE status='delivered' AND json_valid(payload)
            AND json_extract(payload,'$.boardArtifact.paletteId') IS NOT NULL ORDER BY delivered_at DESC LIMIT 1`).get() as {payload:string}|undefined;
          const previousPaletteId=previous?JSON.parse(previous.payload).boardArtifact?.paletteId:null;
          const view=grouped.find(value=>value.boardView)?.boardView as FounderBoardView|undefined;
          artifact=await options.whiteboardPublisher.publish({title:manualQueryTitle(grouped[0]?.card),chatId:message.targetChatId,
            cards:grouped.map(value=>value.card),previousPaletteId,...(view?{view}:{})});artifacts.set(queryMessageId,artifact);
          const update=options.client.prepare("UPDATE outbox SET payload=? WHERE idempotency_key=? AND status='pending'");
          for(const candidate of rows){try{const value=JSON.parse(candidate.payload);const id=value.kind==='founder_manual_query'?
            value.queryMessageId:value.manualQueryMessageId;if(id===queryMessageId){value.boardArtifact=artifact;value.card=withWhiteboardLink(value.card,artifact,value.page===1);
              update.run(JSON.stringify(value),candidate.idempotency_key)}}catch{/* An invalid unrelated row remains untouched. */}}
        }
        message.boardArtifact=artifact;message.card=withWhiteboardLink(message.card,artifact,message.page===1);
      }catch(error){
        const failure={code:'FOUNDER_WHITEBOARD_PUBLISH_FAILED' as const,at:now().toISOString()};failures.set(queryMessageId,failure);
        const previewImageKey=error instanceof FounderWhiteboardPublishError?error.previewImageKey.trim():'';
        const update=options.client.prepare("UPDATE outbox SET payload=? WHERE idempotency_key=? AND status='pending'");
        for(const candidate of rows){try{const value=JSON.parse(candidate.payload);const id=value.kind==='founder_manual_query'?
          value.queryMessageId:value.manualQueryMessageId;if(id===queryMessageId){value.boardFailure=failure;
            value.card=previewImageKey?withWhiteboardPreviewOnly(value.card,previewImageKey,value.page===1):withWhiteboardFailure(value.card);
            update.run(JSON.stringify(value),candidate.idempotency_key)}}catch{/* Invalid rows are untouched. */}}
        message.boardFailure=failure;message.card=previewImageKey?
          withWhiteboardPreviewOnly(message.card,previewImageKey,message.page===1):withWhiteboardFailure(message.card);
      }
    }
    try{
      const sent=await options.delivery!.sendInteractiveCard({chatId:message.targetChatId,card:message.card,idempotencyKey:row.idempotency_key});
      if(!sent.messageId.trim()||sent.messageId.startsWith('pending:'))throw new Error('invalid delivery');
      options.client.prepare("UPDATE outbox SET status='delivered',delivered_message_id=?,delivered_at=?,next_attempt_at=NULL,last_error_code=NULL WHERE idempotency_key=? AND status='pending'")
        .run(sent.messageId,now().toISOString(),row.idempotency_key);
    }catch{options.client.prepare("UPDATE outbox SET attempt_count=attempt_count+1,next_attempt_at=?,last_error_code='FOUNDER_DELIVERY_FAILED' WHERE idempotency_key=? AND status='pending'")
      .run(new Date(now().getTime()+30_000).toISOString(),row.idempotency_key)}
  }
}

function manualQueryTitle(card:Record<string,unknown>|undefined):string{
  const content=(card?.header as {title?:{content?:unknown}}|undefined)?.title?.content;
  return typeof content==='string'&&content.trim()?content.replace(/\s*·\s*\d+\/\d+\s*$/u,'').trim():'AiJia 工作看板';
}
function withWhiteboardLink(card:Record<string,unknown>,artifact:FounderWhiteboardArtifact,showPreview:boolean):Record<string,unknown>{
  const elements=Array.isArray(card.elements)?[...card.elements]:[];
  const paletteName=founderPalettes.find(palette=>palette.id===artifact.paletteId)?.name??artifact.paletteId;
  const visible=elements.filter(element=>{
    const candidate=element as {actions?:{url?:unknown}[];text?:{content?:unknown};img_key?:unknown};
    return !candidate.actions?.some(action=>action.url===artifact.url)&&
      candidate.img_key!==artifact.previewImageKey&&
      !(typeof candidate.text?.content==='string'&&candidate.text.content.startsWith('**可编辑看板已生成**'));
  });
  const previewImageKey=typeof artifact.previewImageKey==='string'?artifact.previewImageKey.trim():'';
  return{...card,elements:[
    ...(showPreview&&previewImageKey?[{tag:'img',img_key:previewImageKey,alt:{tag:'plain_text',content:'工作地图风格化总览'},mode:'fit_horizontal'}]:[]),
    {tag:'div',text:{tag:'lark_md',content:`**可编辑看板已生成**\n当前查询的完整内容已同步到飞书白板；配色：${paletteName}。`}},
    {tag:'action',actions:[{tag:'button',type:'default',text:{tag:'plain_text',content:'打开可编辑白板'},url:artifact.url}]},
    ...visible
  ]};
}
function withWhiteboardFailure(card:Record<string,unknown>):Record<string,unknown>{
  const elements=Array.isArray(card.elements)?[...card.elements]:[];
  if(!elements.some(element=>(element as {text?:{content?:unknown}})?.text?.content==='看板生成失败，已返回完整文本；请稍后重新查询。'))elements.push({
    tag:'note',elements:[{tag:'plain_text',content:'看板生成失败，已返回完整文本；请稍后重新查询。'}]
  });
  return{...card,elements};
}
function withWhiteboardPreviewOnly(card:Record<string,unknown>,previewImageKey:string,showPreview:boolean):Record<string,unknown>{
  const elements=Array.isArray(card.elements)?[...card.elements]:[];
  return{...card,elements:[
    ...(showPreview?[{tag:'img',img_key:previewImageKey,alt:{tag:'plain_text',content:'工作地图风格化总览'},mode:'fit_horizontal'}]:[]),
    {tag:'note',elements:[{tag:'plain_text',content:'群内总览已生成；可编辑白板暂不可用。'}]},
    ...elements
  ]};
}

export function buildFounderStreamInput(sources: ContextSourceRepository, topics: TopicRepository, sourceIds: readonly string[], chatId: string): FounderStreamInput {
  const selected = new Map<string, ContextSourceRecord>();
  const trustedSource = (id: string) => {
    const source = sources.getSource(id);
    if (!source || source.contentState !== 'cleartext' || source.availabilityStatus !== 'available' ||
      !['group_message','minute_transcript'].includes(source.sourceType) ||
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
    if(source.contentState !== 'cleartext')throw new Error('FOUNDER_SOURCE_UNAVAILABLE');
    if(source.sourceType==='group_message' && (source.metadata.senderType!=='user' ||
      sources.client.prepare("SELECT 1 FROM outbox WHERE delivered_message_id=? AND status='delivered'").get(source.externalId))) continue;
    if(!include(id))throw new Error('FOUNDER_SOURCE_UNAVAILABLE');
  }
  if(selected.size===0)return {sources:[],currentTopics:[]};
  const currentTopics: FounderStreamCurrentTopic[] = [];
  for (const topic of topics.listCanonicalTopics().slice(-200)) {
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
function stableUnique<T>(values:readonly T[]):T[] {
  return [...new Map(values.map(value=>[canonicalJson(value),value])).entries()]
    .sort(([a],[b])=>a.localeCompare(b)).map(([,value])=>value);
}
function topicAuthority(client: Database.Database, topics: TopicRepository, topic: CurrentTopic): {
  snapshot: TopicVersion | CurrentTopic; correctionId:string|null; evidenceId:string|null; occurredAt:string;
} | null {
  const rows=client.prepare(`SELECT f.id,f.evidence_id,f.correction_json,f.result_json,s.occurred_at
    FROM founder_feedback_corrections f JOIN context_evidence e ON e.id=f.evidence_id
    JOIN context_sources s ON s.id=e.source_id WHERE f.chat_id=? ORDER BY s.occurred_at DESC,f.created_at DESC,f.id`)
    .all(approvedGroup) as {id:string;evidence_id:string;correction_json:string;result_json:string;occurred_at:string}[];
  const versions=topics.listVersions(topic.id);
  const baseline=[...versions].reverse().find(version=>/^Ivy confirmed Founder work map(?: V\d+)? baseline$/u.test(version.rationale)||[
    'Ivy confirmed Founder work map task','Ivy confirmed Founder work map goal'
  ].includes(version.rationale));
  for(const row of rows) {
    // A later explicit Founder correction supersedes the initial confirmed
    // baseline. Older corrections must not roll a newer baseline backwards.
    if(baseline&&row.occurred_at<baseline.changedAt)continue;
    const rawCorrection=JSON.parse(row.correction_json) as unknown;
    const batch=rawCorrection&&typeof rawCorrection==='object'&&'kind'in rawCorrection&&rawCorrection.kind==='batch_correction'&&
      'operations'in rawCorrection?founderBatchOperationsSchema.safeParse(rawCorrection.operations):null;
    if(batch?.success&&JSON.parse(row.result_json).status==='applied'){
      const touches=batch.data.some(operation=>operation.kind==='update_topic'?operation.topic.id===topic.id:
        operation.kind==='set_work_map_preference'?false:operation.topics.some(ref=>ref.id===topic.id));
      if(touches){const snapshot=versions.find(version=>version.evidenceIds.includes(row.evidence_id));
        if(snapshot)return{snapshot,correctionId:row.id,evidenceId:row.evidence_id,occurredAt:row.occurred_at};}
    }
    const correction=topicCorrectionSchema.safeParse(rawCorrection);
    if(!correction.success || !['merge_topics','split_topic','reclassify_stage','rename_topic','pause_topic'].includes(correction.data.kind) ||
      JSON.parse(row.result_json).status!=='applied')continue;
    const refs='topics' in correction.data ? correction.data.topics : 'topic' in correction.data ? [correction.data.topic] : [];
    const splitParent=correction.data.kind==='split_topic' ? correction.data.topic.id : null;
    if(!refs.some(ref=>ref.id===topic.id) && !(splitParent && topics.listRelations(topic.id).some(relation=>
      relation.relationType==='split_from' && relation.fromTopicId===topic.id && relation.toTopicId===splitParent)))continue;
    // First version carrying this immutable correction is the accepted human
    // snapshot; later model versions cannot manufacture or erase its authority.
    const snapshot=versions.find(v=>v.evidenceIds.includes(row.evidence_id));
    if(snapshot)return {snapshot,correctionId:row.id,evidenceId:row.evidence_id,occurredAt:row.occurred_at};
  }
  if(baseline)return{snapshot:baseline,correctionId:null,evidenceId:null,occurredAt:baseline.changedAt};
  // Legacy paused/closed rows also require explicit human reactivation.
  return ['paused','closed'].includes(topic.stage) ? {snapshot:topic,correctionId:null,evidenceId:null,occurredAt:topic.updatedAt} : null;
}
function liveGapCode(type:string):FeishuContextGap['code'] {
  if(type==='audio'||type==='voice')return 'VOICE_TEXT_MISSING';
  if(type==='media'||type==='video')return 'MEDIA_SKIPPED';
  if(type==='file')return 'FILE_TEXT_UNREADABLE';
  if(type==='image')return 'IMAGE_SKIPPED';
  if(type==='text'||type==='post')return 'MESSAGE_TEXT_UNAVAILABLE';
  return 'MESSAGE_UNSUPPORTED';
}
function fileAttachment(content:string):{fileKey:string;fileName:string}|null{
  try{const value=JSON.parse(content) as Record<string,unknown>;
    return typeof value.file_key==='string'&&value.file_key.trim()&&typeof value.file_name==='string'&&value.file_name.trim()
      ?{fileKey:value.file_key.trim(),fileName:value.file_name.trim()}:null;
  }catch{return null}
}
function saveAttachmentGap(repository:ContextSourceRepository,job:Extract<FounderDurableJob,{kind:'capture_founder_attachment'}>,reason:string,stamp:Date):void{
  repository.saveSource({sourceSystem:'feishu',sourceType:'feishu_sync_gap',externalId:`${job.messageId}:file-gap`,
    logicalKey:`feishu:chat:${job.chatId}:message:${job.messageId}:file-gap`,occurredAt:job.occurredAt,
    authors:[{openId:job.authorOpenId,displayName:null}],locatorUri:null,contentFormat:'application/json',
    contentText:JSON.stringify({code:'FILE_TEXT_UNREADABLE',sourceRef:`feishu:chat:${job.chatId}:message:${job.messageId}`,reason}),
    metadata:{chatId:job.chatId,messageId:job.messageId,messageType:'file',attachmentTitle:job.fileName},availabilityStatus:'unknown',capturedAt:stamp});
}
export function saveFounderEvidence(repository: ContextSourceRepository, sourceId: string, excerpt: string, capturedAt: Date): string {
  const source = repository.getSource(sourceId); if (!source) throw new Error('source missing');
  let locator: unknown;
  if (source.sourceType === 'group_message') locator = { kind: 'group_message', sourceVersion: source.sourceVersion,
    contentHash: source.contentHash, chatId: source.metadata.chatId, messageId: source.externalId,
    threadId: source.metadata.threadId ?? null, authorOpenId: source.authors[0]?.openId ?? null, occurredAt: source.occurredAt };
  else if (source.sourceType === 'space_page_snapshot') {
    const blocks = source.metadata.blocks as Record<string, unknown>[] | undefined;
    const blockOrdinal = blocks?.findIndex(b => typeof b.markdown === 'string' && b.markdown.includes(excerpt)) ?? -1;
    if (blockOrdinal < 0) throw new Error('space page evidence must fit one block');
    const block = blocks![blockOrdinal]!;
    locator = { kind: 'space_page_block', sourceVersion: source.sourceVersion, contentHash: source.contentHash,
      pageId: source.metadata.pageId, blockId: block.id, blockHash: block.hash, blockOrdinal };
  } else if (source.sourceType === 'space_page_comment') {
    locator = { kind: 'space_comment', sourceVersion: source.sourceVersion, contentHash: source.contentHash,
      pageId: source.metadata.pageId, threadId: source.metadata.threadId, messageId: source.metadata.messageId,
      authorOpenId: source.metadata.authorOpenId ?? null, targetBlockId: source.metadata.targetBlockId ?? null };
  } else {
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
    if (message.kind!=='founder_work_map' || !allowed(message.targetChatId)) continue;
    policy.reconcilePending(now());
    try {
      const sent = await options.delivery!.sendInteractiveCard({chatId:message.targetChatId,card:message.card,idempotencyKey:row.idempotency_key});
      if (!sent.messageId.trim() || sent.messageId.startsWith('pending:')) throw new Error('invalid delivery');
      outbox.acknowledgeFounderWorkMapDelivery({...message,messageId:sent.messageId,deliveredAt:now()});
    } catch { options.client.prepare('UPDATE outbox SET attempt_count=attempt_count+1,next_attempt_at=?,last_error_code=? WHERE idempotency_key=? AND status=\'pending\'')
      .run(new Date(now().getTime()+30_000).toISOString(),'FOUNDER_DELIVERY_FAILED',row.idempotency_key); }
  }
}
async function deliverFounderFeedbackMessages(options:FounderStreamOptions,now:()=>Date,allowed:(id:string)=>boolean):Promise<void>{
  const rows=options.client.prepare(`SELECT idempotency_key,payload FROM outbox WHERE status='pending'
    AND (next_attempt_at IS NULL OR next_attempt_at<=?) ORDER BY created_at,id`).all(now().toISOString()) as {idempotency_key:string;payload:string}[];
  for(const row of rows){
    const message=JSON.parse(row.payload) as {kind?:unknown;targetChatId?:unknown;text?:unknown};
    if(message.kind!=='founder_feedback'||typeof message.targetChatId!=='string'||typeof message.text!=='string'||!allowed(message.targetChatId))continue;
    try{
      const sent=await options.delivery!.sendTextMessage({chatId:message.targetChatId,text:message.text,idempotencyKey:row.idempotency_key});
      if(!sent.messageId.trim()||sent.messageId.startsWith('pending:'))throw new Error('invalid delivery');
      options.client.prepare("UPDATE outbox SET status='delivered',delivered_message_id=?,delivered_at=?,next_attempt_at=NULL,last_error_code=NULL WHERE idempotency_key=? AND status='pending'")
        .run(sent.messageId,now().toISOString(),row.idempotency_key);
    }catch{options.client.prepare("UPDATE outbox SET attempt_count=attempt_count+1,next_attempt_at=?,last_error_code='FOUNDER_DELIVERY_FAILED' WHERE idempotency_key=? AND status='pending'")
      .run(new Date(now().getTime()+30_000).toISOString(),row.idempotency_key)}
  }
}
function parseTime(value:string):string|null {
  const ms=/^\d+$/.test(value)? Number(value)*(value.length<=10?1000:1):Date.parse(value);
  return Number.isFinite(ms) && !Number.isNaN(new Date(ms).getTime())?new Date(ms).toISOString():null;
}
function normalizeTopicName(value:string):string {
  return value.normalize('NFKC').toLocaleLowerCase('und').replace(/[\p{P}\p{S}\s]+/gu,'');
}
function dailyCoverageRows(client:Database.Database):{captured_at:string;metadata_json:string;content_text:string}[]{
  return client.prepare("SELECT captured_at,metadata_json,content_text FROM context_sources WHERE source_type='feishu_sync_coverage' ORDER BY captured_at DESC")
    .all() as {captured_at:string;metadata_json:string;content_text:string}[];
}
function latestDailyCoverageAttemptAt(client:Database.Database,chatId:string):number|undefined{
  for(const row of dailyCoverageRows(client))try{const metadata=JSON.parse(row.metadata_json) as {chatId?:unknown;syncPurpose?:unknown};
    if(metadata.chatId===chatId&&metadata.syncPurpose==='daily_reconciliation'){
    const value=Date.parse(row.captured_at);if(Number.isFinite(value))return value;
  }}catch{/* Malformed audit metadata cannot suppress a future reconciliation. */}
  return undefined;
}
function latestCompleteDailyCoverageUntil(client:Database.Database,chatId:string):string|undefined{
  for(const row of dailyCoverageRows(client))try{
    const metadata=JSON.parse(row.metadata_json) as {chatId?:unknown;syncPurpose?:unknown};
    const content=JSON.parse(row.content_text) as {requestedRange?:{until?:unknown};sourceCoverage?:{termination?:unknown}};
    const until=content.requestedRange?.until;
    if(metadata.chatId===chatId&&metadata.syncPurpose==='daily_reconciliation'&&content.sourceCoverage?.termination==='next_cursor_null'&&
      typeof until==='string'&&Number.isFinite(Date.parse(until)))return new Date(until).toISOString();
  }catch{/* Malformed or incomplete coverage cannot advance the durable cursor. */}
  return undefined;
}
function messageText(type:string,content:string):string|null {
  try {
    const value=JSON.parse(content); if(['text','audio','voice'].includes(type)) return typeof value.text==='string' && value.text.trim()?value.text:null;
    if(type!=='post') return null;
    const post=Array.isArray(value.content)?value:Object.values(value).find((v:any)=>Array.isArray(v?.content)) as any;
    const text=[post?.title??'',...(post?.content??[]).flat().map((leaf:any)=>leaf.tag==='text'?leaf.text:'')].join('\n').trim();
    return text||null;
  } catch { return null; }
}

import { z } from 'zod';
import type { ContextSourceRepository } from '../repositories/context-source-repository.js';
import type { JobRepository } from '../repositories/job-repository.js';
import { captureGroupMessageSource } from './group-message-source-capture.js';
import { approvedFeishuProjectContextChatId, FeishuContextSyncError, syncFeishuProjectContext,
  type FeishuContextClient, type FeishuContextSyncReport } from './feishu-context-sync.js';

export interface FounderStreamBackfillInput {
  chatId: string;
  since: string;
  now: Date;
  feishu: FeishuContextClient;
  sourceRepository?: ContextSourceRepository;
  jobRepository?: JobRepository;
  dryRun?: boolean;
}

export interface FounderStreamBackfillReport extends FeishuContextSyncReport {
  dryRun: boolean;
  sourcesCaptured: number;
  sourcesCreated: number;
  jobsEnqueued: number;
}

export function validateFounderStreamWindow(chatId: string, since: string, now: Date): void {
  if (chatId !== approvedFeishuProjectContextChatId) throw new FeishuContextSyncError(chatId);
  if (!z.iso.datetime({ offset: true }).safeParse(since).success || !Number.isFinite(now.getTime()) || new Date(since) > now) {
    throw new Error('FOUNDER_STREAM_RANGE_INVALID');
  }
}

export async function runFounderStreamBackfill(input: FounderStreamBackfillInput): Promise<FounderStreamBackfillReport> {
  validateFounderStreamWindow(input.chatId, input.since, input.now);
  const dryRun = input.dryRun ?? true;
  const { sourceRepository, jobRepository } = input;
  if (!dryRun && (!sourceRepository || !jobRepository || sourceRepository.client !== jobRepository.client)) {
    throw new Error('FOUNDER_STREAM_SHARED_REPOSITORIES_REQUIRED');
  }
  let sourcesCreated = 0;
  const sourceIds: string[] = [];
  const report = await syncFeishuProjectContext({
    chatId: input.chatId, approvedChatIds: [approvedFeishuProjectContextChatId],
    since: new Date(input.since), now: () => input.now, feishu: input.feishu,
    saveMessage: async (message) => {
      const captured = captureGroupMessageSource({
        chatId: input.chatId, messageId: message.messageId, threadId: message.threadId ?? null,
        rootId: message.rootId ?? null, author: { openId: message.senderId ?? null, displayName: null },
        messageType: message.messageType, text: message.text!, occurredAt: message.createdAt
      }, input.now);
      captured.source.metadata = { ...captured.source.metadata, parentId: message.parentId ?? null,
        edited: message.edited ?? false, deleted: message.deleted ?? false };
      if (!dryRun) {
        const saved = sourceRepository!.saveSource(captured.source);
        sourceIds.push(saved.source.id);
        if (saved.created) sourcesCreated += 1;
      }
    },
    saveSnapshot: async (snapshot) => {
      if (dryRun) return;
      sourceRepository!.saveSource({ sourceSystem: 'feishu', sourceType: snapshot.sourceKind,
        externalId: snapshot.sourceRef, logicalKey: snapshot.sourceRef, occurredAt: input.now.toISOString(),
        authors: [], locatorUri: null, contentFormat: snapshot.sourceKind.startsWith('feishu_sync_') ? 'application/json' : 'text/plain',
        contentText: snapshot.content, metadata: { chatId: input.chatId }, availabilityStatus: 'available', capturedAt: input.now });
    }
  });
  let jobsEnqueued = 0;
  if (!dryRun && sourceIds.length > 0) {
    const result = jobRepository!.enqueueFounderStreamBatch({ chatId: input.chatId,
      since: report.requestedRange.since, until: report.requestedRange.until, sourceIds, capturedAt: input.now });
    jobsEnqueued = result.created ? 1 : 0;
  }
  return { ...report, dryRun, sourcesCaptured: report.messagesStored, sourcesCreated, jobsEnqueued };
}

import type Database from 'better-sqlite3';
import {
  assertSpaceSyncEnvelopeWithinLimits,
  canonicalSpacePageContentText,
  spaceCommentLogicalKey,
  spacePageLogicalKey,
  spaceSyncCoverageLogicalKey,
  spaceSyncGapLogicalKey,
  type SpaceSyncEnvelopeLimits,
  type SpaceSyncEnvelopeV1,
  type SpaceSyncLimitErrorCode
} from '../domain/space-sync.js';
import { ContextSourceRepository } from '../repositories/context-source-repository.js';
import { SpaceSyncRepository, type SpaceSyncRunRecord } from '../repositories/space-sync-repository.js';
import { canonicalJson, sha256 } from './canonical-json.js';

export type SpaceSyncIngestionErrorCode =
  | 'space_sync_unregistered_page'
  | 'space_sync_project_mismatch'
  | 'space_sync_binding_not_active'
  | 'space_sync_envelope_conflict'
  | SpaceSyncLimitErrorCode;

export class SpaceSyncIngestionError extends Error {
  constructor(readonly code: SpaceSyncIngestionErrorCode) {
    super(code);
  }
}

export interface SpaceSyncIngestionDependencies {
  client: Database.Database;
  spaceSyncRepository: SpaceSyncRepository;
  contextSourceRepository: ContextSourceRepository;
  limits: SpaceSyncEnvelopeLimits;
  now(): Date;
}

export interface SpaceSyncIngestionResult {
  syncId: string;
  /** true when this is a safe retry of an already-committed syncId, not a new write. */
  replay: boolean;
  run: SpaceSyncRunRecord;
}

/**
 * Orchestrates one SpaceSyncEnvelopeV1 ingest: binding lookup, idempotent replay detection,
 * and the single transaction that writes sources, advances the binding cursor and records
 * the run receipt. Never sends a Feishu message and never executes a Todo.
 */
export function ingestSpaceSyncEnvelope(
  envelope: SpaceSyncEnvelopeV1,
  dependencies: SpaceSyncIngestionDependencies
): SpaceSyncIngestionResult {
  assertSpaceSyncEnvelopeWithinLimits(envelope, dependencies.limits);

  const envelopeHash = sha256(canonicalJson(envelope));
  const existingRun = dependencies.spaceSyncRepository.getRunBySyncId(envelope.syncId);
  if (existingRun) {
    const matches = existingRun.envelopeHash === envelopeHash &&
      existingRun.projectKey === envelope.projectKey &&
      existingRun.pageId === envelope.page.pageId;
    if (!matches) throw new SpaceSyncIngestionError('space_sync_envelope_conflict');
    return { syncId: envelope.syncId, replay: true, run: existingRun };
  }

  const binding = dependencies.spaceSyncRepository.getBindingByPageId(envelope.page.pageId);
  if (!binding) throw new SpaceSyncIngestionError('space_sync_unregistered_page');
  if (binding.projectKey !== envelope.projectKey) throw new SpaceSyncIngestionError('space_sync_project_mismatch');
  if (binding.status !== 'active') throw new SpaceSyncIngestionError('space_sync_binding_not_active');

  const startedAt = dependencies.now();

  return dependencies.client.transaction(() => {
    const pageSave = dependencies.contextSourceRepository.saveSource({
      sourceSystem: 'chatgpt_space',
      sourceType: 'space_page_snapshot',
      externalId: envelope.page.pageId,
      logicalKey: spacePageLogicalKey(envelope.page.pageId),
      occurredAt: envelope.page.updatedAt ?? envelope.capturedAt,
      authors: [],
      locatorUri: envelope.page.url,
      contentFormat: 'text/markdown',
      contentText: canonicalSpacePageContentText(envelope.page.blocks),
      metadata: {
        pageId: envelope.page.pageId,
        spaceId: envelope.page.spaceId,
        title: envelope.page.title,
        sequence: envelope.page.sequence,
        blocks: envelope.page.blocks
      },
      availabilityStatus: 'available',
      capturedAt: startedAt
    });

    let commentSourcesCreated = 0;
    for (const comment of envelope.comments) {
      const commentSave = dependencies.contextSourceRepository.saveSource({
        sourceSystem: 'chatgpt_space',
        sourceType: 'space_page_comment',
        externalId: comment.messageId,
        logicalKey: spaceCommentLogicalKey(envelope.page.pageId, comment.threadId, comment.messageId),
        occurredAt: comment.editedAt ?? comment.createdAt,
        authors: [{ openId: comment.authorId, displayName: comment.authorDisplayName }],
        locatorUri: envelope.page.url,
        contentFormat: 'text/plain',
        contentText: comment.body,
        metadata: {
          pageId: envelope.page.pageId,
          threadId: comment.threadId,
          messageId: comment.messageId,
          authorOpenId: comment.authorId,
          threadState: comment.threadState,
          resolvedAt: comment.resolvedAt,
          targetBlockId: comment.targetBlockId,
          selectedText: comment.selectedText
        },
        availabilityStatus: 'available',
        capturedAt: startedAt
      });
      if (commentSave.created) commentSourcesCreated += 1;
    }

    dependencies.contextSourceRepository.saveSource({
      sourceSystem: 'chatgpt_space',
      sourceType: 'space_sync_coverage',
      externalId: envelope.syncId,
      logicalKey: spaceSyncCoverageLogicalKey(envelope.page.pageId, envelope.syncId),
      occurredAt: envelope.capturedAt,
      authors: [],
      locatorUri: null,
      contentFormat: 'application/json',
      contentText: canonicalJson(envelope.coverage),
      metadata: { pageId: envelope.page.pageId, syncId: envelope.syncId, trigger: envelope.trigger },
      availabilityStatus: 'available',
      capturedAt: startedAt
    });

    for (const gap of envelope.coverage.gaps) {
      dependencies.contextSourceRepository.saveSource({
        sourceSystem: 'chatgpt_space',
        sourceType: 'space_sync_gap',
        externalId: `${envelope.syncId}:${gap.code}`,
        logicalKey: spaceSyncGapLogicalKey(envelope.page.pageId, envelope.syncId, gap.code),
        occurredAt: envelope.capturedAt,
        authors: [],
        locatorUri: null,
        contentFormat: 'text/plain',
        contentText: gap.summary,
        metadata: { pageId: envelope.page.pageId, syncId: envelope.syncId, gapCode: gap.code },
        availabilityStatus: 'available',
        capturedAt: startedAt
      });
    }

    dependencies.spaceSyncRepository.recordSuccessfulSync({
      bindingId: binding.id,
      pageSequence: envelope.page.sequence,
      pageUpdatedAt: envelope.page.updatedAt,
      syncedAt: startedAt
    });

    const run = dependencies.spaceSyncRepository.insertRun({
      syncId: envelope.syncId,
      bindingId: binding.id,
      projectKey: envelope.projectKey,
      pageId: envelope.page.pageId,
      trigger: envelope.trigger,
      envelopeHash,
      pageSourceCreated: pageSave.created,
      commentSourcesCreated,
      coveragePageComplete: envelope.coverage.pageComplete,
      coverageCommentsComplete: envelope.coverage.commentsComplete,
      nextCursor: envelope.coverage.nextCursor,
      gapCount: envelope.coverage.gaps.length,
      startedAt,
      completedAt: dependencies.now()
    });

    return { syncId: envelope.syncId, replay: false, run };
  })();
}

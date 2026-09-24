import {
  contextEvidenceLocatorSchema,
  transcriptEvidenceLocatorSchema,
  type ContextEvidenceLocator,
  type GroupMessageEvidenceLocator,
  type TranscriptEvidenceLocator
} from '../domain/context.js';

interface TranscriptEvidenceSource {
  sourceVersion: number;
  contentHash: string;
  contentText: string;
  metadata: Record<string, unknown>;
  sourceType?: string;
  externalId?: string;
  occurredAt?: string;
  authors?: readonly Record<string, unknown>[];
}

interface NormalizedTranscriptSegment {
  segmentOrdinal: number;
  speakerName: string;
  startMs: number;
  endMs: number;
  text: string;
}

export function validateTranscriptEvidenceLocator(
  source: TranscriptEvidenceSource | null,
  excerpt: string,
  locatorInput: unknown
): TranscriptEvidenceLocator {
  if (!source) throw new Error('CONTEXT_EVIDENCE_SOURCE_NOT_FOUND');
  const locator = transcriptEvidenceLocatorSchema.parse(locatorInput);
  if (locator.sourceVersion !== source.sourceVersion || locator.contentHash !== source.contentHash) {
    throw new Error('CONTEXT_EVIDENCE_SOURCE_BINDING_INVALID');
  }
  const segments = readNormalizedSegments(source);
  const segment = segments[locator.segmentOrdinal];
  if (!segment || segment.segmentOrdinal !== locator.segmentOrdinal ||
    segment.speakerName !== locator.speakerName || segment.startMs !== locator.startMs ||
    segment.endMs !== locator.endMs || !excerpt.trim() || !segment.text.includes(excerpt)) {
    throw new Error('CONTEXT_EVIDENCE_LOCATOR_INVALID');
  }
  return locator;
}

export function validateContextEvidenceLocator(
  source: TranscriptEvidenceSource | null,
  excerpt: string,
  locatorInput: unknown
): ContextEvidenceLocator {
  if (!source) throw new Error('CONTEXT_EVIDENCE_SOURCE_NOT_FOUND');
  const locator = contextEvidenceLocatorSchema.parse(locatorInput);
  if (locator.kind === 'minute_segment') {
    const { kind: _kind, ...legacyLocator } = locator;
    validateTranscriptEvidenceLocator(source, excerpt, legacyLocator);
    return locator;
  }
  return validateGroupMessageEvidenceLocator(source, excerpt, locator);
}

function validateGroupMessageEvidenceLocator(
  source: TranscriptEvidenceSource,
  excerpt: string,
  locator: GroupMessageEvidenceLocator
): GroupMessageEvidenceLocator {
  if (locator.sourceVersion !== source.sourceVersion || locator.contentHash !== source.contentHash) {
    throw new Error('CONTEXT_EVIDENCE_SOURCE_BINDING_INVALID');
  }
  const storedThreadId = typeof source.metadata.threadId === 'string' ? source.metadata.threadId : null;
  const storedMessageId = typeof source.metadata.messageId === 'string'
    ? source.metadata.messageId
    : source.externalId;
  const attachmentTitle = typeof source.metadata.attachmentTitle === 'string'
    ? source.metadata.attachmentTitle.trim()
    : '';
  const legacyAttachmentIdentity = Boolean(attachmentTitle) && locator.messageId === source.externalId &&
    (source.externalId === `${storedMessageId}:file` || source.externalId.startsWith(`${storedMessageId}:file:`));
  const authorMatches = source.authors?.some((author) =>
    (typeof author.openId === 'string' ? author.openId : null) === locator.authorOpenId
  ) ?? false;
  if (source.sourceType !== 'group_message' || source.metadata.chatId !== locator.chatId ||
    (!legacyAttachmentIdentity && storedMessageId !== locator.messageId) || source.externalId !== locator.messageId ||
    storedThreadId !== locator.threadId || source.occurredAt !== locator.occurredAt ||
    !authorMatches || !excerpt.trim() || !source.contentText.includes(excerpt)) {
    throw new Error('CONTEXT_EVIDENCE_LOCATOR_INVALID');
  }
  return locator;
}

function readNormalizedSegments(source: TranscriptEvidenceSource): NormalizedTranscriptSegment[] {
  const storedSegments = source.metadata.segments;
  if (!Array.isArray(storedSegments)) throw new Error('CONTEXT_EVIDENCE_SOURCE_SEGMENTS_INVALID');
  const segments = storedSegments.map((stored, index) => {
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
      throw new Error('CONTEXT_EVIDENCE_SOURCE_SEGMENTS_INVALID');
    }
    const segment = stored as Record<string, unknown>;
    if (segment.segmentOrdinal !== index || typeof segment.speakerName !== 'string' ||
      typeof segment.startMs !== 'number' || typeof segment.endMs !== 'number' ||
      typeof segment.text !== 'string') {
      throw new Error('CONTEXT_EVIDENCE_SOURCE_SEGMENTS_INVALID');
    }
    return {
      segmentOrdinal: index,
      speakerName: segment.speakerName,
      startMs: segment.startMs,
      endMs: segment.endMs,
      text: segment.text
    };
  });
  const normalizedContent = segments.map((segment) =>
    `${segment.speakerName} [${segment.startMs}-${segment.endMs}]: ${segment.text}`
  ).join('\n');
  if (normalizedContent !== source.contentText) {
    throw new Error('CONTEXT_EVIDENCE_SOURCE_SEGMENTS_INVALID');
  }
  return segments;
}

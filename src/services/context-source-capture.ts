import type { MinuteContext } from '../ports/feishu.js';
import type { SaveContextSourceInput } from '../repositories/context-source-repository.js';

export const minuteTranscriptNormalizationVersion = 'normalized-transcript-v1';

export type ContextCaptureFailureCode =
  | 'CONTEXT_SOURCE_BYTES_EXCEEDED'
  | 'CONTEXT_SOURCE_SEGMENTS_EXCEEDED'
  | 'CONTEXT_SOURCE_CAPTURE_FAILED'
  | 'CONTEXT_JOB_ENQUEUE_FAILED';

export class ContextCaptureError extends Error {
  constructor(readonly code: ContextCaptureFailureCode) {
    super(code);
    this.name = 'ContextCaptureError';
  }
}

export class ContextSourceCaptureError extends ContextCaptureError {
  constructor(code: Extract<ContextCaptureFailureCode,
    'CONTEXT_SOURCE_BYTES_EXCEEDED' | 'CONTEXT_SOURCE_SEGMENTS_EXCEEDED'>) {
    super(code);
    this.name = 'ContextSourceCaptureError';
  }
}

export interface ContextSourceCaptureLimits {
  maxBytes: number;
  maxSegments: number;
}

export interface CapturedMinuteSource {
  source: SaveContextSourceInput;
  segmentLocators: readonly {
    segmentOrdinal: number;
    speakerName: string;
    startMs: number;
    endMs: number;
    text: string;
  }[];
}

export function assertContextSourceBytesWithinLimit(
  contentText: string,
  limits?: Pick<ContextSourceCaptureLimits, 'maxBytes'>
): void {
  if (limits && Buffer.byteLength(contentText, 'utf8') > limits.maxBytes) {
    throw new ContextSourceCaptureError('CONTEXT_SOURCE_BYTES_EXCEEDED');
  }
}

export function captureMinuteTranscriptSource(
  context: MinuteContext,
  capturedAt: Date,
  limits?: ContextSourceCaptureLimits,
  founderStreamChatId?: string
): CapturedMinuteSource {
  if (limits && context.transcript.length > limits.maxSegments) {
    throw new ContextSourceCaptureError('CONTEXT_SOURCE_SEGMENTS_EXCEEDED');
  }
  const segmentLocators = context.transcript.map((segment, segmentOrdinal) => ({
    segmentOrdinal, ...segment
  }));
  const contentText = context.transcript.map((segment) =>
    `${segment.speakerName} [${segment.startMs}-${segment.endMs}]: ${segment.text}`
  ).join('\n');
  assertContextSourceBytesWithinLimit(contentText, limits);
  return {
    source: {
      sourceSystem: 'feishu',
      sourceType: 'minute_transcript',
      externalId: context.minuteId,
      logicalKey: `feishu:minute:${context.minuteId}:transcript`,
      occurredAt: context.startedAt,
      authors: [...new Set(context.transcript.map((segment) => segment.speakerName))]
        .map((speakerName) => ({ speakerName })),
      locatorUri: null,
      contentFormat: `text/plain; profile=${minuteTranscriptNormalizationVersion}`,
      contentText,
      metadata: {
        ...(founderStreamChatId ? { founderStreamEligible: true, founderStreamChatId } : {}),
        title: context.title,
        startedAt: context.startedAt,
        endedAt: context.endedAt,
        normalizationVersion: minuteTranscriptNormalizationVersion,
        segments: segmentLocators.map((segment) => ({ ...segment }))
      },
      availabilityStatus: 'available',
      capturedAt
    },
    segmentLocators
  };
}

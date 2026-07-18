import type { Readable } from 'node:stream';
import { TranscriptSegment, type TranscriptSegment as TranscriptSegmentRecord } from '../domain/meeting.js';

export class MinuteTranscriptParseError extends Error {
  readonly code = 'MINUTE_TRANSCRIPT_INVALID';

  constructor() {
    super('minute transcript stream is invalid');
    this.name = 'MinuteTranscriptParseError';
  }
}

export async function parseMinuteTranscriptStream(
  stream: Readable
): Promise<TranscriptSegmentRecord[]> {
  const raw = await readUtf8(stream);
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new MinuteTranscriptParseError();
  }

  const segments = extractSegments(payload);
  try {
    return segments.map(normalizeSegment);
  } catch {
    throw new MinuteTranscriptParseError();
  }
}

async function readUtf8(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8'));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function extractSegments(payload: unknown): unknown[] {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (!isRecord(payload)) {
    throw new MinuteTranscriptParseError();
  }
  if (Array.isArray(payload.segments)) {
    return payload.segments;
  }
  if (Array.isArray(payload.transcript)) {
    return payload.transcript;
  }
  throw new MinuteTranscriptParseError();
}

function normalizeSegment(input: unknown): TranscriptSegmentRecord {
  if (!isRecord(input)) {
    throw new MinuteTranscriptParseError();
  }
  return TranscriptSegment.parse({
    speakerName: pickString(input, ['speakerName', 'speaker_name', 'speaker']),
    startMs: pickNumber(input, ['startMs', 'start_ms', 'start_time']),
    endMs: pickNumber(input, ['endMs', 'end_ms', 'end_time']),
    text: pickString(input, ['text', 'content'])
  });
}

function pickString(input: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string') {
      return value;
    }
  }
  throw new MinuteTranscriptParseError();
}

function pickNumber(input: Record<string, unknown>, keys: string[]): number {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  throw new MinuteTranscriptParseError();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

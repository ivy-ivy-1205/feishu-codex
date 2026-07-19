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
    return parsePlainTextTranscript(raw);
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

function parsePlainTextTranscript(raw: string): TranscriptSegmentRecord[] {
  const lines = raw
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    return [];
  }

  const speakerNames = extractPlainTextSpeakerNames(lines);
  if (speakerNames.length === 0) {
    throw new MinuteTranscriptParseError();
  }
  const speakerSet = new Set(speakerNames.map(normalizeSpeakerKey));
  const segments: Array<{ speakerName: string; textLines: string[] }> = [];
  let current: { speakerName: string; textLines: string[] } | null = null;
  let skipSpeakerListLine = false;

  for (const line of lines) {
    if (isPlainTextHeaderLine(line)) {
      continue;
    }
    if (isSpeakerMarkerLine(line)) {
      skipSpeakerListLine = true;
      continue;
    }
    if (skipSpeakerListLine) {
      skipSpeakerListLine = false;
      continue;
    }

    const speakerName = matchSpeakerName(line, speakerSet, speakerNames);
    if (speakerName !== null) {
      if (current !== null && current.textLines.length > 0) {
        segments.push(current);
      }
      current = { speakerName, textLines: [] };
      continue;
    }
    if (current !== null) {
      current.textLines.push(line);
    }
  }

  if (current !== null && current.textLines.length > 0) {
    segments.push(current);
  }

  try {
    return segments.map((segment, index) => TranscriptSegment.parse({
      speakerName: segment.speakerName,
      startMs: index,
      endMs: index + 1,
      text: segment.textLines.join('\n')
    }));
  } catch {
    throw new MinuteTranscriptParseError();
  }
}

function extractPlainTextSpeakerNames(lines: string[]): string[] {
  const markerIndex = lines.findIndex(isSpeakerMarkerLine);
  if (markerIndex < 0) {
    return [];
  }
  const speakerLine = lines[markerIndex + 1];
  if (!speakerLine) {
    return [];
  }
  return speakerLine
    .split(/[、,，]/u)
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

function isPlainTextHeaderLine(line: string): boolean {
  return /^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\s+[A-Z]{2,5}\|/u.test(line);
}

function isSpeakerMarkerLine(line: string): boolean {
  return /^发言人(?:\(\d+\)|（\d+）)?[:：]?$/u.test(line);
}

function matchSpeakerName(
  line: string,
  speakerSet: Set<string>,
  speakerNames: string[]
): string | null {
  const normalized = normalizeSpeakerKey(line);
  if (!speakerSet.has(normalized)) {
    return null;
  }
  return speakerNames.find((name) => normalizeSpeakerKey(name) === normalized) ?? line;
}

function normalizeSpeakerKey(value: string): string {
  return value.normalize('NFKC').trim().toLowerCase();
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

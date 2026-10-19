export interface VerifiedSingleSpeakerSrtSegment {
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
  readonly contentStart: number;
  readonly contentEnd: number;
}

export interface VerifiedSingleSpeakerSrtExport {
  readonly segments: readonly VerifiedSingleSpeakerSrtSegment[];
}

const cueTimePattern =
  /^(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s+-->\s+(\d{2}):(\d{2}):(\d{2})[,.](\d{3})$/u;
const speakerPrefixedTextPattern =
  /^([\p{L}\p{Script=Han}][^:：\n]{0,39})[:：]([ \t]*)(\S.*)$/u;

/**
 * Validates a complete SRT export as one speaker before returning any cues.
 * Every cue must be sequential, timestamped, speaker-prefixed, non-overlapping,
 * and use the same normalized upstream speaker label.
 */
export function matchFeishuSingleSpeakerSrtExport(
  raw: string
): VerifiedSingleSpeakerSrtExport | null {
  const normalized = raw.replace(/\r\n/g, '\n');
  if (normalized.includes('\r')) {
    return null;
  }
  const texts = normalized.split('\n');
  let offset = 0;
  if (texts[0] === '' && texts[1] === '1') {
    texts.shift();
    offset = 1;
  }
  while (texts.at(-1) === '') {
    texts.pop();
  }
  if (texts.length === 0) {
    return null;
  }
  const starts: number[] = [];
  for (const line of texts) {
    starts.push(offset);
    offset += line.length + 1;
  }

  const segments: VerifiedSingleSpeakerSrtSegment[] = [];
  let expectedOrdinal = 1;
  let expectedSpeaker: string | null = null;
  let previousEndMs = 0;
  let index = 0;
  while (index < texts.length) {
    if (texts[index] !== String(expectedOrdinal)) {
      return null;
    }
    const time = parseCueTime(texts[index + 1]);
    if (!time || time.startMs > time.endMs || time.startMs < previousEndMs) {
      return null;
    }
    const firstTextIndex = index + 2;
    const firstTextLine = texts[firstTextIndex];
    if (!firstTextLine) {
      return null;
    }
    const speakerMatch = speakerPrefixedTextPattern.exec(firstTextLine);
    if (!speakerMatch?.[1] || !speakerMatch[3]) {
      return null;
    }
    const speaker = normalizeSpeaker(speakerMatch[1]);
    if (!speaker || (expectedSpeaker !== null && speaker !== expectedSpeaker)) {
      return null;
    }
    expectedSpeaker ??= speaker;

    const continuationLines: string[] = [];
    let nextIndex = firstTextIndex + 1;
    while (nextIndex < texts.length && texts[nextIndex] !== '') {
      const continuation = texts[nextIndex]!;
      if (!continuation.trim()) {
        return null;
      }
      continuationLines.push(continuation);
      nextIndex += 1;
    }
    const firstText = speakerMatch[3];
    const text = [firstText, ...continuationLines].join('\n');
    const contentColumn = speakerMatch[1].length + 1 + speakerMatch[2].length;
    const contentStart = starts[firstTextIndex]! + contentColumn;
    const lastTextIndex = nextIndex - 1;
    const contentEnd = continuationLines.length > 0
      ? starts[lastTextIndex]! + texts[lastTextIndex]!.length
      : contentStart + firstText.length;
    if (normalized.slice(contentStart, contentEnd) !== text) {
      return null;
    }
    segments.push({ ...time, text, contentStart, contentEnd });

    if (nextIndex < texts.length) {
      while (nextIndex < texts.length && texts[nextIndex] === '') {
        nextIndex += 1;
      }
      if (nextIndex >= texts.length) {
        return null;
      }
    }
    previousEndMs = time.endMs;
    expectedOrdinal += 1;
    index = nextIndex;
  }
  return expectedSpeaker && segments.length > 0 ? { segments } : null;
}

function parseCueTime(value: string | undefined): { startMs: number; endMs: number } | null {
  if (!value) {
    return null;
  }
  const match = cueTimePattern.exec(value);
  if (!match) {
    return null;
  }
  const startParts = match.slice(1, 5);
  const endParts = match.slice(5, 9);
  if (!validTimeParts(startParts) || !validTimeParts(endParts)) {
    return null;
  }
  return {
    startMs: toMilliseconds(startParts),
    endMs: toMilliseconds(endParts)
  };
}

function validTimeParts(parts: string[]): boolean {
  const [, minutes, seconds] = parts.map(Number);
  return minutes! < 60 && seconds! < 60;
}

function toMilliseconds(parts: string[]): number {
  const [hours, minutes, seconds, millis] = parts.map(Number);
  return (((hours! * 60) + minutes!) * 60 + seconds!) * 1_000 + millis!;
}

function normalizeSpeaker(value: string): string {
  return value.normalize('NFKC').trim().toLowerCase();
}

export interface VerifiedHeaderlessSingleSpeakerExport {
  readonly text: string;
  readonly contentStart: number;
  readonly contentEnd: number;
}

const feishuExportHeaderPattern =
  /^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\s+[A-Z]{2,5}\|[^\n]+$/u;

/**
 * Matches the narrow Feishu TXT export shape where an explicit speaker request
 * is represented by the self label `我` and one contiguous transcript block.
 * The caller must still prove that the upstream request asked Feishu to include
 * speaker boundaries before treating this match as verified.
 */
export function matchFeishuHeaderlessSingleSpeakerExport(
  raw: string
): VerifiedHeaderlessSingleSpeakerExport | null {
  const normalized = raw.replace(/\r\n/g, '\n');
  if (normalized.includes('\r')) {
    return null;
  }
  const lines = normalized.split('\n');
  while (lines.at(-1) === '') {
    lines.pop();
  }
  if (
    lines.length < 7 ||
    !feishuExportHeaderPattern.test(lines[0] ?? '') ||
    lines[1] !== '' ||
    lines[2] !== '关键词:' ||
    !(lines[3]?.trim()) ||
    lines[4] !== '' ||
    lines[5] !== '我'
  ) {
    return null;
  }

  const bodyLines = lines.slice(6);
  if (
    bodyLines.length === 0 ||
    bodyLines.some((line, index) => !line.trim() ||
      isSuspectedSpeakerBoundary(line) ||
      isPossibleUnnumberedSpeakerBoundary(line, index, bodyLines.length))
  ) {
    return null;
  }
  const text = bodyLines.join('\n');
  const contentStart = lines.slice(0, 6).reduce((offset, line) => offset + line.length + 1, 0);
  return {
    text,
    contentStart,
    contentEnd: contentStart + text.length
  };
}

function isPossibleUnnumberedSpeakerBoundary(
  line: string,
  index: number,
  lineCount: number
): boolean {
  if (index === lineCount - 1) {
    return false;
  }
  const trimmed = line.trim();
  return trimmed.length <= 40 &&
    !/[。！？!?；;，、,：:|]/u.test(trimmed) &&
    /[\p{L}\p{Script=Han}]/u.test(trimmed);
}

function isSuspectedSpeakerBoundary(line: string): boolean {
  const trimmed = line.trim();
  return trimmed === '我' ||
    /^说话人[ \t]+[1-9]\d*$/u.test(trimmed) ||
    /^发言人(?:\(\d+\)|（\d+）)?[:：]?$/u.test(trimmed);
}

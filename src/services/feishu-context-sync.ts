const maxSnapshotBytes = 8 * 1024;
const mediaMessageTypes = new Set<FeishuContextMessage['messageType']>(['video', 'audio']);

export interface FeishuContextMessage {
  messageId: string;
  messageType: 'text' | 'post' | 'file' | 'image' | 'video' | 'audio' | 'voice' | 'unknown';
  text: string | null;
  createdAt: string;
}

export interface FeishuContextFile {
  fileToken: string;
  title: string;
  mimeType: string;
  text: string | null;
}

export interface FeishuContextClient {
  listMessages(input: { chatId: string; cursor: string | null; since: Date }): Promise<{
    messages: FeishuContextMessage[];
    nextCursor: string | null;
  }>;
  listReferencedFiles(input: { chatId: string; messageIds: readonly string[] }): Promise<FeishuContextFile[]>;
}

export interface FeishuContextSnapshot {
  sourceKind: string;
  sourceRef: string;
  content: string;
}

export interface FeishuContextGap {
  code: 'MEDIA_SKIPPED' | 'VOICE_TEXT_MISSING' | 'FILE_TEXT_UNREADABLE';
  sourceRef: string;
  reason: string;
}

export interface FeishuContextSyncReport {
  chatId: string;
  since: string;
  capturedAt: string;
  messagesRead: number;
  messagesStored: number;
  filesRead: number;
  filesUnreadable: number;
  mediaSkipped: number;
  voiceTextMissing: number;
  pagesRead: number;
  sourceCoverage: {
    messageIds: string[];
    fileTokens: string[];
  };
  gaps: FeishuContextGap[];
}

export interface SyncFeishuProjectContextInput {
  chatId: string;
  approvedChatIds: readonly string[];
  since: Date;
  feishu: FeishuContextClient;
  saveSnapshot: (snapshot: FeishuContextSnapshot) => Promise<void>;
  now?: () => Date;
}

export class FeishuContextSyncError extends Error {
  readonly code = 'FEISHU_CHAT_NOT_APPROVED';

  constructor(chatId: string) {
    super(`Feishu chat is not approved for project context sync: ${chatId}`);
    this.name = 'FeishuContextSyncError';
  }
}

/**
 * Explicitly invoked, auditable context capture for an approved Feishu group.
 * It never claims a complete sync: skipped and unreadable sources are returned as gaps.
 */
export async function syncFeishuProjectContext(
  input: SyncFeishuProjectContextInput
): Promise<FeishuContextSyncReport> {
  const chatId = input.chatId.trim();
  if (!input.approvedChatIds.some((approvedChatId) => approvedChatId.trim() === chatId)) {
    throw new FeishuContextSyncError(chatId);
  }

  const gaps: FeishuContextGap[] = [];
  const messageIds: string[] = [];
  const fileTokens: string[] = [];
  let cursor: string | null = null;
  let pagesRead = 0;
  let messagesRead = 0;
  let messagesStored = 0;
  let mediaSkipped = 0;
  let voiceTextMissing = 0;

  do {
    const page = await input.feishu.listMessages({ chatId, cursor, since: input.since });
    pagesRead += 1;
    for (const message of page.messages) {
      messagesRead += 1;
      messageIds.push(message.messageId);
      const sourceRef = messageSourceRef(chatId, message.messageId);
      if (mediaMessageTypes.has(message.messageType)) {
        mediaSkipped += 1;
        gaps.push({ code: 'MEDIA_SKIPPED', sourceRef, reason: `${message.messageType} is skipped by policy` });
        continue;
      }
      if (message.messageType === 'voice' && !readableText(message.text)) {
        voiceTextMissing += 1;
        gaps.push({ code: 'VOICE_TEXT_MISSING', sourceRef, reason: 'native voice message has no approved transcript text' });
        continue;
      }
      if ((message.messageType === 'text' || message.messageType === 'post') && readableText(message.text)) {
        await saveContentChunks(input.saveSnapshot, {
          sourceKind: `feishu_${message.messageType}`,
          sourceRef,
          content: message.text!
        });
        messagesStored += 1;
      }
    }
    cursor = page.nextCursor;
  } while (cursor !== null);

  let filesRead = 0;
  let filesUnreadable = 0;
  if (messageIds.length > 0) {
    const files = await input.feishu.listReferencedFiles({ chatId, messageIds });
    for (const file of files) {
      fileTokens.push(file.fileToken);
      const sourceRef = `feishu:chat:${chatId}:file:${file.fileToken}`;
      if (isSkippedMediaFile(file)) {
        mediaSkipped += 1;
        gaps.push({ code: 'MEDIA_SKIPPED', sourceRef, reason: `${file.mimeType} is skipped by policy` });
        continue;
      }
      if (!readableText(file.text)) {
        filesUnreadable += 1;
        gaps.push({ code: 'FILE_TEXT_UNREADABLE', sourceRef, reason: 'file text was unavailable or unreadable' });
        continue;
      }
      await saveContentChunks(input.saveSnapshot, {
        sourceKind: 'feishu_file',
        sourceRef,
        content: `${file.title}\n${file.text}`
      });
      filesRead += 1;
    }
  }

  const capturedAt = (input.now ?? (() => new Date()))().toISOString();
  const report: FeishuContextSyncReport = {
    chatId,
    since: input.since.toISOString(),
    capturedAt,
    messagesRead,
    messagesStored,
    filesRead,
    filesUnreadable,
    mediaSkipped,
    voiceTextMissing,
    pagesRead,
    sourceCoverage: { messageIds, fileTokens },
    gaps
  };
  const syncSourceRef = `feishu:chat:${chatId}:sync:${capturedAt}`;
  await input.saveSnapshot({
    sourceKind: 'feishu_sync_coverage',
    sourceRef: `${syncSourceRef}:coverage`,
    content: JSON.stringify({
      chatId: report.chatId,
      since: report.since,
      capturedAt: report.capturedAt,
      messagesRead: report.messagesRead,
      filesRead: report.filesRead,
      sourceCoverage: report.sourceCoverage
    })
  });
  for (const gap of gaps) {
    await input.saveSnapshot({
      sourceKind: 'feishu_sync_gap',
      sourceRef: `${syncSourceRef}:gap:${gap.code}:${gaps.indexOf(gap) + 1}`,
      content: JSON.stringify(gap)
    });
  }
  return report;
}

function readableText(value: string | null): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isSkippedMediaFile(file: FeishuContextFile): boolean {
  return file.mimeType.startsWith('video/') || file.mimeType.startsWith('audio/');
}

function messageSourceRef(chatId: string, messageId: string): string {
  return `feishu:chat:${chatId}:message:${messageId}`;
}

async function saveContentChunks(
  saveSnapshot: SyncFeishuProjectContextInput['saveSnapshot'],
  snapshot: FeishuContextSnapshot
): Promise<void> {
  const chunks = splitUtf8(snapshot.content, maxSnapshotBytes);
  for (const [index, content] of chunks.entries()) {
    await saveSnapshot({
      ...snapshot,
      sourceRef: chunks.length === 1 ? snapshot.sourceRef : `${snapshot.sourceRef}:chunk:${index + 1}`,
      content
    });
  }
}

function splitUtf8(content: string, limitBytes: number): string[] {
  const chunks: string[] = [];
  let current = '';
  let bytes = 0;
  for (const character of content) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (bytes > 0 && bytes + characterBytes > limitBytes) {
      chunks.push(current);
      current = '';
      bytes = 0;
    }
    current += character;
    bytes += characterBytes;
  }
  if (current) {
    chunks.push(current);
  }
  return chunks;
}

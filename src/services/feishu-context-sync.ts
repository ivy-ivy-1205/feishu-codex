const maxSnapshotBytes = 8 * 1024;
const mediaMessageTypes = new Set<FeishuContextMessage['messageType']>(['video', 'audio']);
export const approvedFeishuProjectContextChatId = 'oc_a84d5b6ca478220d0a37964b50776edb';

export interface FeishuContextMessage {
  messageId: string;
  messageType: 'text' | 'post' | 'file' | 'image' | 'video' | 'audio' | 'voice' | 'unknown';
  text: string | null;
  createdAt: string;
  senderId?: string | null;
  threadId?: string | null;
  rootId?: string | null;
  parentId?: string | null;
  edited?: boolean;
  deleted?: boolean;
}

export interface FeishuContextFile {
  messageId?: string;
  fileToken: string;
  title: string;
  mimeType: string;
  text: string | null;
}

export interface FeishuContextClient {
  listMessages(input: { chatId: string; cursor: string | null; since: Date; until?: Date }): Promise<FeishuContextPage>;
  listThreadMessages?(input: { threadId: string; cursor: string | null; since: Date; until?: Date }): Promise<FeishuContextPage>;
  listReferencedFiles(input: { chatId: string; messageIds: readonly string[] }): Promise<FeishuContextFile[]>;
}

export interface FeishuContextPage {
  messages: FeishuContextMessage[];
  nextCursor: string | null;
  gaps?: FeishuContextGap[];
}

export interface FeishuContextSnapshot {
  sourceKind: string;
  sourceRef: string;
  content: string;
}

export interface FeishuContextGap {
  code: 'MEDIA_SKIPPED' | 'IMAGE_SKIPPED' | 'MESSAGE_UNSUPPORTED' | 'MESSAGE_TEXT_UNAVAILABLE' | 'VOICE_TEXT_MISSING' | 'FILE_TEXT_UNREADABLE'
    | 'ROOT_PAGE_UNAVAILABLE' | 'THREAD_PAGE_UNAVAILABLE' | 'PAGINATION_CURSOR_REPEATED'
    | 'REFERENCED_FILES_UNAVAILABLE' | 'FILE_REFERENCE_UNAVAILABLE' | 'MESSAGE_DELETED' | 'MESSAGE_TIME_INVALID' | 'MESSAGE_INVALID';
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
  requestedRange: { since: string; until: string };
  coverage: { rootPages: number; threadPages: number; threadsDiscovered: number };
  coverageStatus: 'visible_range_exhausted' | 'partial';
  sourceCoverage: {
    messageIds: string[];
    fileTokens: string[];
    pages: Array<{ kind: 'root' | 'thread'; threadId: string | null; requestCursor: string | null; nextCursor: string | null; messageIds: string[]; status: 'read' | 'unavailable' | 'cursor_repeated'; observedMessageTimeRange: { earliest: string | null; latest: string | null } }>;
    observedMessageTimeRange: { earliest: string | null; latest: string | null };
    termination: 'next_cursor_null' | 'incomplete';
  };
  gaps: FeishuContextGap[];
}

export interface SyncFeishuProjectContextInput {
  chatId: string;
  approvedChatIds: readonly string[];
  since: Date;
  feishu: FeishuContextClient;
  saveSnapshot: (snapshot: FeishuContextSnapshot) => Promise<void>;
  saveMessage?: (message: FeishuContextMessage) => Promise<void>;
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
  if (
    chatId !== approvedFeishuProjectContextChatId
    || !input.approvedChatIds.some((approvedChatId) => approvedChatId.trim() === approvedFeishuProjectContextChatId)
  ) {
    throw new FeishuContextSyncError(chatId);
  }
  const capturedAt = (input.now ?? (() => new Date()))().toISOString();
  if (!(input.since instanceof Date) || !Number.isFinite(input.since.getTime()) || input.since.toISOString() > capturedAt) {
    throw new Error('FEISHU_HISTORY_RANGE_INVALID');
  }

  const gaps: FeishuContextGap[] = [];
  const messageIds: string[] = [];
  const fileTokens: string[] = [];
  const fileMessageIds: string[] = [];
  const pages: FeishuContextSyncReport['sourceCoverage']['pages'] = [];
  let earliestMessageTime: string | null = null;
  let latestMessageTime: string | null = null;
  const threads = new Set<string>();
  const seenMessages = new Set<string>();
  const coverage = { rootPages: 0, threadPages: 0, threadsDiscovered: 0 };
  let paginationIncomplete = false;
  let pagesRead = 0;
  let messagesRead = 0;
  let messagesStored = 0;
  let mediaSkipped = 0;
  let voiceTextMissing = 0;

  async function readPages(threadId: string | null): Promise<void> {
    let cursor: string | null = null;
    const visited = new Set<string | null>();
    const kind = threadId === null ? 'root' : 'thread';
    do {
      const requestCursor: string | null = cursor;
      const pageAudit: FeishuContextSyncReport['sourceCoverage']['pages'][number] = {
        kind, threadId, requestCursor, nextCursor: null, messageIds: [], status: 'read',
        observedMessageTimeRange: { earliest: null, latest: null }
      };
      pages.push(pageAudit);
      if (visited.has(cursor)) {
        pageAudit.status = 'cursor_repeated';
        paginationIncomplete = true;
        gaps.push({ code: 'PAGINATION_CURSOR_REPEATED', sourceRef: `feishu:chat:${chatId}:${kind}:${threadId ?? 'root'}`, reason: 'pagination repeated a previously requested cursor' });
        break;
      }
      visited.add(cursor);
      let page: FeishuContextPage;
      try {
        const window = { cursor: requestCursor, since: input.since, until: new Date(capturedAt) };
        if (threadId === null) page = await input.feishu.listMessages({ chatId, ...window });
        else {
          if (!input.feishu.listThreadMessages) throw new Error('thread reader unavailable');
          page = await input.feishu.listThreadMessages({ threadId, ...window });
        }
      } catch {
        pageAudit.status = 'unavailable';
        paginationIncomplete = true;
        gaps.push({ code: threadId === null ? 'ROOT_PAGE_UNAVAILABLE' : 'THREAD_PAGE_UNAVAILABLE', sourceRef: `feishu:chat:${chatId}:${kind}:${threadId ?? 'root'}`, reason: 'page unavailable; requested cursor retained in coverage' });
        break;
      }
      pagesRead += 1;
      if (kind === 'root') coverage.rootPages += 1; else coverage.threadPages += 1;
      pageAudit.nextCursor = page.nextCursor;
      pageAudit.messageIds = page.messages.map((message) => message.messageId);
      gaps.push(...(page.gaps ?? []));
      for (const message of page.messages) {
        if (message.threadId) threads.add(message.threadId);
        const sourceRef = messageSourceRef(chatId, message.messageId);
        const messageTime = normalizedIsoTime(message.createdAt);
        if (messageTime) {
          const range = pageAudit.observedMessageTimeRange;
          if (!range.earliest || messageTime < range.earliest) range.earliest = messageTime;
          if (!range.latest || messageTime > range.latest) range.latest = messageTime;
        }
        if (messageTime && (!earliestMessageTime || messageTime < earliestMessageTime)) {
          earliestMessageTime = messageTime;
        }
        if (messageTime && (!latestMessageTime || messageTime > latestMessageTime)) {
          latestMessageTime = messageTime;
        }
        if (seenMessages.has(message.messageId)) continue;
        seenMessages.add(message.messageId);
        if (!messageTime) {
          gaps.push({ code: 'MESSAGE_TIME_INVALID', sourceRef, reason: 'message timestamp is unavailable or invalid' });
          continue;
        }
        if (messageTime < input.since.toISOString() || messageTime > capturedAt) continue;
        messagesRead += 1;
        messageIds.push(message.messageId);
        if (message.deleted) {
          gaps.push({ code: 'MESSAGE_DELETED', sourceRef, reason: 'message was deleted; body not captured' });
          continue;
        }
        if (message.messageType === 'file') fileMessageIds.push(message.messageId);
        if (mediaMessageTypes.has(message.messageType)) {
          mediaSkipped += 1;
          gaps.push({ code: 'MEDIA_SKIPPED', sourceRef, reason: `${message.messageType} is skipped by policy` });
          continue;
        }
        if (message.messageType === 'image') {
          gaps.push({ code: 'IMAGE_SKIPPED', sourceRef, reason: 'image text extraction is not approved' });
          continue;
        }
        if (message.messageType === 'voice' && !readableText(message.text)) {
          voiceTextMissing += 1;
          gaps.push({ code: 'VOICE_TEXT_MISSING', sourceRef, reason: 'native voice message has no approved transcript text' });
          continue;
        }
        if ((message.messageType === 'text' || message.messageType === 'post') && !readableText(message.text)) {
          gaps.push({ code: 'MESSAGE_TEXT_UNAVAILABLE', sourceRef, reason: `${message.messageType} has no readable text` });
          continue;
        }
        if (['text', 'post', 'voice'].includes(message.messageType) && readableText(message.text)) {
          if (input.saveMessage) await input.saveMessage(message);
          else await saveContentChunks(input.saveSnapshot, {
            sourceKind: `feishu_${message.messageType}`,
            sourceRef,
            content: message.text!
          });
          messagesStored += 1;
          continue;
        }
        if (message.messageType === 'unknown') {
          gaps.push({ code: 'MESSAGE_UNSUPPORTED', sourceRef, reason: 'message type is unsupported' });
        }
      }
      cursor = page.nextCursor;
    } while (cursor !== null);
  }
  await readPages(null);
  for (const threadId of threads) await readPages(threadId);
  coverage.threadsDiscovered = threads.size;

  let filesRead = 0;
  let filesUnreadable = 0;
  if (messageIds.length > 0) {
    let files: FeishuContextFile[] = [];
    try { files = await input.feishu.listReferencedFiles({ chatId, messageIds }); }
    catch { gaps.push({ code: 'REFERENCED_FILES_UNAVAILABLE', sourceRef: `feishu:chat:${chatId}`, reason: 'referenced file listing unavailable' }); }
    for (const messageId of fileMessageIds) {
      if (!files.some((file) => file.messageId === messageId)) gaps.push({ code: 'FILE_REFERENCE_UNAVAILABLE',
        sourceRef: messageSourceRef(chatId, messageId), reason: 'file message has no traceable file reference metadata' });
    }
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
    requestedRange: { since: input.since.toISOString(), until: capturedAt },
    coverage,
    coverageStatus: gaps.length > 0 ? 'partial' : 'visible_range_exhausted',
    sourceCoverage: {
      messageIds,
      fileTokens,
      pages,
      observedMessageTimeRange: { earliest: earliestMessageTime, latest: latestMessageTime },
      termination: paginationIncomplete ? 'incomplete' : 'next_cursor_null'
    },
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
      requestedRange: report.requestedRange,
      coverage: report.coverage,
      coverageStatus: report.coverageStatus,
      messagesRead: report.messagesRead,
      filesRead: report.filesRead,
      sourceCoverage: report.sourceCoverage
    })
  });
  for (const [index, gap] of gaps.entries()) {
    await input.saveSnapshot({
      sourceKind: 'feishu_sync_gap',
      sourceRef: `${syncSourceRef}:gap:${gap.code}:${index + 1}`,
      content: JSON.stringify(gap)
    });
  }
  return report;
}

function readableText(value: string | null): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizedIsoTime(value: string): string | null {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
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

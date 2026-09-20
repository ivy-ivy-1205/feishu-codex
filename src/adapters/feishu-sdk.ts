import * as lark from '@larksuiteoapi/node-sdk';
import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import type { FeishuApiClient, FeishuApiRequestOptions } from './feishu.js';
import { matchFeishuSingleSpeakerSrtExport } from './minute-transcript-srt.js';
import {
  MinuteTranscriptParseError,
  parseMinuteTranscriptText
} from './minute-transcript-parser.js';
import type {
  FeishuContextClient,
  FeishuContextFile,
  FeishuContextMessage,
  FeishuContextPage
} from '../services/feishu-context-sync.js';
import { approvedFeishuProjectContextChatId, FeishuContextSyncError } from '../services/feishu-context-sync.js';

export interface FeishuSdkClientOptions {
  appId: string;
  appSecret: string;
}

export interface FeishuSdkClientLike {
  im: {
    message: {
      create(payload: {
        params: { receive_id_type: 'chat_id' };
        data: {
          receive_id: string;
          msg_type: 'text' | 'interactive';
          content: string;
        };
      }): Promise<unknown>;
    };
    v1?: {
      message: {
        list(payload: {
          params: {
            container_id_type: 'chat' | 'thread';
            container_id: string;
            page_size: number;
            page_token?: string;
            start_time: string;
            end_time?: string;
          };
        }): Promise<unknown>;
      };
    };
  };
  minutes: {
    v1: {
      minute: {
        get(payload: {
          path: { minute_token: string };
        }, options?: unknown): Promise<unknown>;
        subscription?(payload: {
          data: { event_type: string };
        }, options?: unknown): Promise<unknown>;
      };
      minuteTranscript: {
        get(payload: {
          path: { minute_token: string };
          params?: {
            need_speaker: boolean;
            need_timestamp: boolean;
            file_format: 'srt';
          };
        }, options?: unknown): Promise<unknown>;
      };
    };
  };
}

/**
 * Minimal official-SDK adapter for the explicit project-context sync boundary.
 * File bodies deliberately remain unavailable until an approved reader/parser is supplied;
 * the sync service records that access gap instead of calling it a complete file sync.
 */
export class FeishuSdkContextClient implements FeishuContextClient {
  readonly #sdkClient: FeishuSdkClientLike;
  readonly #filesByMessageId = new Map<string, FeishuContextFile[]>();
  readonly #discoveredThreadIds = new Set<string>();

  constructor(sdkClient: FeishuSdkClientLike) {
    this.#sdkClient = sdkClient;
  }

  async listMessages(input: { chatId: string; cursor: string | null; since: Date; until?: Date }) {
    if (input.chatId !== approvedFeishuProjectContextChatId) throw new FeishuContextSyncError(input.chatId);
    return this.#listPage('chat', input.chatId, input);
  }

  async listThreadMessages(input: { threadId: string; cursor: string | null; since: Date; until?: Date }) {
    // A thread is authorized only by discovery within this approved group client.
    if (!this.#discoveredThreadIds.has(input.threadId)) throw new Error('FEISHU_THREAD_NOT_DISCOVERED');
    return this.#listPage('thread', input.threadId, input);
  }

  async #listPage(containerType: 'chat' | 'thread', containerId: string, input: { cursor: string | null; since: Date; until?: Date }): Promise<FeishuContextPage> {
    if (!this.#sdkClient.im.v1) {
      throw new Error('Feishu SDK context message API is unavailable');
    }
    const response = await this.#sdkClient.im.v1.message.list({
      params: {
        container_id_type: containerType,
        container_id: containerId,
        page_size: 50,
        ...(input.cursor ? { page_token: input.cursor } : {}),
        start_time: String(Math.floor(input.since.getTime() / 1_000)),
        ...(input.until ? { end_time: String(Math.ceil(input.until.getTime() / 1_000)) } : {})
      }
    });
    if (isRecord(response) && response.code !== undefined && response.code !== 0) throw new Error('FEISHU_HISTORY_API_ERROR');
    const data = responseData(response);
    if (!isRecord(data) || !Array.isArray(data.items)) throw new Error('FEISHU_HISTORY_PAGE_INVALID');
    const record = data;
    const items = data.items as unknown[];
    const hasCursor = typeof record.page_token === 'string' && record.page_token.trim().length > 0;
    const tokenTypeValid = record.page_token === undefined || typeof record.page_token === 'string';
    const paginationStatus = record.has_more === false && tokenTypeValid ? 'exhausted'
      : record.has_more === true && hasCursor ? 'more' : 'invalid';
    const nextCursor = paginationStatus === 'more' ? record.page_token as string : null;
    const messages = items.map(toContextMessage).filter((message): message is FeishuContextMessage => message !== null);
    for (const item of items) {
      const parsed = toContextMessage(item);
      if (parsed) {
        this.#filesByMessageId.set(parsed.messageId, extractReferencedFiles(item));
        if (parsed.threadId) this.#discoveredThreadIds.add(parsed.threadId);
      }
    }
    return {
      messages,
      nextCursor,
      paginationStatus,
      gaps: [...items.flatMap((item, index) => toContextMessage(item) ? [] : [{
        code: 'MESSAGE_INVALID' as const,
        sourceRef: `feishu:${containerType}:${containerId}:page:${input.cursor ?? 'first'}:item:${index}`,
        reason: 'message metadata unavailable or invalid'
      }]), ...(paginationStatus === 'invalid' ? [{
        code: 'PAGINATION_STATE_INVALID' as const,
        sourceRef: `feishu:${containerType}:${containerId}:page:${input.cursor ?? 'first'}`,
        reason: 'pagination requires explicit boolean has_more and a valid next cursor when more pages exist'
      }] : [])]
    };
  }

  async listReferencedFiles(input: { chatId: string; messageIds: readonly string[] }): Promise<FeishuContextFile[]> {
    if (input.chatId !== approvedFeishuProjectContextChatId) throw new FeishuContextSyncError(input.chatId);
    return input.messageIds.flatMap((messageId) => this.#filesByMessageId.get(messageId) ?? []);
  }
}

export interface FeishuSdkApiClientOptions {
  sdkClient: FeishuSdkClientLike;
  withUserAccessToken?: (token: string) => unknown;
}

export function createFeishuSdkClient(options: FeishuSdkClientOptions): FeishuSdkClientLike {
  return new lark.Client({
    appId: options.appId,
    appSecret: options.appSecret,
    appType: lark.AppType.SelfBuild,
    domain: lark.Domain.Feishu,
    logger: silentLogger
  }) as FeishuSdkClientLike;
}

export class FeishuSdkApiClient implements FeishuApiClient {
  readonly #sdkClient: FeishuSdkClientLike;
  readonly #withUserAccessToken: (token: string) => unknown;

  constructor(options: FeishuSdkApiClientOptions) {
    this.#sdkClient = options.sdkClient;
    this.#withUserAccessToken = options.withUserAccessToken ?? lark.withUserAccessToken;
  }

  async getMinuteBasicInfo(
    minuteId: string,
    options?: FeishuApiRequestOptions
  ): Promise<unknown> {
    const payload = {
      path: { minute_token: minuteId.trim() }
    };
    const requestOptions = this.#requestOptions(options);
    const response = requestOptions
      ? await this.#sdkClient.minutes.v1.minute.get(payload, requestOptions)
      : await this.#sdkClient.minutes.v1.minute.get(payload);
    return normalizeMinuteBasicInfo(responseData(response));
  }

  async exportMinuteTranscript(
    minuteId: string,
    options?: FeishuApiRequestOptions
  ): Promise<unknown[]> {
    const payload = {
      path: { minute_token: minuteId.trim() }
    };
    const requestOptions = this.#requestOptions(options);
    const response = requestOptions
      ? await this.#sdkClient.minutes.v1.minuteTranscript.get(payload, requestOptions)
      : await this.#sdkClient.minutes.v1.minuteTranscript.get(payload);
    if (isReadableStreamResponse(response)) {
      const raw = await readUtf8(response.getReadableStream());
      try {
        return parseMinuteTranscriptText(raw);
      } catch (error) {
        if (!(error instanceof MinuteTranscriptParseError)) {
          throw error;
        }
        const srtPayload = {
          path: { minute_token: minuteId.trim() },
          params: {
            need_speaker: true,
            need_timestamp: true,
            file_format: 'srt' as const
          }
        };
        const srtResponse = requestOptions
          ? await this.#sdkClient.minutes.v1.minuteTranscript.get(srtPayload, requestOptions)
          : await this.#sdkClient.minutes.v1.minuteTranscript.get(srtPayload);
        if (!isReadableStreamResponse(srtResponse)) {
          throw error;
        }
        const srtRaw = await readUtf8(srtResponse.getReadableStream());
        if (!matchFeishuSingleSpeakerSrtExport(srtRaw)) {
          throw error;
        }
        return parseMinuteTranscriptText(srtRaw, {
          speakerBoundaryMode: 'verified_single_speaker_srt'
        });
      }
    }
    const data = responseData(response);
    return Array.isArray(data) ? data : [];
  }

  async sendTextMessage(input: { chatId: string; text: string; idempotencyKey?: string }): Promise<{ messageId: string }> {
    const response = await this.#sdkClient.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: input.chatId,
        msg_type: 'text',
        content: JSON.stringify({ text: input.text }),
        ...(input.idempotencyKey ? { uuid: createHash('sha256').update(input.idempotencyKey).digest('hex').slice(0,32) } : {})
      }
    });
    const messageId = extractMessageId(response);
    if (!messageId) {
      throw new Error('Feishu SDK sendTextMessage did not return a message ID');
    }
    return { messageId };
  }

  async sendInteractiveMessage(input: {
    chatId: string;
    card: Record<string, unknown>;
    idempotencyKey?: string;
  }): Promise<{ messageId: string }> {
    const response = await this.#sdkClient.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: input.chatId,
        msg_type: 'interactive',
        content: JSON.stringify(input.card),
        ...(input.idempotencyKey ? { uuid: createHash('sha256').update(input.idempotencyKey).digest('hex').slice(0,32) } : {})
      }
    });
    const messageId = extractMessageId(response);
    if (!messageId) {
      throw new Error('Feishu SDK sendInteractiveMessage did not return a message ID');
    }
    return { messageId };
  }

  #requestOptions(options?: FeishuApiRequestOptions): unknown {
    const userAccessToken = options?.userAccessToken?.trim();
    return userAccessToken ? this.#withUserAccessToken(userAccessToken) : undefined;
  }
}

async function readUtf8(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8'));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function responseData(response: unknown): unknown {
  if (isRecord(response) && 'data' in response) {
    return response.data;
  }
  return response;
}

function normalizeMinuteBasicInfo(data: unknown): unknown {
  if (!isRecord(data)) {
    return data;
  }
  const minute = isRecord(data.minute) ? data.minute : data;
  if (
    typeof minute.title === 'string' &&
    typeof minute.create_time === 'string' &&
    typeof minute.duration === 'string'
  ) {
    const startedAtMs = parseFeishuTimestampMs(minute.create_time);
    const durationMs = Number(minute.duration);
    if (startedAtMs !== null && Number.isFinite(durationMs) && durationMs >= 0) {
      return {
        title: minute.title,
        startedAt: new Date(startedAtMs).toISOString(),
        endedAt: new Date(startedAtMs + durationMs).toISOString()
      };
    }
  }
  return data;
}

function parseFeishuTimestampMs(value: string): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }
  return value.trim().length <= 10 ? parsed * 1_000 : parsed;
}

function extractMessageId(response: unknown): string {
  const data = responseData(response);
  if (!isRecord(data)) {
    return '';
  }
  if (typeof data.message_id === 'string') {
    return data.message_id.trim();
  }
  if (isRecord(data.message) && typeof data.message.message_id === 'string') {
    return data.message.message_id.trim();
  }
  return '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function toContextMessage(value: unknown): FeishuContextMessage | null {
  if (!isRecord(value) || typeof value.message_id !== 'string' || !value.message_id.trim() || typeof value.msg_type !== 'string'
    || (value.chat_id !== undefined && value.chat_id !== approvedFeishuProjectContextChatId)) {
    return null;
  }
  const messageType = normalizeContextMessageType(value.msg_type);
  const body = isRecord(value.body) ? value.body : {};
  const content = typeof body.content === 'string' ? parseMessageText(body.content, messageType) : null;
  const createdAtMs = typeof value.create_time === 'string'
    ? parseFeishuTimestampMs(value.create_time)
    : null;
  const createdAt = createdAtMs !== null && Number.isFinite(new Date(createdAtMs).getTime()) ? new Date(createdAtMs).toISOString() : '';
  return {
    messageId: value.message_id,
    messageType,
    text: content,
    createdAt,
    senderId: isRecord(value.sender) && value.sender.id_type === 'open_id' && typeof value.sender.id === 'string' ? value.sender.id : null,
    senderType: isRecord(value.sender) && (value.sender.sender_type === 'user' || value.sender.sender_type === 'app') ? value.sender.sender_type : 'unknown',
    threadId: optionalId(value.thread_id), rootId: optionalId(value.root_id), parentId: optionalId(value.parent_id),
    edited: value.updated === true, deleted: value.deleted === true
  };
}

function optionalId(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeContextMessageType(value: string): FeishuContextMessage['messageType'] {
  if (value === 'audio') return 'voice';
  if (value === 'media') return 'video';
  return ['text', 'post', 'file', 'image', 'video', 'audio', 'voice'].includes(value)
    ? value as FeishuContextMessage['messageType']
    : 'unknown';
}

function parseMessageText(content: string, messageType: FeishuContextMessage['messageType']): string | null {
  try {
    const parsed = JSON.parse(content);
    if (isRecord(parsed) && typeof parsed.text === 'string') {
      return parsed.text;
    }
    if (messageType === 'post' && isRecord(parsed)) {
      return extractPostText(parsed);
    }
  } catch {
    // Post/file message content is not guaranteed to be JSON text.
  }
  return null;
}

function extractPostText(post: Record<string, unknown>): string | null {
  const locale = Array.isArray(post.content)
    ? post
    : isRecord(post.zh_cn) ? post.zh_cn : Object.values(post).find(isRecord);
  if (!locale) {
    return null;
  }
  const lines: string[] = [];
  if (typeof locale.title === 'string' && locale.title.trim()) {
    lines.push(locale.title.trim());
  }
  if (Array.isArray(locale.content)) {
    for (const paragraph of locale.content) {
      const fragments = collectPostText(paragraph);
      if (fragments.length > 0) {
        lines.push(fragments.join(''));
      }
    }
  }
  const text = lines.join('\n').trim();
  return text || null;
}

function collectPostText(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(collectPostText);
  }
  if (!isRecord(value)) {
    return [];
  }
  return typeof value.text === 'string' && value.text.trim() ? [value.text] : [];
}

function extractReferencedFiles(value: unknown): FeishuContextFile[] {
  if (!isRecord(value) || !isRecord(value.body) || typeof value.body.content !== 'string') {
    return [];
  }
  // Native voice/media are handled by message policy; do not reinterpret their resources as files.
  if (['audio', 'voice', 'media', 'video'].includes(String(value.msg_type))) return [];
  try {
    const content = JSON.parse(value.body.content);
    if (!isRecord(content)) return [];
    const files: FeishuContextFile[] = [];
    const messageId = typeof value.message_id === 'string' ? value.message_id : undefined;
    if (typeof content.file_key === 'string' && content.file_key.trim()) {
      const title = typeof content.file_name === 'string' ? content.file_name : content.file_key;
      files.push({ messageId, fileToken: content.file_key, title,
        mimeType: typeof content.mime_type === 'string' ? content.mime_type : inferFileMime(title), text: null });
    }
    const links = collectStringValues(content).flatMap((text) => [...text.matchAll(/https:\/\/[a-z\d.-]+\/(docx|docs|wiki|sheets|file|base)\/([a-z\d_-]+)/giu)]);
    for (const [url, type, token] of links) {
      const host = new URL(url).hostname;
      if (!host.endsWith('.feishu.cn') && !host.endsWith('.larksuite.com')) continue;
      if (!files.some((file) => file.fileToken === token)) files.push({ messageId, fileToken: token,
        title: `${type} reference`, mimeType: `application/vnd.feishu.${type}`, text: null });
    }
    return files;
  } catch {
    return [];
  }
}

function inferFileMime(title: string): string {
  if (/\.(mp3|wav|m4a|aac|ogg|flac|opus)$/iu.test(title)) return 'audio/unknown';
  if (/\.(mp4|mov|webm|avi|mkv)$/iu.test(title)) return 'video/unknown';
  return 'application/octet-stream';
}

function collectStringValues(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(collectStringValues);
  if (isRecord(value)) return Object.values(value).flatMap(collectStringValues);
  return [];
}

function isReadableStreamResponse(value: unknown): value is {
  getReadableStream(): Readable;
} {
  return isRecord(value) && typeof value.getReadableStream === 'function';
}

const silentLogger = {
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
  trace: () => undefined
};

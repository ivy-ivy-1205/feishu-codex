import * as lark from '@larksuiteoapi/node-sdk';
import type { Readable } from 'node:stream';
import type { FeishuApiClient, FeishuApiRequestOptions } from './feishu.js';
import { parseMinuteTranscriptStream } from './minute-transcript-parser.js';
import type {
  FeishuContextClient,
  FeishuContextFile,
  FeishuContextMessage
} from '../services/feishu-context-sync.js';

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
            container_id_type: 'chat';
            container_id: string;
            page_size: number;
            page_token?: string;
            start_time: string;
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

  constructor(sdkClient: FeishuSdkClientLike) {
    this.#sdkClient = sdkClient;
  }

  async listMessages(input: { chatId: string; cursor: string | null; since: Date }): Promise<{
    messages: FeishuContextMessage[];
    nextCursor: string | null;
  }> {
    if (!this.#sdkClient.im.v1) {
      throw new Error('Feishu SDK context message API is unavailable');
    }
    const response = await this.#sdkClient.im.v1.message.list({
      params: {
        container_id_type: 'chat',
        container_id: input.chatId,
        page_size: 50,
        ...(input.cursor ? { page_token: input.cursor } : {}),
        start_time: String(Math.floor(input.since.getTime() / 1_000))
      }
    });
    const data = responseData(response);
    const record = isRecord(data) ? data : {};
    const items = Array.isArray(record.items) ? record.items : [];
    const messages = items.map(toContextMessage).filter((message): message is FeishuContextMessage => message !== null);
    for (const item of items) {
      const parsed = toContextMessage(item);
      if (parsed) {
        this.#filesByMessageId.set(parsed.messageId, extractReferencedFiles(item));
      }
    }
    return {
      messages,
      nextCursor: typeof record.page_token === 'string' && record.page_token.trim() ? record.page_token : null
    };
  }

  async listReferencedFiles(input: { chatId: string; messageIds: readonly string[] }): Promise<FeishuContextFile[]> {
    void input.chatId;
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
      return parseMinuteTranscriptStream(response.getReadableStream());
    }
    const data = responseData(response);
    return Array.isArray(data) ? data : [];
  }

  async sendTextMessage(input: { chatId: string; text: string }): Promise<{ messageId: string }> {
    const response = await this.#sdkClient.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: input.chatId,
        msg_type: 'text',
        content: JSON.stringify({ text: input.text })
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
  }): Promise<{ messageId: string }> {
    const response = await this.#sdkClient.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: input.chatId,
        msg_type: 'interactive',
        content: JSON.stringify(input.card)
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
  if (!isRecord(value) || typeof value.message_id !== 'string' || typeof value.msg_type !== 'string') {
    return null;
  }
  const messageType = normalizeContextMessageType(value.msg_type);
  const body = isRecord(value.body) ? value.body : {};
  const content = typeof body.content === 'string' ? parseMessageText(body.content, messageType) : null;
  const createdAtMs = typeof value.create_time === 'string'
    ? parseFeishuTimestampMs(value.create_time)
    : null;
  const createdAt = new Date(createdAtMs ?? 0).toISOString();
  return {
    messageId: value.message_id,
    messageType,
    text: content,
    createdAt
  };
}

function normalizeContextMessageType(value: string): FeishuContextMessage['messageType'] {
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
  const locale = isRecord(post.zh_cn)
    ? post.zh_cn
    : Object.values(post).find(isRecord);
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
  try {
    const content = JSON.parse(value.body.content);
    if (!isRecord(content) || typeof content.file_key !== 'string') {
      return [];
    }
    return [{
      fileToken: content.file_key,
      title: typeof content.file_name === 'string' ? content.file_name : content.file_key,
      mimeType: typeof content.mime_type === 'string' ? content.mime_type : 'application/octet-stream',
      text: null
    }];
  } catch {
    return [];
  }
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

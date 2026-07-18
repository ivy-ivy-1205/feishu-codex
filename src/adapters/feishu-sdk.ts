import * as lark from '@larksuiteoapi/node-sdk';
import type { Readable } from 'node:stream';
import type { FeishuApiClient } from './feishu.js';
import { parseMinuteTranscriptStream } from './minute-transcript-parser.js';

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
          msg_type: 'text';
          content: string;
        };
      }): Promise<unknown>;
    };
  };
  minutes: {
    v1: {
      minute: {
        get(payload: {
          path: { minute_token: string };
        }): Promise<unknown>;
      };
      minuteTranscript: {
        get(payload: {
          path: { minute_token: string };
        }): Promise<unknown>;
      };
    };
  };
}

export interface FeishuSdkApiClientOptions {
  sdkClient: FeishuSdkClientLike;
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

  constructor(options: FeishuSdkApiClientOptions) {
    this.#sdkClient = options.sdkClient;
  }

  async getMinuteBasicInfo(minuteId: string): Promise<unknown> {
    const response = await this.#sdkClient.minutes.v1.minute.get({
      path: { minute_token: minuteId.trim() }
    });
    return responseData(response);
  }

  async exportMinuteTranscript(minuteId: string): Promise<unknown[]> {
    const response = await this.#sdkClient.minutes.v1.minuteTranscript.get({
      path: { minute_token: minuteId.trim() }
    });
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
}

function responseData(response: unknown): unknown {
  if (isRecord(response) && 'data' in response) {
    return response.data;
  }
  return response;
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

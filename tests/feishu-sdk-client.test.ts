import { describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import {
  createFeishuSdkClient,
  FeishuSdkApiClient,
  type FeishuSdkClientLike
} from '../src/adapters/feishu-sdk.js';

describe('FeishuSdkApiClient', () => {
  it('creates an official SDK client for a self-built Feishu app without exposing secrets', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const created = createFeishuSdkClient({
      appId: 'cli_test_app',
      appSecret: 'secret-value'
    });

    expect(created).toBeInstanceOf(Object);
    expect(info).not.toHaveBeenCalled();
    info.mockRestore();
  });

  it('sends text messages through im.message.create with chat_id receive type', async () => {
    const calls: unknown[] = [];
    const client = new FeishuSdkApiClient({
      sdkClient: createFakeSdkClient({
        messageId: 'om_sdk_message',
        calls
      })
    });

    await expect(client.sendTextMessage({
      chatId: 'oc_private_chat',
      text: '会议总结'
    })).resolves.toEqual({ messageId: 'om_sdk_message' });

    expect(calls).toEqual([{
      method: 'im.message.create',
      payload: {
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: 'oc_private_chat',
          msg_type: 'text',
          content: JSON.stringify({ text: '会议总结' })
        }
      }
    }]);
  });

  it('sends interactive cards through im.message.create', async () => {
    const calls: unknown[] = [];
    const client = new FeishuSdkApiClient({
      sdkClient: createFakeSdkClient({
        messageId: 'om_sdk_card',
        calls
      })
    });
    const card = {
      header: {
        title: {
          tag: 'plain_text',
          content: '需要重新授权'
        }
      },
      elements: []
    };

    await expect(client.sendInteractiveMessage({
      chatId: 'oc_private_chat',
      card
    })).resolves.toEqual({ messageId: 'om_sdk_card' });

    expect(calls).toEqual([{
      method: 'im.message.create',
      payload: {
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: 'oc_private_chat',
          msg_type: 'interactive',
          content: JSON.stringify(card)
        }
      }
    }]);
  });

  it('reads minute basic info and transcript through official minutes APIs', async () => {
    const calls: unknown[] = [];
    const client = new FeishuSdkApiClient({
      sdkClient: createFakeSdkClient({
        minute: { title: 'AI Native 周会' },
        transcript: [{ speakerName: 'Ivy', text: '确认 Webhook' }],
        calls
      })
    });

    await expect(client.getMinuteBasicInfo('min_token_1'))
      .resolves.toEqual({ title: 'AI Native 周会' });
    await expect(client.exportMinuteTranscript('min_token_1'))
      .resolves.toEqual([{ speakerName: 'Ivy', text: '确认 Webhook' }]);

    expect(calls).toEqual([
      {
        method: 'minutes.v1.minute.get',
        payload: { path: { minute_token: 'min_token_1' } }
      },
      {
        method: 'minutes.v1.minuteTranscript.get',
        payload: { path: { minute_token: 'min_token_1' } }
      }
    ]);
  });

  it('uses a user access token for minute reads when one is provided', async () => {
    const calls: unknown[] = [];
    const client = new FeishuSdkApiClient({
      sdkClient: createFakeSdkClient({
        minute: { title: 'Ivy 的自动妙记' },
        transcript: [{ speakerName: 'Ivy', text: '只授权一次后自动读取' }],
        calls
      }),
      withUserAccessToken: (token) => ({ userAccessToken: token })
    });

    await client.getMinuteBasicInfo('min_token_user', {
      userAccessToken: 'u-ivy-token'
    });
    await client.exportMinuteTranscript('min_token_user', {
      userAccessToken: 'u-ivy-token'
    });

    expect(calls).toEqual([
      {
        method: 'minutes.v1.minute.get',
        payload: { path: { minute_token: 'min_token_user' } },
        options: { userAccessToken: 'u-ivy-token' }
      },
      {
        method: 'minutes.v1.minuteTranscript.get',
        payload: { path: { minute_token: 'min_token_user' } },
        options: { userAccessToken: 'u-ivy-token' }
      }
    ]);
  });

  it('normalizes real Feishu minute basic info fields from SDK responses', async () => {
    const client = new FeishuSdkApiClient({
      sdkClient: createFakeSdkClient({
        minute: {
          minute: {
            title: '真实妙记',
            create_time: '1783425868000',
            duration: '3362000'
          }
        }
      })
    });

    await expect(client.getMinuteBasicInfo('min_token_1')).resolves.toEqual({
      title: '真实妙记',
      startedAt: new Date(1_783_425_868_000).toISOString(),
      endedAt: new Date(1_783_425_868_000 + 3_362_000).toISOString()
    });
  });

  it('parses SDK transcript readable streams into internal transcript segments', async () => {
    const client = new FeishuSdkApiClient({
      sdkClient: createFakeSdkClient({
        transcriptStream: Readable.from([JSON.stringify([{
          speakerName: 'Ivy',
          startMs: 0,
          endMs: 1_000,
          text: '逐字稿来自 SDK stream'
        }])])
      })
    });

    await expect(client.exportMinuteTranscript('min_token_1')).resolves.toEqual([{
      speakerName: 'Ivy',
      startMs: 0,
      endMs: 1_000,
      text: '逐字稿来自 SDK stream'
    }]);
  });

  it('requires a real message ID when sending text', async () => {
    const client = new FeishuSdkApiClient({
      sdkClient: createFakeSdkClient({
        messageId: ''
      })
    });

    await expect(client.sendTextMessage({
      chatId: 'oc_private_chat',
      text: '会议总结'
    })).rejects.toThrow(/message id/i);
  });
});

function createFakeSdkClient(options: {
  messageId?: string;
  minute?: unknown;
  transcript?: unknown;
  transcriptStream?: Readable;
  calls?: unknown[];
}): FeishuSdkClientLike {
  return {
    im: {
      message: {
        async create(payload) {
          options.calls?.push({ method: 'im.message.create', payload });
          return { data: { message_id: options.messageId } };
        }
      }
    },
    minutes: {
      v1: {
        minute: {
          async subscription(payload) {
            options.calls?.push({ method: 'minutes.v1.minute.subscription', payload });
            return { code: 0 };
          },
          async get(payload, requestOptions) {
            options.calls?.push({
              method: 'minutes.v1.minute.get',
              payload,
              ...(requestOptions ? { options: requestOptions } : {})
            });
            return { data: options.minute };
          }
        },
        minuteTranscript: {
          async get(payload, requestOptions) {
            options.calls?.push({
              method: 'minutes.v1.minuteTranscript.get',
              payload,
              ...(requestOptions ? { options: requestOptions } : {})
            });
            if (options.transcriptStream) {
              return {
                getReadableStream() {
                  return options.transcriptStream!;
                }
              };
            }
            return { data: options.transcript };
          }
        }
      }
    }
  };
}

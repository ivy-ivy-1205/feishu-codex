import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  createFeishuSdkClient,
  FeishuSdkContextClient,
  FeishuSdkApiClient,
  type FeishuSdkClientLike
} from '../src/adapters/feishu-sdk.js';
import { FeishuMinutesReaderAdapter } from '../src/adapters/feishu.js';
import { captureMinuteTranscriptSource } from '../src/services/context-source-capture.js';
import { validateTranscriptEvidenceLocator } from '../src/services/context-evidence-locator.js';

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

  it('passes a real numbered-speaker stream through the production reader boundary', async () => {
    const apiClient = new FeishuSdkApiClient({
      sdkClient: createFakeSdkClient({
        minute: {
          minute: {
            title: '单人测试会议',
            create_time: '1786095041000',
            duration: '32000'
          }
        },
        transcriptStream: Readable.from([[
          '2026-08-07 17:30:41 CST|32秒',
          '',
          '关键词:',
          '飞书、企业',
          '',
          '说话人 1',
          '第一行',
          '第二行'
        ].join('\n')])
      })
    });
    const reader = new FeishuMinutesReaderAdapter(apiClient);

    await expect(reader.getMinute('min_single_speaker')).resolves.toMatchObject({
      minuteId: 'min_single_speaker',
      title: '单人测试会议',
      transcript: [{
        speakerName: '说话人 1',
        startMs: 0,
        endMs: 1,
        text: '第一行\n第二行'
      }]
    });
  });

  it('falls back from real headerless TXT to verified single-speaker SRT at the production reader boundary', async () => {
    const calls: unknown[] = [];
    const apiClient = new FeishuSdkApiClient({
      sdkClient: createFakeSdkClient({
        minute: {
          minute: {
            title: '去标识化测试会议',
            create_time: '1786095047000',
            duration: '29000'
          }
        },
        transcriptStreams: [
          Readable.from([[
            '2026-08-07 21:52:47 CST|29秒', '', '关键词:', 'Context、审核、来源', '',
            '0:00', '第一行：候选 Context 必须由 Ivy 审核。'
          ].join('\n')]),
          Readable.from([[
            '', '1', '00:00:00,000 --> 00:00:04,250',
            'Ivy: 第一行：候选 Context 必须由 Ivy 审核。',
            '第二行：批准后才能成为正式 Context。', '',
            '2', '00:00:04,250 --> 00:00:09,000', 'Ivy: 后续决定。', ''
          ].join('\n')])
        ],
        calls
      })
    });
    const reader = new FeishuMinutesReaderAdapter(apiClient);

    const minute = await reader.getMinute('min_headerless_single');
    expect(minute).toMatchObject({
      minuteId: 'min_headerless_single',
      transcript: [
        {
          speakerName: '说话人 1', startMs: 0, endMs: 4_250,
          text: '第一行：候选 Context 必须由 Ivy 审核。\n第二行：批准后才能成为正式 Context。'
        },
        { speakerName: '说话人 1', startMs: 4_250, endMs: 9_000, text: '后续决定。' }
      ]
    });
    const captured = captureMinuteTranscriptSource(minute, new Date('2030-01-01T00:00:00.000Z'));
    const contentHash = createHash('sha256').update(captured.source.contentText).digest('hex');
    expect(() => validateTranscriptEvidenceLocator({
      sourceVersion: 1,
      contentHash,
      contentText: captured.source.contentText,
      metadata: captured.source.metadata
    }, '第二行：批准后才能成为正式 Context。', {
      segmentOrdinal: 0,
      sourceVersion: 1,
      contentHash,
      speakerName: '说话人 1',
      startMs: 0,
      endMs: 4_250
    })).not.toThrow();
    expect(calls.filter((call) => (call as { method?: string }).method ===
      'minutes.v1.minuteTranscript.get')).toEqual([
      {
        method: 'minutes.v1.minuteTranscript.get',
        payload: { path: { minute_token: 'min_headerless_single' } }
      },
      {
        method: 'minutes.v1.minuteTranscript.get',
        payload: {
          path: { minute_token: 'min_headerless_single' },
          params: { need_speaker: true, need_timestamp: true, file_format: 'srt' }
        }
      }
    ]);
  });

  it.each([
    ['an Ivy meeting title', 'Ivy的视频会议'],
    ['a one-participant-looking title', '1人测试会议']
  ])('does not use %s to classify generic headerless prose', async (_label, title) => {
    const apiClient = new FeishuSdkApiClient({
      sdkClient: createFakeSdkClient({
        minute: {
          minute: { title, create_time: '1786095047000', duration: '29000' }
        },
        transcriptStreams: [
          Readable.from([[
            '', '2026-08-07 21:52:47 CST|29秒', '关键词:', 'Context、审核', '普通无标题正文。'
          ].join('\n')]),
          Readable.from([[
            '1', '00:00:00,000 --> 00:00:04,250', 'Ivy: 第一段正文。', '',
            '2', '00:00:04,250 --> 00:00:09,000', 'James: 第二位发言。', ''
          ].join('\n')])
        ]
      })
    });

    await expect(new FeishuMinutesReaderAdapter(apiClient).getMinute('min_unverified'))
      .rejects.toMatchObject({ code: 'MINUTE_TRANSCRIPT_INVALID' });
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

  it('lists group context through the official SDK without reading file bodies', async () => {
    const calls: unknown[] = [];
    const context = new FeishuSdkContextClient(createFakeSdkClient({
      contextMessages: [{
        message_id: 'om_context_1',
        msg_type: 'text',
        create_time: '1780000000',
        body: { content: JSON.stringify({ text: '项目群上下文' }) }
      }],
      calls
    }));

    await expect(context.listMessages({
      chatId: 'oc_a84d5b6ca478220d0a37964b50776edb',
      cursor: null,
      since: new Date('2026-07-01T00:00:00.000Z')
    })).resolves.toMatchObject({
      messages: [{ messageId: 'om_context_1', messageType: 'text', text: '项目群上下文' }],
      nextCursor: null
    });
    expect(calls).toContainEqual({
      method: 'im.v1.message.list',
      payload: {
        params: {
          container_id_type: 'chat',
          container_id: 'oc_a84d5b6ca478220d0a37964b50776edb',
          page_size: 50,
          start_time: '1782864000'
        }
      }
    });
  });

  it('parses real 13-digit millisecond create_time values in group history', async () => {
    const context = new FeishuSdkContextClient(createFakeSdkClient({
      contextMessages: [{
        message_id: 'om_context_ms',
        msg_type: 'text',
        create_time: '1783425868000',
        body: { content: JSON.stringify({ text: '毫秒时间戳消息' }) }
      }]
    }));

    await expect(context.listMessages({
      chatId: 'oc_a84d5b6ca478220d0a37964b50776edb',
      cursor: null,
      since: new Date('2026-07-01T00:00:00.000Z')
    })).resolves.toMatchObject({
      messages: [{
        messageId: 'om_context_ms',
        createdAt: new Date(1_783_425_868_000).toISOString()
      }]
    });
  });

  it('extracts readable text from a realistic multilingual post body', async () => {
    const context = new FeishuSdkContextClient(createFakeSdkClient({
      contextMessages: [{
        message_id: 'om_post_1',
        msg_type: 'post',
        create_time: '1780000000',
        body: { content: JSON.stringify({
          zh_cn: {
            title: '项目更新',
            content: [
              [{ tag: 'text', text: 'OpenMontage B-roll 已完成。' }],
              [{ tag: 'a', text: '查看方案', href: 'https://example.test/plan' }]
            ]
          },
          en_us: { title: 'Project update', content: [[{ tag: 'text', text: 'English fallback' }]] }
        }) }
      }]
    }));

    await expect(context.listMessages({
      chatId: 'oc_a84d5b6ca478220d0a37964b50776edb',
      cursor: null,
      since: new Date('2026-07-01T00:00:00.000Z')
    })).resolves.toMatchObject({
      messages: [{ messageId: 'om_post_1', messageType: 'post', text: '项目更新\nOpenMontage B-roll 已完成。\n查看方案' }]
    });
  });
});

function createFakeSdkClient(options: {
  messageId?: string;
  minute?: unknown;
  transcript?: unknown;
  transcriptStream?: Readable;
  transcriptStreams?: Readable[];
  contextMessages?: unknown[];
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
      ,
      v1: {
        message: {
          async list(payload) {
            options.calls?.push({ method: 'im.v1.message.list', payload });
            return { data: { items: options.contextMessages ?? [] } };
          }
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
            const transcriptStream = options.transcriptStreams?.shift() ?? options.transcriptStream;
            if (transcriptStream) {
              return {
                getReadableStream() {
                  return transcriptStream;
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

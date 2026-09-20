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
  it('forwards stable bounded UUIDs for retryable founder deliveries', async () => {
    const calls:unknown[]=[];const client=new FeishuSdkApiClient({sdkClient:createFakeSdkClient({messageId:'om_retry',calls})});
    await client.sendTextMessage({chatId:'oc_group',text:'receipt',idempotencyKey:'founder-feedback:message-1'});
    await client.sendTextMessage({chatId:'oc_group',text:'receipt',idempotencyKey:'founder-feedback:message-1'});
    const values=calls as {payload:{data:{uuid?:string}}}[];
    expect(values[0]!.payload.data.uuid).toMatch(/^[a-f0-9]{32}$/);
    expect(values[1]!.payload.data.uuid).toBe(values[0]!.payload.data.uuid);
  });
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
      timingKind: 'media_offset',
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

  it('paginates a discovered thread and preserves sender, relation and edit/delete metadata', async () => {
    const calls: unknown[] = [];
    const sdk = createFakeSdkClient({ calls, contextMessages: [{
      message_id: 'om_reply', msg_type: 'text', create_time: '1783425868000',
      sender: { id: 'ou_ivy', id_type: 'open_id' }, thread_id: 'omt_1', root_id: 'om_root', parent_id: 'om_parent',
      updated: true, deleted: false, body: { content: JSON.stringify({ text: 'reply' }) }
    }] });
    const context = new FeishuSdkContextClient(sdk);
    await context.listMessages({ chatId: 'oc_a84d5b6ca478220d0a37964b50776edb', cursor: null, since: new Date('2026-07-01T00:00:00.000Z') });
    const page = await context.listThreadMessages({ threadId: 'omt_1', cursor: 'page2', since: new Date('2026-07-01T00:00:00.000Z') });
    expect(page.messages[0]).toMatchObject({ senderId: 'ou_ivy', threadId: 'omt_1', rootId: 'om_root', parentId: 'om_parent', edited: true, deleted: false });
    expect(calls).toContainEqual({ method: 'im.v1.message.list', payload: { params: {
      container_id_type: 'thread', container_id: 'omt_1', page_size: 50, page_token: 'page2', start_time: '1782864000'
    } } });
    await expect(context.listThreadMessages({ threadId: 'unknown-thread', cursor: null, since: new Date() })).rejects.toThrow();
  });

  it('rejects SDK error codes instead of returning an empty successful page', async () => {
    for (const response of [{ code: 999, msg: 'sensitive error' }]) {
      const sdk = createFakeSdkClient({});
      sdk.im.v1!.message.list = async () => response;
      await expect(new FeishuSdkContextClient(sdk).listMessages({ chatId: 'oc_a84d5b6ca478220d0a37964b50776edb', cursor: null, since: new Date() })).rejects.toThrow();
    }
  });

  it.each([
    {}, { has_more: 'false' }, { has_more: null }, { has_more: 0 }, { has_more: {} },
    { has_more: true }, { has_more: true, page_token: '' }, { has_more: true, page_token: '  ' },
    { has_more: true, page_token: 123 }, { has_more: false, page_token: 123 }
  ])('preserves a typed gap and readable items for invalid pagination fields %j', async (pagination) => {
    const sdk = createFakeSdkClient({});
    sdk.im.v1!.message.list = async () => ({ code: 0, data: { ...pagination, items: [{
      message_id: 'readable', msg_type: 'text', create_time: '1783425868000', body: { content: JSON.stringify({ text: 'keep current page' }) }
    }] } });
    const page = await new FeishuSdkContextClient(sdk).listMessages({ chatId: 'oc_a84d5b6ca478220d0a37964b50776edb', cursor: 'current', since: new Date() });
    expect(page).toMatchObject({ messages: [{ text: 'keep current page' }], nextCursor: null,
      paginationStatus: 'invalid', gaps: [{ code: 'PAGINATION_STATE_INVALID', sourceRef: 'feishu:chat:oc_a84d5b6ca478220d0a37964b50776edb:page:current' }] });
  });

  it.each([
    { has_more: false, expectedStatus: 'exhausted', expectedCursor: null },
    { has_more: true, page_token: 'next', expectedStatus: 'more', expectedCursor: 'next' }
  ])('uses only explicit valid pagination state $has_more', async ({ expectedStatus, expectedCursor, ...pagination }) => {
    const sdk = createFakeSdkClient({});
    sdk.im.v1!.message.list = async () => ({ code: 0, data: { ...pagination, items: [] } });
    const page = await new FeishuSdkContextClient(sdk).listMessages({ chatId: 'oc_a84d5b6ca478220d0a37964b50776edb', cursor: null, since: new Date() });
    expect(page).toMatchObject({ paginationStatus: expectedStatus, nextCursor: expectedCursor, gaps: [] });
  });

  it('rejects an unapproved group before SDK access and does not discover foreign-chat threads', async () => {
    const calls: unknown[] = [];
    const context = new FeishuSdkContextClient(createFakeSdkClient({ calls, contextMessages: [{
      message_id: 'foreign', chat_id: 'oc_private', msg_type: 'text', thread_id: 'foreign-thread', create_time: '1783425868000',
      body: { content: JSON.stringify({ text: 'must not capture' }) }
    }] }));
    await expect(context.listMessages({ chatId: 'oc_private', cursor: null, since: new Date() })).rejects.toMatchObject({ code: 'FEISHU_CHAT_NOT_APPROVED' });
    expect(calls).toHaveLength(0);
    const page = await context.listMessages({ chatId: 'oc_a84d5b6ca478220d0a37964b50776edb', cursor: null, since: new Date() });
    expect(page.messages).toEqual([]);
    expect(page.gaps).toEqual([expect.objectContaining({ code: 'MESSAGE_INVALID' })]);
    await expect(context.listThreadMessages({ threadId: 'foreign-thread', cursor: null, since: new Date() })).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });

  it('distinguishes native voice from audio attachments and records document references without downloading', async () => {
    const context = new FeishuSdkContextClient(createFakeSdkClient({ contextMessages: [
      { message_id: 'voice', msg_type: 'audio', create_time: '1783425868000', body: { content: JSON.stringify({ file_key: 'voice-key', duration: 1000 }) } },
      { message_id: 'video', msg_type: 'media', create_time: '1783425868000', body: { content: JSON.stringify({ file_key: 'video-key' }) } },
      { message_id: 'audio-file', msg_type: 'file', create_time: '1783425868000', body: { content: JSON.stringify({ file_key: 'audio-key', file_name: 'recording.mp3' }) } },
      { message_id: 'document', msg_type: 'text', create_time: '1783425868000', body: { content: JSON.stringify({ text: 'see https://example.feishu.cn/docx/DocToken1' }) } }
    ] }));
    const page = await context.listMessages({ chatId: 'oc_a84d5b6ca478220d0a37964b50776edb', cursor: null, since: new Date() });
    expect(page.messages.map((message) => message.messageType)).toEqual(['voice', 'video', 'file', 'text']);
    const files = await context.listReferencedFiles({ chatId: 'oc_a84d5b6ca478220d0a37964b50776edb', messageIds: ['voice', 'video', 'audio-file', 'document'] });
    expect(files).toEqual(expect.arrayContaining([
      expect.objectContaining({ fileToken: 'audio-key', mimeType: 'audio/unknown', text: null }),
      expect.objectContaining({ fileToken: 'DocToken1', mimeType: 'application/vnd.feishu.docx', text: null })
    ]));
    expect(files.some((file) => file.fileToken === 'voice-key')).toBe(false);
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

  it('extracts readable text from an unwrapped history post body', async () => {
    const context = new FeishuSdkContextClient(createFakeSdkClient({
      contextMessages: [{
        message_id: 'om_direct_post', msg_type: 'post', create_time: '1783425868000',
        body: { content: JSON.stringify({ title: '更新', content: [[{ tag: 'text', text: '已完成' }]] }) }
      }]
    }));
    const page = await context.listMessages({ chatId: 'oc_a84d5b6ca478220d0a37964b50776edb', cursor: null, since: new Date('2026-07-01T00:00:00.000Z') });
    expect(page.messages[0]).toMatchObject({ messageId: 'om_direct_post', messageType: 'post', text: '更新\n已完成' });
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
            return { data: { items: options.contextMessages ?? [], has_more: false } };
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

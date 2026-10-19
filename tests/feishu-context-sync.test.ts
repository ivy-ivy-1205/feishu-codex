import { describe, expect, it } from 'vitest';
import { syncFeishuProjectContext } from '../src/services/feishu-context-sync.js';

describe('syncFeishuProjectContext', () => {
  it.each(['root', 'thread'] as const)('never marks an invalid %s pagination state as exhausted', async (kind) => {
    const snapshots: Array<{ sourceKind: string; content: string }> = [];
    const invalidPage = {
      messages: [], nextCursor: null, paginationStatus: 'invalid' as const,
      gaps: [{ code: 'PAGINATION_STATE_INVALID' as const, sourceRef: `feishu:${kind}:current`, reason: 'missing explicit termination state' }]
    };
    const report = await syncFeishuProjectContext({
      chatId: 'oc_a84d5b6ca478220d0a37964b50776edb', approvedChatIds: ['oc_a84d5b6ca478220d0a37964b50776edb'],
      since: new Date('2026-08-31T00:00:00.000Z'), now: () => new Date('2026-09-20T00:00:00.000Z'),
      feishu: {
        async listMessages() { return kind === 'root' ? invalidPage : { messages: [{
          messageId: 'root', messageType: 'text', text: 'readable root', createdAt: '2026-09-01T00:00:00.000Z', threadId: 'thread1'
        }], nextCursor: null, paginationStatus: 'exhausted' }; },
        async listThreadMessages() { return invalidPage; },
        async listReferencedFiles() { return []; }
      }, saveSnapshot: async (snapshot) => { snapshots.push(snapshot); }
    });
    expect(report.coverageStatus).toBe('partial');
    expect(report.sourceCoverage.termination).toBe('incomplete');
    expect(report.sourceCoverage.pages.at(-1)).toMatchObject({ kind, status: 'pagination_invalid', requestCursor: null, nextCursor: null });
    expect(snapshots.find((snapshot) => snapshot.sourceKind === 'feishu_sync_coverage')?.content).toContain('"termination":"incomplete"');
    expect(snapshots.find((snapshot) => snapshot.sourceKind === 'feishu_sync_gap')?.content).toContain('PAGINATION_STATE_INVALID');
  });

  it('stores approved voice transcript text and records missing file reference metadata', async () => {
    const snapshots: string[] = [];
    const report = await syncFeishuProjectContext({
      chatId: 'oc_a84d5b6ca478220d0a37964b50776edb', approvedChatIds: ['oc_a84d5b6ca478220d0a37964b50776edb'],
      since: new Date('2026-08-31T00:00:00.000Z'), now: () => new Date('2026-09-20T00:00:00.000Z'),
      feishu: {
        async listMessages() { return { messages: [
          { messageId: 'voice', messageType: 'voice', text: 'approved transcript', createdAt: '2026-09-01T00:00:00.000Z' },
          { messageId: 'file', messageType: 'file', text: null, createdAt: '2026-09-01T00:00:00.000Z' }
        ], nextCursor: null }; },
        async listReferencedFiles() { return []; }
      }, saveSnapshot: async (snapshot) => { snapshots.push(snapshot.content); }
    });
    expect(snapshots).toContain('approved transcript');
    expect(report.gaps.map((gap) => gap.code)).toContain('FILE_REFERENCE_UNAVAILABLE');
  });

  it('stores text and document snippets from the approved group and skips video/audio', async () => {
    const snapshots: Array<{ sourceKind: string; sourceRef: string; content: string }> = [];

    const report = await syncFeishuProjectContext({
      chatId: 'oc_a84d5b6ca478220d0a37964b50776edb',
      approvedChatIds: ['oc_a84d5b6ca478220d0a37964b50776edb'],
      since: new Date('2026-07-01T00:00:00.000Z'),
      feishu: {
        async listMessages() {
          return {
            messages: [
              { messageId: 'om_text_1', messageType: 'text', text: 'OpenMontage B-roll 需要优化。', createdAt: '2026-07-30T07:00:00.000Z' },
              { messageId: 'om_video_1', messageType: 'video', text: null, createdAt: '2026-07-30T07:01:00.000Z' }
            ],
            nextCursor: null
          };
        },
        async listReferencedFiles() {
          return [{
            fileToken: 'doc_1',
            title: 'FeishuAdaptor 方案',
            mimeType: 'application/vnd.feishu.docx',
            text: 'Project Registry 是下一阶段。'
          }];
        }
      },
      saveSnapshot: async (snapshot) => {
        snapshots.push(snapshot);
      }
    });

    expect(report).toMatchObject({
      chatId: 'oc_a84d5b6ca478220d0a37964b50776edb',
      messagesRead: 2,
      mediaSkipped: 1,
      filesRead: 1
    });
    expect(snapshots.map((snapshot) => snapshot.content).join('\n')).toContain('OpenMontage B-roll');
    expect(snapshots.map((snapshot) => snapshot.content).join('\n')).toContain('Project Registry');
  });

  it('rejects non-approved chat ids before calling Feishu', async () => {
    await expect(syncFeishuProjectContext({
      chatId: 'oc_unapproved',
      approvedChatIds: ['oc_a84d5b6ca478220d0a37964b50776edb'],
      since: new Date('2026-07-01T00:00:00.000Z'),
      feishu: {
        async listMessages() {
          throw new Error('must not be called');
        },
        async listReferencedFiles() {
          throw new Error('must not be called');
        }
      },
      saveSnapshot: async () => {}
    })).rejects.toMatchObject({ code: 'FEISHU_CHAT_NOT_APPROVED' });
  });

  it('rejects a caller-supplied allowlist that tries to approve another group', async () => {
    await expect(syncFeishuProjectContext({
      chatId: 'oc_other',
      approvedChatIds: ['oc_other'],
      since: new Date('2026-07-01T00:00:00.000Z'),
      feishu: fakeFeishu(),
      saveSnapshot: async () => {}
    })).rejects.toMatchObject({ code: 'FEISHU_CHAT_NOT_APPROVED' });
  });

  it('persists cursor and observed time coverage until Feishu terminates pagination', async () => {
    const calls: Array<string | null> = [];
    const snapshots: Array<{ sourceKind: string; content: string }> = [];
    const report = await syncFeishuProjectContext({
      chatId: 'oc_a84d5b6ca478220d0a37964b50776edb',
      approvedChatIds: ['oc_a84d5b6ca478220d0a37964b50776edb'],
      since: new Date('2026-07-01T00:00:00.000Z'),
      now: () => new Date('2026-07-31T00:00:00.000Z'),
      feishu: {
        async listMessages({ cursor }) {
          calls.push(cursor);
          return cursor === null
            ? { messages: [{ messageId: 'om_1', messageType: 'text' as const, text: 'first', createdAt: '2026-07-02T00:00:00.000Z' }], nextCursor: 'cursor-2' }
            : { messages: [{ messageId: 'om_2', messageType: 'text' as const, text: 'last', createdAt: '2026-07-30T00:00:00.000Z' }], nextCursor: null };
        },
        async listReferencedFiles() { return []; }
      },
      saveSnapshot: async (snapshot) => { snapshots.push(snapshot); }
    });

    expect(calls).toEqual([null, 'cursor-2']);
    expect(report.sourceCoverage).toMatchObject({
      termination: 'next_cursor_null',
      observedMessageTimeRange: {
        earliest: '2026-07-02T00:00:00.000Z',
        latest: '2026-07-30T00:00:00.000Z'
      },
      pages: [
        { requestCursor: null, nextCursor: 'cursor-2' },
        { requestCursor: 'cursor-2', nextCursor: null }
      ]
    });
    expect(snapshots.find((snapshot) => snapshot.sourceKind === 'feishu_sync_coverage')?.content)
      .toContain('cursor-2');
  });

  it('records explicit gaps for no-text messages and skips oversized text in bounded chunks', async () => {
    const snapshots: Array<{ sourceKind: string; content: string }> = [];
    const report = await syncFeishuProjectContext({
      chatId: 'oc_a84d5b6ca478220d0a37964b50776edb',
      approvedChatIds: ['oc_a84d5b6ca478220d0a37964b50776edb'],
      since: new Date('2026-07-01T00:00:00.000Z'),
      feishu: {
        async listMessages() {
          return {
            messages: [
              { messageId: 'om_empty', messageType: 'text', text: null, createdAt: '2026-07-30T00:00:00.000Z' },
              { messageId: 'om_image', messageType: 'image', text: null, createdAt: '2026-07-30T00:01:00.000Z' },
              { messageId: 'om_unknown', messageType: 'unknown', text: null, createdAt: '2026-07-30T00:02:00.000Z' },
              { messageId: 'om_large', messageType: 'post', text: '字'.repeat(5_000), createdAt: '2026-07-30T00:03:00.000Z' }
            ],
            nextCursor: null
          };
        },
        async listReferencedFiles() { return []; }
      },
      saveSnapshot: async (snapshot) => { snapshots.push(snapshot); }
    });

    expect(report.gaps.map((gap) => gap.code)).toEqual(expect.arrayContaining([
      'MESSAGE_TEXT_UNAVAILABLE',
      'IMAGE_SKIPPED',
      'MESSAGE_UNSUPPORTED'
    ]));
    expect(snapshots.filter((snapshot) => snapshot.sourceKind === 'feishu_post').every(
      (snapshot) => Buffer.byteLength(snapshot.content, 'utf8') <= 8 * 1024
    )).toBe(true);
  });
});

function fakeFeishu() {
  return {
    async listMessages() { return { messages: [], nextCursor: null }; },
    async listReferencedFiles() { return []; }
  };
}

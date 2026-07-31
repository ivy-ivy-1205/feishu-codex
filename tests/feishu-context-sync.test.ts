import { describe, expect, it } from 'vitest';
import { syncFeishuProjectContext } from '../src/services/feishu-context-sync.js';

describe('syncFeishuProjectContext', () => {
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
});

import { expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createSqliteDatabase } from '../src/db/client.js';
import { migrateDatabase } from '../src/db/migrate.js';
import { ContextSourceRepository } from '../src/repositories/context-source-repository.js';
import { JobRepository } from '../src/repositories/job-repository.js';
import { TopicRepository } from '../src/repositories/topic-repository.js';
import { AlignmentRepository } from '../src/repositories/alignment-repository.js';
import { runFounderStreamBackfill } from '../src/services/founder-stream-backfill.js';
import { createFounderStreamRuntime } from '../src/services/founder-stream-worker.js';
import { FeishuMessageDeliveryAdapter } from '../src/adapters/feishu.js';

it('replays history through topics, dual perspectives, one group question, corrections and a resolved receipt', async () => {
  const db = createSqliteDatabase(':memory:'); migrateDatabase(db.client);
  const chat = 'oc_a84d5b6ca478220d0a37964b50776edb';
  let now = new Date('2026-09-21T10:00:00.000Z');
  const sources = new ContextSourceRepository(db.client), jobs = new JobRepository(db.client);
  const topics = new TopicRepository(db.client), alignment = new AlignmentRepository(db.client);
  const sent: { chatId: string; text?: string; card?: unknown }[] = [];
  for (const founder of ['ivy', 'james'] as const) alignment.configureFounderIdentity({ founder, sourceSystem: 'feishu', externalAuthorId: `ou_${founder}`, configuredAt: now });
  const delivery = new FeishuMessageDeliveryAdapter({
    async getMinuteBasicInfo() { throw new Error('unexpected network boundary'); },
    async exportMinuteTranscript() { throw new Error('unexpected network boundary'); },
    async sendTextMessage(input) { sent.push(input); return { messageId: `om_sent_${sent.length}` }; },
    async sendInteractiveMessage(input) { sent.push(input); return { messageId: `om_sent_${sent.length}` }; }
  });
  const runtime = createFounderStreamRuntime({ client: db.client, jobRepository: jobs, approvedChatIds: [chat], ivyPrivateChatId: 'oc_private',
    flags: { captureEnabled: true, analysisEnabled: true, groupDeliveryEnabled: true }, now: () => now, delivery,
    analyzer: { async analyze(input) { return { topics: [{ displayName: '网站', stage: 'exploring', outcome: null, currentAction: null, confidence: 'high',
      sourceIds: input.sources.map(s => s.id), evidenceExcerpts: input.sources.map(s => ({ sourceId: s.id, excerpt: s.contentText })),
      joinDecision: { kind: 'new', topicId: null, confidence: 'high', sharedTerms: [] }, splitSuggestions: [] }] }; } },
    perspectiveAnalyzer: { async analyze(input) {
      const ivy = input.evidence.find(e => e.founder === 'ivy')!, james = input.evidence.find(e => e.founder === 'james')!, topicId = input.topicIds[0]!;
      return { observations: [ivy, james].map(e => ({ topicId, evidenceId: e.id, statement: e.excerpt,
        speechAct: 'view' as const, decisionKey: 'website', confidence: 1, observedAt: now })), alignmentProposals: [{ topicId,
        decisionKey: 'website', dimension: 'direction', ivy: { evidenceId: ivy.id, statement: '按 A 方案推进' },
        james: { evidenceId: james.id, statement: '按 B 方案推进' }, actionConsequence: { evidenceId: ivy.id, excerpt: '今天开始实施' },
        actionHorizon: { evidenceId: ivy.id, excerpt: '今天', startsAt: '2026-09-21T00:00:00.000Z', endsAt: '2026-09-22T00:00:00.000Z' } }] };
    } }
  });
  const app = buildApp({ readiness: () => ({ ready: true }), verificationToken: 'verify', encryptKey: '', logger: false,
    ingestMinute: () => ({ status: 'ignored' }), routeReply: () => ({ kind: 'reject', reason: 'wrong_chat' }),
    founderStream: runtime.route, founderStreamDiagnostics: { client: db.client } });
  try {
    const report = await runFounderStreamBackfill({ chatId: chat, since: '2026-09-01T10:00:00.000Z', now, dryRun: false,
      sourceRepository: sources, jobRepository: jobs, feishu: {
        async listMessages() { return { messages: ['ivy', 'james'].map((who, i) => ({ messageId: `om_history_${who}`, senderId: `ou_${who}`,
          senderType: 'user', messageType: 'text' as const, text: `按 ${i === 0 ? 'A' : 'B'} 方案推进，今天开始实施网站`, createdAt: '2026-09-21T09:00:00.000Z' })), nextCursor: null }; },
        async listReferencedFiles() { return []; }
      } });
    expect(report.sourcesCaptured).toBe(2); expect(sent).toHaveLength(0);
    await runtime.runOnce();
    const topic = topics.listCurrentTopics()[0]!;
    expect(topic.displayName).toBe('网站'); expect(topic.evidenceIds).toHaveLength(2);
    expect(alignment.listCurrentPerspectives(topic.id).map(p => p.kind).sort()).toEqual(['ivy_view', 'james_view']);
    expect(db.client.prepare('SELECT status FROM alignment_issues').get()).toEqual({ status: 'asked' });
    expect(sent).toHaveLength(1); expect(sent[0]?.chatId).toBe(chat);
    async function reply(who: string, text: string, minute: number) {
      now = new Date(`2026-09-21T10:0${minute}:00.000Z`);
      return app.inject({ method: 'POST', url: '/webhooks/feishu/events', payload: {
        schema: '2.0', header: { token: 'verify', event_id: `evt_${who}`, event_type: 'im.message.receive_v1', create_time: String(now.getTime()) },
        event: { sender: { sender_type: 'user', sender_id: { open_id: `ou_${who}` } }, message: { message_id: `om_reply_${who}`, chat_id: chat,
          chat_type: 'group', parent_id: 'om_sent_1', message_type: 'text', content: JSON.stringify({ text }), create_time: String(now.getTime()) } }
      } });
    }
    expect((await reply('ivy', '按 A 方案推进', 1)).statusCode).toBe(200); await runtime.runOnce();
    expect(alignment.getCurrentPerspective(topic.id, 'shared_decision')).toBeNull();
    expect((await reply('james', '同意，按 A 方案推进', 2)).statusCode).toBe(200); await runtime.runOnce(); await runtime.runOnce();
    expect(alignment.getCurrentPerspective(topic.id, 'shared_decision')?.statement).toContain('按 A 方案推进');
    expect(db.client.prepare('SELECT status FROM alignment_issues').get()).toEqual({ status: 'resolved' });
    expect(sent.every(s => s.chatId === chat)).toBe(true); expect(sent).toHaveLength(3);
    expect(sent[2]?.text).toContain('对齐');
    expect(db.client.prepare("SELECT COUNT(*) n FROM outbox WHERE status='pending'").get()).toEqual({ n: 0 });
    const diagnostics = await app.inject({ url: '/diag/founder-stream' });
    expect(diagnostics.statusCode).toBe(200);
    expect(diagnostics.json()).toMatchObject({ topicsByStage: { exploring: 1 }, openAlignmentIssues: { total: 0 }, outbox: { delivered: 3 } });
  } finally { await app.close(); db.close(); }
});

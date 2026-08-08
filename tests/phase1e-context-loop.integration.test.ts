import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { FeishuMessageDeliveryAdapter } from '../src/adapters/feishu.js';
import { parseMinuteTranscriptStream } from '../src/adapters/minute-transcript-parser.js';
import { createContextRuntime } from '../src/composition/context-runtime.js';
import { createWorkerRuntime } from '../src/composition/worker-runtime.js';
import { createSqliteDatabase } from '../src/db/client.js';
import { migrateDatabase } from '../src/db/migrate.js';
import type { ContextCandidateExtractor } from '../src/ports/context-candidate-extractor.js';
import { JobRepository } from '../src/repositories/job-repository.js';
import { MeetingRepository } from '../src/repositories/meeting-repository.js';
import { OutboxRepository } from '../src/repositories/outbox-repository.js';
import { ProjectRepository } from '../src/repositories/project-repository.js';

const clock = new Date('2030-01-01T00:00:00.000Z');

function createLoop(extractor: ContextCandidateExtractor, transcript = [{ speakerName: 'Ivy', startMs: 0, endMs: 1000,
  text: '决定把 Context 与 Todo 分开；Todo：整理验收报告。' }]) {
  const database = createSqliteDatabase(':memory:'); migrateDatabase(database.client);
  const meetings = new MeetingRepository(database.client);
  const jobs = new JobRepository(database.client);
  const outbox = new OutboxRepository(database.client);
  const projects = new ProjectRepository(database.client);
  meetings.ingestMinute({ minuteId: 'min-e2e', eventId: 'evt-e2e' });
  jobs.enqueueProcessMinute('min-e2e');
  const context = createContextRuntime({ client: database.client, jobRepository: jobs,
    outboxRepository: outbox, projectRepository: projects, targetChatId: 'oc_ivy', reviewEnabled: true,
    codex: { command: 'unused', workdir: '/tmp', timeoutSeconds: 30 }, extractor });
  context.worker.now = () => clock;
  const runtime = createWorkerRuntime({ enabled: true, meetingRepository: meetings, jobRepository: jobs,
    outboxRepository: outbox, targetChatId: 'oc_ivy', intervalMs: 1000, now: () => clock,
    reader: { async getMinute() { return { minuteId: 'min-e2e', title: 'Phase 1E',
      startedAt: '2026-08-03T01:00:00.000Z', endedAt: '2026-08-03T01:30:00.000Z',
      transcript }; } },
    summarizer: { async summarize() { return { oneLineConclusion: 'Context 与 Action 分离。',
      progress: [], decisions: ['Context 与 Action 分离'], risks: [], todos: [{ title: '整理验收报告',
        description: '整理本轮验收结果', risk: 'low', capability: 'content_draft', projectKey: 'feishu-adaptor',
        subprojectKey: null, projectConfidence: 'high', projectEvidence: '明确 Phase 1E', projectPrompt: '整理报告' }] }; } },
    delivery: new FeishuMessageDeliveryAdapter({ async getMinuteBasicInfo() { return {}; },
      async exportMinuteTranscript() { return []; }, async sendTextMessage() { return { messageId: 'om_summary' }; },
      async sendInteractiveMessage() { return { messageId: 'om_review' }; } }),
    context: { capture: context.capture, worker: context.worker }
  });
  return { database, runtime, meetings, outbox };
}

describe('Phase 1E local context loop', () => {
  it('separates one utterance into a durable Context candidate and an independent Todo', async () => {
    const loop = createLoop({ async extract(input) { return { candidates: [{
      candidateType: 'decision', scope: 'project', summary: 'Context 与 Todo 必须分离', subjectKey: 'context-action-boundary',
      structuredPayload: {}, extractionConfidence: 0.94, factualStatus: 'source_attested',
      projectMappings: [{ projectKey: 'feishu-adaptor', role: 'primary', confidence: 'high', evidence: 'Phase 1E 会议' }],
      evidence: [{ sourceId: input.sources[0]!.id, excerpt: '决定把 Context 与 Todo 分开', locator: {
        segmentOrdinal: 0, sourceVersion: input.sources[0]!.sourceVersion,
        contentHash: input.sources[0]!.contentHash, speakerName: 'Ivy', startMs: 0, endMs: 1000
      }, evidenceLevel: 'primary_statement', role: 'supporting' }],
      suggestedRelations: [], externalRefs: []
    }] }; } });
    await loop.runtime.runOnce();
    await loop.runtime.runOnce();
    expect(loop.database.client.prepare(`SELECT status FROM meeting_todos`).get()).toEqual({ status: 'proposed' });
    expect(loop.database.client.prepare(`SELECT review_status, factual_status FROM context_candidates`).get())
      .toEqual({ review_status: 'pending', factual_status: 'source_attested' });
    expect(loop.outbox.findDeliveredContextReview('om_review')).not.toBeNull();
    expect(loop.meetings.findSummaryByMinute('min-e2e')?.summaryMessageId).toBe('om_summary');
  });

  it('keeps summary and follow-up successful when Context extraction fails', async () => {
    const loop = createLoop({ async extract() { throw new Error('fixture extraction failure'); } });
    await loop.runtime.runOnce();
    await loop.runtime.runOnce();
    expect(loop.meetings.findSummaryByMinute('min-e2e')?.summaryMessageId).toBe('om_summary');
    expect(loop.database.client.prepare('SELECT COUNT(*) AS count FROM meeting_todos').get()).toEqual({ count: 1 });
    expect(loop.database.client.prepare(`SELECT status FROM batch_jobs WHERE type = 'extract_context_candidates'`).get())
      .toEqual({ status: 'failed' });
    expect(loop.database.client.prepare('SELECT COUNT(*) AS count FROM context_candidates').get()).toEqual({ count: 0 });
  });

  it('creates a candidate from a later segment produced by the real multiline parser', async () => {
    const transcript = await parseMinuteTranscriptStream(Readable.from([[
      '2026-08-03 10:00:00 CST|多行 segment 回归', '', '发言人（2）:', 'James、Ivy', '',
      'James', '第一行', '第二行', '', 'Ivy', '后续决定'
    ].join('\n')]));
    const loop = createLoop({ async extract(input) { return { candidates: [{
      candidateType: 'decision', scope: 'company', summary: '后续决定', subjectKey: 'multiline-segment',
      structuredPayload: {}, extractionConfidence: 0.9, factualStatus: 'source_attested', projectMappings: [],
      evidence: [{ sourceId: input.sources[0]!.id, excerpt: '后续决定', locator: {
        segmentOrdinal: 1, sourceVersion: input.sources[0]!.sourceVersion,
        contentHash: input.sources[0]!.contentHash, speakerName: 'Ivy', startMs: 1, endMs: 2
      }, evidenceLevel: 'primary_statement', role: 'supporting' }], suggestedRelations: [], externalRefs: []
    }] }; } }, transcript);

    await loop.runtime.runOnce();
    await loop.runtime.runOnce();

    const source = loop.database.client.prepare('SELECT metadata_json FROM context_sources').get() as { metadata_json: string };
    expect(JSON.parse(source.metadata_json)).toMatchObject({ segments: [
      { segmentOrdinal: 0, speakerName: 'James', text: '第一行\n第二行' },
      { segmentOrdinal: 1, speakerName: 'Ivy', text: '后续决定' }
    ] });
    expect(loop.database.client.prepare('SELECT summary, review_status FROM context_candidates').get())
      .toEqual({ summary: '后续决定', review_status: 'pending' });
  });

  it('persists evidence from the continuation line of a verified headerless single-speaker export', async () => {
    const transcript = await parseMinuteTranscriptStream(Readable.from([[
      '2026-08-07 21:52:47 CST|29秒', '', '关键词:', 'Context、审核、来源', '', '我',
      '第一行：候选 Context 必须由 Ivy 审核。',
      '第二行：批准后才能成为正式 Context。'
    ].join('\n')]), { speakerBoundaryMode: 'verified_single_speaker_without_header' });
    const loop = createLoop({ async extract(input) { return { candidates: [{
      candidateType: 'decision', scope: 'company', summary: '批准后才能成为正式 Context',
      subjectKey: 'headerless-single-speaker', structuredPayload: {}, extractionConfidence: 0.9,
      factualStatus: 'source_attested', projectMappings: [], evidence: [{
        sourceId: input.sources[0]!.id,
        excerpt: '第二行：批准后才能成为正式 Context。',
        locator: { segmentOrdinal: 0, sourceVersion: input.sources[0]!.sourceVersion,
          contentHash: input.sources[0]!.contentHash, speakerName: '说话人 1', startMs: 0, endMs: 1 },
        evidenceLevel: 'primary_statement', role: 'supporting'
      }], suggestedRelations: [], externalRefs: []
    }] }; } }, transcript);

    await loop.runtime.runOnce();
    await loop.runtime.runOnce();

    const source = loop.database.client.prepare('SELECT metadata_json FROM context_sources').get() as { metadata_json: string };
    expect(JSON.parse(source.metadata_json)).toMatchObject({ segments: [{
      segmentOrdinal: 0,
      speakerName: '说话人 1',
      startMs: 0,
      endMs: 1,
      text: '第一行：候选 Context 必须由 Ivy 审核。\n第二行：批准后才能成为正式 Context。'
    }] });
    expect(loop.database.client.prepare('SELECT excerpt FROM context_evidence').get())
      .toEqual({ excerpt: '第二行：批准后才能成为正式 Context。' });
  });
});

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { loadFounderPreviewBatch, parseFounderPreviewArguments } from '../src/cli/preview-founder-work-map.js';

describe('founder work map preview CLI boundary', () => {
  it('requires an exact bounded identity-aware request', () => {
    expect(parseFounderPreviewArguments([
      '--chat-id', 'oc_group', '--since', '2026-08-31T20:04:00.338Z',
      '--until', '2026-09-20T20:04:00.338Z', '--ivy-open-id', 'ou_ivy',
      '--james-open-id', 'ou_james', '--expected-source-count', '14'
    ])).toEqual({ chatId:'oc_group', since:'2026-08-31T20:04:00.338Z',
      until:'2026-09-20T20:04:00.338Z', ivyOpenId:'ou_ivy', jamesOpenId:'ou_james',
      expectedSourceCount:14 });
    expect(() => parseFounderPreviewArguments(['--chat-id','oc_group'])).toThrow('FOUNDER_PREVIEW_ARGUMENTS_INVALID');
  });

  it('selects one exact queued batch without leasing or updating it', () => {
    const client = new Database(':memory:');
    client.exec(`CREATE TABLE batch_jobs (id TEXT, type TEXT, stable_key TEXT, payload TEXT, status TEXT,
      created_at TEXT, updated_at TEXT)`);
    const payload = JSON.stringify({chatId:'oc_group',since:'2026-08-31T20:04:00.338Z',
      until:'2026-09-20T20:04:00.338Z',sourceIds:['a','b'],threadId:null,windowKey:'history:x',attempt:0});
    client.prepare(`INSERT INTO batch_jobs VALUES ('job','analyze_founder_stream_batch','job',?,'queued','now','now')`).run(payload);
    const before = client.prepare(`SELECT * FROM batch_jobs`).get();
    expect(loadFounderPreviewBatch(client,{chatId:'oc_group',since:'2026-08-31T20:04:00.338Z',
      until:'2026-09-20T20:04:00.338Z',ivyOpenId:'ou_ivy',jamesOpenId:'ou_james',expectedSourceCount:2}))
      .toEqual({sourceIds:['a','b']});
    expect(client.prepare(`SELECT * FROM batch_jobs`).get()).toEqual(before);
  });
});

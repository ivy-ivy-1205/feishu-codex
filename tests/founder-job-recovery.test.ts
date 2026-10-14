import { describe, expect, it } from 'vitest';
import { createSqliteDatabase } from '../src/db/client.js';
import { migrateDatabase } from '../src/db/migrate.js';
import { applyFounderJobRecovery, planFounderJobRecovery } from '../src/services/founder-job-recovery.js';

const chatId='oc_a84d5b6ca478220d0a37964b50776edb';

describe('founder failed-job recovery',()=>{
  it('previews exact unresolved work and requeues it only after matching confirmation',()=>{
    const db=createSqliteDatabase(':memory:');migrateDatabase(db.client);
    const insert=(id:string,type:string,status:string,payload:unknown)=>db.client.prepare(`INSERT INTO batch_jobs
      (id,type,stable_key,payload,status,created_at,updated_at) VALUES(?,?,?,?,?,'2026-10-14T00:00:00Z','2026-10-14T00:00:00Z')`)
      .run(id,type,id,JSON.stringify(payload),status);
    insert('done','analyze_founder_stream_batch','completed',{chatId,sourceIds:['source_done']});
    insert('failed-covered','analyze_founder_stream_batch','failed',{chatId,sourceIds:['source_done'],attempt:3,failureReason:'old'});
    insert('failed-analysis','analyze_founder_stream_batch','failed',{chatId,sourceIds:['source_missing'],attempt:3,
      failureReason:'FOUNDER_STREAM_PROCESSING_FAILED',failure:{stage:'topic_analysis',code:'codex_execution_failed'}});
    insert('failed-capture','capture_founder_attachment','failed',{chatId,messageId:'om_file',attempt:3,failureReason:'old'});
    insert('other-chat','analyze_founder_stream_batch','failed',{chatId:'oc_other',sourceIds:['source_other'],attempt:3});
    const plan=planFounderJobRecovery(db.client,{chatId,approvedChatIds:[chatId]});
    expect(plan).toMatchObject({analysisJobs:1,captureJobs:1,unresolvedSourceCount:1,totalJobs:2});
    expect(()=>applyFounderJobRecovery(db.client,{chatId,approvedChatIds:[chatId],confirmedRecoveryId:'wrong',now:new Date('2026-10-14T01:00:00Z')}))
      .toThrow(/CONFIRMATION_MISMATCH/);
    const applied=applyFounderJobRecovery(db.client,{chatId,approvedChatIds:[chatId],confirmedRecoveryId:plan.recoveryId,
      now:new Date('2026-10-14T01:00:00Z')});
    expect(applied).toEqual({...plan,applied:true});
    expect(db.client.prepare("SELECT status FROM batch_jobs WHERE id='failed-analysis'").get()).toEqual({status:'queued'});
    expect(db.client.prepare("SELECT status FROM batch_jobs WHERE id='failed-capture'").get()).toEqual({status:'queued'});
    expect(db.client.prepare("SELECT status FROM batch_jobs WHERE id='failed-covered'").get()).toEqual({status:'failed'});
    const payload=JSON.parse((db.client.prepare("SELECT payload FROM batch_jobs WHERE id='failed-analysis'").get() as {payload:string}).payload);
    expect(payload).toMatchObject({attempt:0,sourceIds:['source_missing']});
    expect(payload).not.toHaveProperty('failureReason');
    expect(payload).not.toHaveProperty('failure');
    db.close();
  });

  it('fails closed when the approved chat does not match',()=>{
    const db=createSqliteDatabase(':memory:');migrateDatabase(db.client);
    expect(()=>planFounderJobRecovery(db.client,{chatId,approvedChatIds:[]})).toThrow(/CHAT_NOT_APPROVED/);
    db.close();
  });
});

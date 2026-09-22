import { describe,expect,it } from 'vitest';
import { createSqliteDatabase } from '../src/db/client.js';
import { migrateDatabase } from '../src/db/migrate.js';
import { ContextSourceRepository } from '../src/repositories/context-source-repository.js';
import { JobRepository } from '../src/repositories/job-repository.js';
import { persistFounderAttachmentBackfill } from '../src/services/founder-attachment-backfill.js';
import type { FeishuContextFile,FeishuContextMessage } from '../src/services/feishu-context-sync.js';

const chat='oc_a84d5b6ca478220d0a37964b50776edb',now=new Date('2026-09-22T00:00:00.000Z');
describe('founder attachment backfill',()=>{
  it('persists bounded attachment text without resource keys and is idempotent',async()=>{
    const db=createSqliteDatabase(':memory:');migrateDatabase(db.client);const sources=new ContextSourceRepository(db.client),jobs=new JobRepository(db.client);
    const input={chatId:chat,now,messages:[{messageId:'om_file',createdAt:'2026-09-10T00:00:00.000Z',text:null,messageType:'file',senderType:'user',senderId:'ou_ivy',threadId:null,rootId:null}] satisfies FeishuContextMessage[],
      files:[{messageId:'om_file',fileToken:'secret_file_key',title:'brief.md',mimeType:'text/markdown',text:null}] satisfies FeishuContextFile[],sourceRepository:sources,jobRepository:jobs,
      read:async()=>Buffer.from('# 目标\n保持双方认知一致')};
    const first=await persistFounderAttachmentBackfill(input),second=await persistFounderAttachmentBackfill(input);
    expect(first).toMatchObject({filesSeen:1,filesParsed:1,sourcesCreated:1,jobsEnqueued:1});
    expect(second).toMatchObject({filesSeen:1,filesParsed:1,sourcesCreated:0,jobsEnqueued:0});
    const source=sources.listSources()[0]!;expect(source).toMatchObject({sourceType:'group_message',contentText:'[附件：brief.md]\n# 目标\n保持双方认知一致\n[分享消息前后上下文]',
      rawTextExpiresAt:'2026-12-21T00:00:00.000Z',metadata:{attachmentTitle:'brief.md',messageId:'om_file'}});
    expect(JSON.stringify(sources.listSources())).not.toContain('secret_file_key');expect(JSON.stringify(jobs.list())).not.toContain('secret_file_key');db.close();
  });
  it('splits attachment analysis batches by bounded text size',async()=>{
    const db=createSqliteDatabase(':memory:');migrateDatabase(db.client);const sources=new ContextSourceRepository(db.client),jobs=new JobRepository(db.client);
    const messages=Array.from({length:4},(_,index)=>({messageId:`om_${index}`,createdAt:`2026-09-1${index}T00:00:00.000Z`,text:null,
      messageType:'file' as const,senderType:'user' as const,senderId:'ou_ivy',threadId:null,rootId:null}));
    const files=messages.map((message,index)=>({messageId:message.messageId,fileToken:`secret_${index}`,title:`brief-${index}.md`,mimeType:'text/markdown',text:null}));
    const result=await persistFounderAttachmentBackfill({chatId:chat,now,messages,files,read:async()=>Buffer.from('x'.repeat(12_000)),sourceRepository:sources,jobRepository:jobs});
    expect(result).toMatchObject({sourcesCreated:4,jobsEnqueued:2});
    expect(jobs.list().filter(job=>job.kind==='analyze_founder_stream_batch').map(job=>'sourceIds'in job?job.sourceIds.length:0)).toEqual([3,1]);db.close();
  });
});

import {describe,expect,it} from 'vitest';
import {parseFounderAttachmentBackfillArguments} from '../src/cli/backfill-founder-attachments.js';

const chat='oc_a84d5b6ca478220d0a37964b50776edb';
describe('founder attachment backfill CLI',()=>{
  it('accepts only the approved group and a fixed valid window',()=>{
    expect(parseFounderAttachmentBackfillArguments(['--database','/app/data/bridge.sqlite','--chat-id',chat,'--since','2026-08-31T20:04:00.338Z','--until','2026-09-20T20:04:00.338Z']))
      .toMatchObject({database:'/app/data/bridge.sqlite',chatId:chat});
    expect(()=>parseFounderAttachmentBackfillArguments(['--database','x','--chat-id','oc_other','--since','2026-08-31T20:04:00.338Z','--until','2026-09-20T20:04:00.338Z'])).toThrow('ATTACHMENT_BACKFILL_ARGUMENTS_INVALID');
  });
});

import { describe,expect,it } from 'vitest';
import { parseCurrentFounderAlignmentArguments } from '../src/cli/current-founder-alignment.js';

describe('current founder alignment CLI',()=>{
  it('accepts only a read-only preview query for one approved group',()=>{
    expect(parseCurrentFounderAlignmentArguments(['--database','/data/bridge.sqlite','--chat-id','oc_a84d5b6ca478220d0a37964b50776edb',
      '--query','查看待对齐','--now','2026-09-25T10:00:00.000Z'])).toEqual({database:'/data/bridge.sqlite',
      chatId:'oc_a84d5b6ca478220d0a37964b50776edb',query:'查看待对齐',now:'2026-09-25T10:00:00.000Z'});
    expect(()=>parseCurrentFounderAlignmentArguments(['--database','x','--chat-id','oc_wrong','--query','查看待对齐','--now','2026-09-25T10:00:00.000Z'])).toThrow(/approved/i);
    expect(()=>parseCurrentFounderAlignmentArguments(['--database','x','--chat-id','oc_a84d5b6ca478220d0a37964b50776edb','--query','anything','--now','2026-09-25T10:00:00.000Z'])).toThrow(/query/i);
  });
});

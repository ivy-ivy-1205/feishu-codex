import { describe, expect, it } from 'vitest';
import { parseFounderJobRecoveryArguments } from '../src/cli/recover-founder-job-failures.js';

const chatId='oc_a84d5b6ca478220d0a37964b50776edb';

describe('founder job recovery cli',()=>{
  it('requires an explicit preview or a confirmed apply',()=>{
    expect(parseFounderJobRecoveryArguments(['--database','/data/bridge.sqlite','--chat-id',chatId,'--preview']))
      .toEqual({database:'/data/bridge.sqlite',chatId,mode:'preview',confirmedRecoveryId:null});
    expect(parseFounderJobRecoveryArguments(['--database','/data/bridge.sqlite','--chat-id',chatId,'--apply',
      '--confirm-recovery-id','founderjobrecovery_1234']))
      .toEqual({database:'/data/bridge.sqlite',chatId,mode:'apply',confirmedRecoveryId:'founderjobrecovery_1234'});
    expect(()=>parseFounderJobRecoveryArguments(['--database','/data/bridge.sqlite','--chat-id',chatId,'--apply'])).toThrow(/ARGUMENTS_INVALID/);
    expect(()=>parseFounderJobRecoveryArguments(['--database','/data/bridge.sqlite','--chat-id','oc_other','--preview'])).toThrow(/ARGUMENTS_INVALID/);
    expect(()=>parseFounderJobRecoveryArguments(['--database','/data/bridge.sqlite','--chat-id',chatId,'--preview','--apply'])).toThrow(/ARGUMENTS_INVALID/);
  });
});

import { describe, expect, it } from 'vitest';
import { parseRecoverFounderCorrectionArguments } from '../src/cli/recover-founder-batch-correction.js';

const valid=['--database','/tmp/bridge.sqlite','--chat-id','oc_a84d5b6ca478220d0a37964b50776edb',
  '--message-id','om_x100b63c7e0cd84e4ce9e5495d2b69d2','--since','2026-10-14T08:10:00.000Z',
  '--until','2026-10-14T08:30:00.000Z','--mode','preview'];

describe('founder correction recovery cli',()=>{
  it('accepts only the approved chat, bounded time window and explicit mode',()=>{
    expect(parseRecoverFounderCorrectionArguments(valid)).toMatchObject({mode:'preview',messageId:'om_x100b63c7e0cd84e4ce9e5495d2b69d2'});
    expect(()=>parseRecoverFounderCorrectionArguments(valid.map(value=>value==='preview'?'apply':value))).not.toThrow();
    expect(()=>parseRecoverFounderCorrectionArguments(valid.map(value=>value==='oc_a84d5b6ca478220d0a37964b50776edb'?'oc_other':value))).toThrow();
    expect(()=>parseRecoverFounderCorrectionArguments(valid.slice(0,-2))).toThrow();
  });
});

import { describe,expect,it } from 'vitest';
import { parseCurrentFounderWorkMapArguments } from '../src/cli/current-founder-work-map.js';

const base=['--database','/app/data/bridge.sqlite','--chat-id','oc_a84d5b6ca478220d0a37964b50776edb',
  '--since','2026-08-31T00:00:00Z','--until','2026-09-24T23:59:59Z','--expected-canonical-topics','9'];

describe('current founder work map CLI',()=>{
  it('defaults to an explicit read-only preview mode',()=>{
    expect(parseCurrentFounderWorkMapArguments([...base,'--preview'])).toMatchObject({mode:'preview',expectedCanonicalTopicCount:9});
  });
  it('requires an exact confirmed target for enqueue and rejects ambiguous modes',()=>{
    expect(()=>parseCurrentFounderWorkMapArguments([...base,'--enqueue'])).toThrow(/ARGUMENTS_INVALID/);
    expect(parseCurrentFounderWorkMapArguments([...base,'--enqueue','--confirm-target-chat-id','oc_a84d5b6ca478220d0a37964b50776edb'])).toMatchObject({mode:'enqueue'});
    expect(()=>parseCurrentFounderWorkMapArguments([...base,'--preview','--enqueue','--confirm-target-chat-id','oc_a84d5b6ca478220d0a37964b50776edb'])).toThrow(/ARGUMENTS_INVALID/);
  });
});

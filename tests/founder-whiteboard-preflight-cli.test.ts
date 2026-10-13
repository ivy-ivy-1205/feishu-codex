import { describe, expect, it } from 'vitest';
import { parseWhiteboardPreflightArguments, runWhiteboardPreflightCli } from '../src/cli/preflight-founder-whiteboard.js';

describe('founder whiteboard preflight CLI',()=>{
  it('requires the approved group and an explicit create mode',()=>{
    expect(parseWhiteboardPreflightArguments(['--chat-id','oc_a84d5b6ca478220d0a37964b50776edb','--create']))
      .toEqual({chatId:'oc_a84d5b6ca478220d0a37964b50776edb'});
    expect(()=>parseWhiteboardPreflightArguments(['--chat-id','oc_other','--create'])).toThrow(/approved/i);
    expect(()=>parseWhiteboardPreflightArguments(['--chat-id','oc_a84d5b6ca478220d0a37964b50776edb'])).toThrow(/create/i);
  });

  it('publishes a native editable probe board and prints only artifact metadata',async()=>{
    const published:any[]=[];const output:string[]=[];
    await runWhiteboardPreflightCli(['--chat-id','oc_a84d5b6ca478220d0a37964b50776edb','--create'],{
      gateway:{async createDocument(){return{documentId:'doc_1'}},async createBoard(){return{whiteboardId:'board_1'}},
        async createNodes(input){published.push(...input.nodes)},async grantGroupEdit(){}},
      write:value=>output.push(value)
    });
    expect(published.some(node=>node.type==='image')).toBe(false);
    expect(JSON.parse(output[0]!)).toEqual({documentId:'doc_1',whiteboardId:'board_1',
      url:'https://icnua99ny9c4.feishu.cn/docx/doc_1',paletteId:'grove'});
  });
});

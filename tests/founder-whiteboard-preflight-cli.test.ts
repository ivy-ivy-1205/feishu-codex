import { describe, expect, it } from 'vitest';
import { formatWhiteboardPreflightFailure, parseWhiteboardPreflightArguments,
  runWhiteboardPreflightCli } from '../src/cli/preflight-founder-whiteboard.js';

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
      gateway:{async uploadMessageImage(){return{imageKey:'img_preview'}},async createDocument(){return{documentId:'doc_1'}},async createBoard(){return{whiteboardId:'board_1'}},
        async createNodes(input){published.push(...input.nodes)},async grantGroupEdit(){}},
      write:value=>output.push(value)
    });
    expect(published.some(node=>node.type==='image')).toBe(false);
    expect(JSON.parse(output[0]!)).toEqual({documentId:'doc_1',whiteboardId:'board_1',
      url:'https://icnua99ny9c4.feishu.cn/docx/doc_1',paletteId:'grove',previewImageKey:'img_preview'});
  });

  it('reports only the failed stage and Feishu code',async()=>{
    let failure:unknown;
    try{
      await runWhiteboardPreflightCli(['--chat-id','oc_a84d5b6ca478220d0a37964b50776edb','--create'],{
        gateway:{async uploadMessageImage(){return{imageKey:'img_preview'}},
          async createDocument(){throw{response:{data:{code:99991672,msg:'sensitive remote detail'}}}},
          async createBoard(){throw new Error('unexpected')},async createNodes(){throw new Error('unexpected')},
          async grantGroupEdit(){throw new Error('unexpected')}},write:()=>{}
      });
    }catch(error){failure=error;}
    expect(formatWhiteboardPreflightFailure(failure)).toEqual({status:'failed',stage:'create_document',
      feishuCode:99991672});
    expect(JSON.stringify(formatWhiteboardPreflightFailure(failure))).not.toContain('sensitive remote detail');
  });

  it('attributes an image permission failure to the preview upload stage',async()=>{
    let failure:unknown;
    try{
      await runWhiteboardPreflightCli(['--chat-id','oc_a84d5b6ca478220d0a37964b50776edb','--create'],{
        gateway:{async uploadMessageImage(){throw{code:99991672}},async createDocument(){throw new Error('unexpected')},
          async createBoard(){throw new Error('unexpected')},async createNodes(){throw new Error('unexpected')},
          async grantGroupEdit(){throw new Error('unexpected')}},write:()=>{}
      });
    }catch(error){failure=error;}
    expect(formatWhiteboardPreflightFailure(failure)).toEqual({status:'failed',stage:'upload_preview_image',
      feishuCode:99991672});
  });
});

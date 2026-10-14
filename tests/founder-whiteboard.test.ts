import { describe, expect, it } from 'vitest';
import { buildFounderWhiteboard, publishFounderWhiteboard, selectFounderPalette } from '../src/services/founder-whiteboard.js';

describe('founder whiteboard',()=>{
  it('keeps every card line as native text and uses no image nodes',()=>{
    const result=buildFounderWhiteboard({title:'工作地图',paletteId:'coral',cards:[{
      config:{wide_screen_mode:true},header:{template:'blue',title:{tag:'plain_text',content:'工作地图 · 1/1'}},
      elements:[{tag:'div',text:{tag:'plain_text',content:'A 线｜AiJia AI Native 房产业务'}},
        {tag:'div',text:{tag:'plain_text',content:'#1 · 项目｜Smart Listing\n当前方向：验证房源服务'}}]
    }]});
    expect(result.nodes.every(node=>(node as {type:string}).type!=='image')).toBe(true);
    const text=result.nodes.flatMap(node=>node.text?.text?[node.text.text]:[]).join('\n');
    expect(text).toContain('工作地图 · 1/1');
    expect(text).toContain('A 线｜AiJia AI Native 房产业务');
    expect(text).toContain('#1 · 项目｜Smart Listing');
    expect(text).toContain('当前方向：验证房源服务');
  });

  it('emits text nodes in the official OpenAPI shape without transparent style colors',()=>{
    const result=buildFounderWhiteboard({title:'工作地图',paletteId:'coral',cards:[{
      header:{title:{content:'工作地图 · 1/1'}},elements:[{text:{content:'当前阶段\n正在推进'}}]
    }]});
    const textNodes=result.nodes.filter(node=>node.type==='text_shape');
    expect(textNodes.length).toBeGreaterThan(0);
    for(const node of textNodes){
      expect(node).not.toHaveProperty('style');
      expect(node.text).toEqual(expect.objectContaining({
        line_through:false,underline:false,italic:false,angle:0,
        text_color_type:0,text_background_color_type:0,
        theme_text_color_code:-1,theme_text_background_color_code:-1
      }));
      expect(node.text?.text_color).toMatch(/^#[0-9A-F]{6}$/i);
    }
  });

  it('does not repeat the previous palette when alternatives exist',()=>{
    expect(selectFounderPalette('coral',()=>0).id).not.toBe('coral');
  });

  it('creates one editable board document and grants the invoking group edit access',async()=>{
    const state:{documentId?:string;boardId?:string;nodes?:unknown[];group?:string}={};
    const artifact=await publishFounderWhiteboard({title:'项目进展 · Smart Listing',paletteId:'coral',chatId:'oc_group',cards:[{
      header:{title:{content:'项目进展 · Smart Listing'}},elements:[{text:{content:'01 当前阶段\n正在推进'}}]
    }]},{
      async createDocument(){state.documentId='doc_1';return{documentId:'doc_1'}},
      async createBoard(input){expect(input.documentId).toBe('doc_1');state.boardId='board_1';return{whiteboardId:'board_1'}},
      async createNodes(input){state.nodes=[...input.nodes]},
      async grantGroupEdit(input){state.group=input.chatId}
    });
    expect(artifact).toEqual({documentId:'doc_1',whiteboardId:'board_1',url:'https://icnua99ny9c4.feishu.cn/docx/doc_1',paletteId:'coral'});
    expect(state.nodes?.length).toBeGreaterThan(2);
    expect(state.nodes?.some((node:any)=>node.type==='image')).toBe(false);
    expect(state.group).toBe('oc_group');
  });
});

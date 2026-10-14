import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { buildFounderWhiteboard, FounderWhiteboardPublishError, publishFounderWhiteboard, renderFounderWhiteboardPng, selectFounderPalette } from '../src/services/founder-whiteboard.js';

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

  it('lays out a work map as semantic lanes, nested cards and connectors instead of equal text boxes',()=>{
    const result=buildFounderWhiteboard({title:'工作地图',paletteId:'riso-brut',cards:[],view:{
      kind:'work_map',since:'2026-08-31T00:00:00.000Z',until:'2026-10-14T05:09:41.892Z',coverageGaps:[],topics:[
        {id:'a',name:'AiJia AI Native 房产业务',stage:'active_project',kind:'project',outcome:'房产业务主线'},
        {id:'site',name:'AiJia AI Native 官网',stage:'active_project',kind:'project',outcome:'业务官网入口',parentName:'AiJia AI Native 房产业务'},
        {id:'smart',name:'Smart Listing',stage:'active_project',kind:'project',outcome:'单套房源智能入口',parentName:'AiJia AI Native 房产业务',sourceCount:3},
        {id:'sample',name:'L008｜27 Cecil Street',stage:'active_project',kind:'project',outcome:'验证真实房源资料协作',parentName:'Smart Listing',sourceCount:2},
        {id:'b',name:'自媒体生产线',stage:'active_project',kind:'project',outcome:null},
        {id:'episode',name:'EP00《挺好》',stage:'closed',kind:'project',outcome:'已发布',parentName:'自媒体生产线'},
        {id:'c',name:'公司协作基础设施',stage:'active_project',kind:'project',outcome:null},
        {id:'room',name:'飞书合伙人对齐',stage:'active_project',kind:'project',outcome:'减少解释、查找与返工',parentName:'公司协作基础设施'},
        {id:'goal',name:'飞书第一阶段目标',stage:'active_project',kind:'goal',outcome:'验证地图、进度与分歧整理',parentName:'飞书合伙人对齐'}
      ]
    }});
    const text=result.nodes.flatMap(node=>node.text?.text?[node.text.text]:[]).join('\n');
    expect(text).toContain('A / AI Native 房产业务');
    expect(text).toContain('B / 自媒体生产线');
    expect(text).toContain('C / 公司协作基础设施');
    expect(text).toContain('Smart Listing');
    expect(text).toContain('阶段目标 / 飞书第一阶段目标');
    expect(text).toContain('共用服务底座');
    expect(text).toContain('已结束 / 历史');
    expect(result.nodes.some(node=>node.type==='connector')).toBe(true);
    expect(result.height).toBeLessThan(2600);
  });

  it('renders the exact whiteboard nodes into a bounded PNG preview for the chat card',async()=>{
    const board=buildFounderWhiteboard({title:'工作地图',paletteId:'coral',cards:[{
      header:{title:{content:'工作地图 · 1/1'}},elements:[{text:{content:'当前阶段\n正在推进'}}]
    }]});
    const png=await renderFounderWhiteboardPng(board);
    const metadata=await sharp(png).metadata();
    expect(png.subarray(0,8)).toEqual(Buffer.from([137,80,78,71,13,10,26,10]));
    expect(metadata.width).toBe(1160);
    expect(png.byteLength).toBeGreaterThan(1_000);
    expect(png.byteLength).toBeLessThan(10*1024*1024);
  });

  it('does not repeat the previous palette when alternatives exist',()=>{
    expect(selectFounderPalette('coral',()=>0).id).not.toBe('coral');
  });

  it('creates one editable board document and grants the invoking group edit access',async()=>{
    const state:{documentId?:string;boardId?:string;nodes?:unknown[];group?:string;imageBytes?:number}={};
    const artifact=await publishFounderWhiteboard({title:'项目进展 · Smart Listing',paletteId:'coral',chatId:'oc_group',cards:[{
      header:{title:{content:'项目进展 · Smart Listing'}},elements:[{text:{content:'01 当前阶段\n正在推进'}}]
    }]},{
      async uploadMessageImage(input){state.imageBytes=input.body.byteLength;return{imageKey:'img_preview'}},
      async createDocument(){state.documentId='doc_1';return{documentId:'doc_1'}},
      async createBoard(input){expect(input.documentId).toBe('doc_1');state.boardId='board_1';return{whiteboardId:'board_1'}},
      async createNodes(input){state.nodes=[...input.nodes]},
      async grantGroupEdit(input){state.group=input.chatId}
    });
    expect(artifact).toEqual({documentId:'doc_1',whiteboardId:'board_1',url:'https://icnua99ny9c4.feishu.cn/docx/doc_1',paletteId:'coral',previewImageKey:'img_preview'});
    expect(state.imageBytes).toBeGreaterThan(1_000);
    expect(state.nodes?.length).toBeGreaterThan(2);
    expect(state.nodes?.some((node:any)=>node.type==='image')).toBe(false);
    expect(state.group).toBe('oc_group');
  });

  it('retains the uploaded chat preview when editable board creation fails',async()=>{
    let failure:unknown;
    try{
      await publishFounderWhiteboard({title:'工作地图',paletteId:'coral',chatId:'oc_group',cards:[]},{
        async uploadMessageImage(){return{imageKey:'img_preview'}},
        async createDocument(){throw new Error('board unavailable')},
        async createBoard(){throw new Error('unexpected')},async createNodes(){throw new Error('unexpected')},
        async grantGroupEdit(){throw new Error('unexpected')}
      });
    }catch(error){failure=error}
    expect(failure).toBeInstanceOf(FounderWhiteboardPublishError);
    expect((failure as FounderWhiteboardPublishError).previewImageKey).toBe('img_preview');
  });
});

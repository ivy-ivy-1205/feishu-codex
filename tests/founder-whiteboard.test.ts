import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { buildFounderWhiteboard, founderPalettes, FounderWhiteboardPublishError, publishFounderWhiteboard, renderFounderWhiteboardPng, selectFounderPalette } from '../src/services/founder-whiteboard.js';

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

  it('keeps paused projects in their business lane instead of treating them as ended history',()=>{
    const result=buildFounderWhiteboard({title:'工作地图',paletteId:'court-press',cards:[],view:{
      kind:'work_map',since:'2026-08-31T00:00:00.000Z',until:'2026-10-14T05:09:41.892Z',coverageGaps:[],topics:[
        {id:'c',name:'公司协作基础设施',stage:'active_project',kind:'project',outcome:null},
        {id:'active',name:'飞书合伙人对齐',stage:'active_project',kind:'project',outcome:'继续推进',parentName:'公司协作基础设施'},
        {id:'paused',name:'企业微信接入',stage:'paused',kind:'project',outcome:'暂停投入',parentName:'公司协作基础设施'},
        {id:'closed',name:'旧项目',stage:'closed',kind:'project',outcome:'已结束'}
      ]
    }});
    const textNodes=result.nodes.filter(node=>node.type==='text_shape'&&node.text?.text);
    const y=(value:string)=>textNodes.find(node=>node.text!.text!.includes(value))?.y;
    expect(y('企业微信接入')).toBeGreaterThan(y('C / 公司协作基础设施')!);
    expect(y('企业微信接入')).toBeLessThan(y('已结束 / 历史')!);
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

  it('uses only the five approved palettes for work maps while detail views retain all favorites',()=>{
    const approved=new Set(['grove','salmon-stamp','editorial-forest','riso-brut','court-press']);
    const samples=[0,0.12,0.28,0.44,0.56,0.72,0.88,0.999];
    expect(samples.map(random=>selectFounderPalette(null,()=>random,'work_map').id).every(id=>approved.has(id))).toBe(true);
    expect(selectFounderPalette(null,()=>0.52,'project_detail').id).toBe('riptide-cobalt');
  });

  it('adds one 本周 line and a small Space date chip to a Space-bound card, leaving other cards untouched',()=>{
    const base={id:'smart',name:'Smart Listing',stage:'active_project' as const,kind:'project' as const,outcome:'27 Cecil Street 首套 listing 上线',
      parentName:'AiJia AI Native 房产业务',sourceCount:3};
    const view=(smart:Record<string,unknown>)=>({kind:'work_map' as const,since:'2026-08-31T00:00:00.000Z',until:'2026-10-19T08:10:00.000Z',coverageGaps:[],topics:[
      {id:'a',name:'AiJia AI Native 房产业务',stage:'active_project' as const,kind:'project' as const,outcome:null},
      {id:'site',name:'官网',stage:'active_project' as const,kind:'project' as const,outcome:null,parentName:'AiJia AI Native 房产业务'},
      {...base,...smart}]});
    const plain=buildFounderWhiteboard({title:'工作地图',paletteId:'grove',cards:[],view:view({})});
    const withSpace=buildFounderWhiteboard({title:'工作地图',paletteId:'grove',cards:[],view:view({space:{
      weekLine:'本周：买家空间页面上线，开始收集 Amy 反馈；补齐周边学校与交通配套信息和价格口径',label:'Space · 10-19 更新'}})});
    const texts=withSpace.nodes.flatMap(node=>node.text?.text?[{...node.text,text:node.text.text}]:[]);
    const week=texts.find(text=>text.text.startsWith('本周：'))!;
    expect(week.text.split('\n')).toHaveLength(1);
    expect(week.text.endsWith('…')).toBe(true);
    expect(texts.find(text=>text.text==='Space · 10-19 更新')?.font_size).toBeLessThan(17);
    const card=(result:typeof plain)=>result.nodes.find(node=>node.type==='composite_shape'&&node.style?.fill_color!==node.style?.border_color&&
      result.nodes.some(text=>text.text?.text==='Smart Listing'&&text.x===(node.x??0)+18&&text.y===(node.y??0)+16))!;
    expect(card(withSpace).height!).toBeGreaterThan(card(plain).height!);
    const siteNodes=(result:typeof plain)=>result.nodes.filter(node=>node.text?.text==='官网');
    expect(siteNodes(withSpace)).toEqual(siteNodes(plain));
  });

  it('lets the 本周 line run to nearly the full card width before truncating',()=>{
    const result=buildFounderWhiteboard({title:'工作地图',paletteId:'grove',cards:[],view:{kind:'work_map',since:'2026-08-31T00:00:00.000Z',
      until:'2026-10-19T08:10:00.000Z',coverageGaps:[],topics:[
        {id:'a',name:'AiJia AI Native 房产业务',stage:'active_project',kind:'project',outcome:null},
        {id:'site',name:'官网',stage:'active_project',kind:'project',outcome:null,parentName:'AiJia AI Native 房产业务'},
        {id:'smart',name:'Smart Listing',stage:'active_project',kind:'project',outcome:null,parentName:'AiJia AI Native 房产业务',
          space:{weekLine:'本周进展'.repeat(20),label:'Space · 10-19 更新'}}]}});
    const week=result.nodes.find(node=>node.text?.text?.startsWith('本周进展'))!;
    // A-lane card: 522px wide, 486px of text at 19px — about 25 CJK characters.
    expect(Array.from(week.text!.text!).length).toBeGreaterThanOrEqual(25);
    expect(Array.from(week.text!.text!).length*19).toBeLessThanOrEqual(week.width!);
  });

  it('keeps every text node readable against its actual fill in all 25 palettes',()=>{
    for(const palette of founderPalettes){
      const result=buildFounderWhiteboard({title:'工作地图',paletteId:palette.id,cards:[],view:{
        kind:'work_map',since:'2026-08-31T00:00:00.000Z',until:'2026-10-15T00:00:00.000Z',coverageGaps:[{id:'gap',summary:'不可读取 1 条'}],topics:[
          {id:'a',name:'AiJia AI Native 房产业务',stage:'active_project',kind:'project',outcome:'主线'},
          {id:'project',name:'Smart Listing',stage:'active_project',kind:'project',outcome:'项目卡',parentName:'AiJia AI Native 房产业务',
            space:{weekLine:'本周：买家空间页面上线',label:'Space · 10-19 更新'}},
          {id:'site',name:'AiJia AI Native 官网',stage:'active_project',kind:'project',outcome:'官网',parentName:'AiJia AI Native 房产业务'},
          {id:'task',name:'团队更新',stage:'active_project',kind:'task',outcome:'任务卡',parentName:'AiJia AI Native 房产业务'},
          {id:'goal',name:'阶段一',stage:'active_project',kind:'goal',outcome:'目标卡',parentName:'AiJia AI Native 房产业务'},
          {id:'idea',name:'讨论观点',stage:'idea',kind:'idea',outcome:'观点卡',parentName:'AiJia AI Native 房产业务'}
        ]
      }});
      result.nodes.forEach((node,index)=>{
        if(node.type!=='text_shape'||!node.text?.text_color)return;
        const containing=result.nodes.slice(0,index).filter(candidate=>candidate.type==='composite_shape'&&candidate.style?.fill_color&&
          (candidate.x??0)<=(node.x??0)&&(candidate.y??0)<=(node.y??0)&&
          (candidate.x??0)+(candidate.width??0)>=(node.x??0)&&
          (candidate.y??0)+(candidate.height??0)>=(node.y??0));
        const background=containing.at(-1)?.style?.fill_color;
        expect(background,`${palette.id}: background for ${node.text.text}`).toBeTruthy();
        expect(contrastRatio(node.text.text_color,background!),`${palette.id}: ${node.text.text}`).toBeGreaterThanOrEqual(4.5);
      });
    }
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

function contrastRatio(left:string,right:string):number{
  const luminance=(hex:string)=>{const channels=hex.replace('#','').match(/.{2}/g)!.map(value=>parseInt(value,16)/255)
    .map(value=>value<=0.04045?value/12.92:Math.pow((value+0.055)/1.055,2.4));
    return channels[0]!*0.2126+channels[1]!*0.7152+channels[2]!*0.0722};
  const values=[luminance(left),luminance(right)].sort((a,b)=>b-a);
  return(values[0]!+0.05)/(values[1]!+0.05);
}

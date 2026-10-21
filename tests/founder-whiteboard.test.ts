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

  it('wraps every project-progress paragraph inside its box without dropping any text',()=>{
    const direction='当前方向：目前已创建 Space 页面「AiJia Smart Listing 与买家空间项目总览」,地址链接是https://chatgpt.com/space/page_f095a79b4bb48191b797811f8f53862d,具体的项目进展和实施计划都会通过该页面更新,目前计划是上线两个房源';
    const space=['项目页（Space · 页面更新于 10-19 · 同步于 10-21 01:24）','同步缺口：评论未同步（本次只导入了页面正文），评论里的看法暂未计入',
      '页面记载进展（首次同步，未区分本周）：Amy Agent Core V2 的 Task 1–9 已完成；照片位置笔记已上线，支持文字、语音及 Amy 代记；L008 家庭共享已上线，支持共同记录与独立署名',
      '下一步/卡点：下一步 完成 Task 10 验收、生产切换、回滚演练和观察；卡点 家庭数据读取后的最终回复失败，原因仍在排查'].join('\n');
    const status=['处理状态（北京时间）','最后收到：2026-10-20 11:31','最后完成分析：2026-10-21 00:40','最新已分析语料：2026-10-20 12:08',
      '最后防漏复核：2026-10-21 16:44','待处理：0；未补偿分析来源：0；采集失败任务：0；不可读/跳过缺口：99',
      '“待处理为 0”只证明已入库任务没有积压；缺口会单独显示，不把未读取内容算作已覆盖。','Space 页面','已绑定项目：1；活跃：1；权限缺失：0',
      '最后成功同步：2026-10-21 01:24','缺口：1'].join('\n');
    const board=buildFounderWhiteboard({title:'项目进展 · Smart Listing',paletteId:'grove-block',cards:[{header:{title:{content:'项目进展 · Smart Listing'}},
      elements:[direction,space,status].map(content=>({text:{content}}))}]});
    const ems=(line:string)=>Array.from(line).reduce((sum,char)=>sum+(/[\p{Script=Han}\u3000-\u303F\uFF00-\uFFEF“”（）]/u.test(char)?1:0.62),0);
    const boxes=board.nodes.filter(node=>node.type==='composite_shape'&&node.x!==0);
    const bodies=board.nodes.filter(node=>node.type==='text_shape'&&(node.y??0)>=150);
    expect(bodies).toHaveLength(4);
    for(const node of bodies){
      const font=node.text!.font_size!,lines=node.text!.text!.split('\n');
      for(const line of lines)expect(ems(line)*font).toBeLessThanOrEqual(node.width!);
      expect(node.height!).toBeGreaterThanOrEqual(lines.length*Math.round(font*1.38));
      const box=boxes.find(b=>b.x!<=node.x!&&b.y!<=node.y!&&node.x!+node.width!<=b.x!+b.width!&&node.y!<b.y!+b.height!);
      expect(box).toBeDefined();
      expect(node.y!+node.height!).toBeLessThanOrEqual(box!.y!+box!.height!);
    }
    const flat=(value:string)=>value.replace(/\s+/gu,'');
    const shown=flat(bodies.map(node=>node.text!.text!).join(''));
    for(const original of [direction,space,status])expect(shown).toContain(flat(original));
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

  it('shows closed topics as compact dated rows, merges ideas per line and moves dormant topics out of their line',()=>{
    const result=buildFounderWhiteboard({title:'工作地图',paletteId:'grove',cards:[],view:{
      kind:'work_map',since:'2026-08-31T00:00:00.000Z',until:'2026-10-19T00:00:00.000Z',coverageGaps:[],topics:[
        {id:'a',name:'AiJia AI Native 房产业务',stage:'active_project',kind:'project',outcome:null},
        {id:'kb',name:'AI 选房经验与知识库',stage:'active_project',kind:'project',outcome:'等待 Jimmy',parentName:'AiJia AI Native 房产业务',dormant:true},
        {id:'sl',name:'Smart Listing',stage:'active_project',kind:'project',outcome:'上线',parentName:'AiJia AI Native 房产业务'},
        {id:'b',name:'自媒体生产线',stage:'active_project',kind:'project',outcome:null},
        {id:'i1',name:'孵化这个 AI 产业落地',stage:'idea',kind:'idea',outcome:'观点讨论',parentName:'自媒体生产线'},
        {id:'i2',name:'AI 蒸馏学习主题',stage:'idea',kind:'idea',outcome:'学习方法展示',parentName:'自媒体生产线'},
        {id:'ep',name:'EP00《挺好》',stage:'closed',kind:'project',outcome:'EP00《挺好》已经发布，本内容项目已关闭。',parentName:'自媒体生产线',
          closedAt:'2026-10-14T08:18:40.206Z'},
        {id:'old',name:'旧任务',stage:'closed',kind:'task',outcome:null,closedAt:null}
      ]}});
    const texts=result.nodes.flatMap(node=>node.text?.text?[node.text.text]:[]);
    // Not a card in its line any more; only a row in the 长期无动态 section.
    expect(texts).not.toContain('AI 选房经验与知识库');
    expect(texts.some(text=>text.startsWith('AI 选房经验与知识库 · '))).toBe(true);
    expect(texts.find(text=>text.startsWith('观点 2 条'))?.replace(/\n/gu,'')).toBe('观点 2 条：孵化这个 AI 产业落地 · AI 蒸馏学习主题');
    expect(texts.some(text=>text.startsWith('观点 / '))).toBe(false);
    expect(texts.find(text=>text.startsWith('EP00《挺好》 · 10-14 结束 · '))).toBeTruthy();
    expect(texts).toContain('任务 / 旧任务');
    // One compact row per closed item, not a full card with a stage/source footer.
    expect(texts.filter(text=>text==='已结束')).toHaveLength(0);
  });

  it('highlights long-dormant topics in their own section between current work and closed history',()=>{
    const result=buildFounderWhiteboard({title:'工作地图',paletteId:'grove',cards:[],view:{
      kind:'work_map',since:'2026-08-31T00:00:00.000Z',until:'2026-10-19T00:00:00.000Z',coverageGaps:[],topics:[
        {id:'a',name:'AiJia AI Native 房产业务',stage:'active_project',kind:'project',outcome:null},
        {id:'sl',name:'Smart Listing',stage:'active_project',kind:'project',outcome:'上线',parentName:'AiJia AI Native 房产业务'},
        {id:'kb',name:'AI 选房经验与知识库',stage:'active_project',kind:'project',outcome:'当前仍未收到 Jimmy 的回复',
          parentName:'AiJia AI Native 房产业务',dormant:true,lastActivityAt:'2026-09-02T11:51:51.849Z'},
        {id:'c',name:'公司协作基础设施',stage:'active_project',kind:'project',outcome:null},
        {id:'wx',name:'企业微信接入',stage:'paused',kind:'project',outcome:null,parentName:'公司协作基础设施',
          dormant:true,lastActivityAt:'2026-09-25T00:00:00.000Z'},
        {id:'ep',name:'EP00《挺好》',stage:'closed',kind:'project',outcome:'已发布',closedAt:'2026-10-14T08:18:40.206Z'}
      ]}});
    const textNodes=result.nodes.filter(node=>node.type==='text_shape'&&node.text?.text);
    const y=(prefix:string)=>textNodes.find(node=>node.text!.text!.startsWith(prefix))?.y;
    expect(y('暂停 / 长期无动态 2 项')).toBeGreaterThan(y('C / 公司协作基础设施')!);
    expect(y('暂停 / 长期无动态 2 项')).toBeLessThan(y('已结束 / 历史')!);
    expect(textNodes.some(node=>node.text!.text!.includes('继续、暂停还是结束'))).toBe(true);
    // Section headers alternate palette colors by function: history keeps a colored block distinct from the dormant one.
    const header=(label:string)=>result.nodes.find(node=>node.type==='composite_shape'&&node.height===58&&
      textNodes.some(text=>text.text!.text===label&&text.y===(node.y??0)+14))?.style?.fill_color;
    const grove=founderPalettes.find(palette=>palette.id==='grove')!;
    expect(header('已结束 / 历史')).toBe(grove.accent);
    expect(header('暂停 / 长期无动态 2 项')).toBe(grove.highlight);
    expect(header('已结束 / 历史')).not.toBe(header('暂停 / 长期无动态 2 项'));
    // Stalest first, with how long it has been quiet and the last recorded state (what it is waiting on).
    expect(y('AI 选房经验与知识库 · 46 天无动态 · 当前仍未收到 Jimmy 的回复')).toBeLessThan(y('企业微信接入 · 暂停 · 未记录卡点')!);
    expect(textNodes.some(node=>node.text!.text!.startsWith('暂停或超过 30 天没有新动态'))).toBe(true);
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
          {id:'idea',name:'讨论观点',stage:'idea',kind:'idea',outcome:'观点卡',parentName:'AiJia AI Native 房产业务'},
          {id:'quiet',name:'沉睡项目',stage:'active_project',kind:'project',outcome:'等待外部回复',parentName:'AiJia AI Native 房产业务',
            dormant:true,lastActivityAt:'2026-09-01T00:00:00.000Z'},
          {id:'gone',name:'旧项目',stage:'closed',kind:'project',outcome:'已结束',closedAt:'2026-10-01T00:00:00.000Z'}
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

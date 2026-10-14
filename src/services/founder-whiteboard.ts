import sharp from 'sharp';
import type { FounderBoardView, FounderWorkMapBoardTopic, FounderWorkMapBoardView } from './founder-board-view.js';

export interface FounderWhiteboardNode {
  id?:string;
  type:'text_shape'|'composite_shape'|'connector'|'group';
  x?:number;y?:number;width?:number;height?:number;
  text?:{text?:string;font_weight?:'regular'|'bold';font_size?:number;text_color?:string;horizontal_align?:'left'|'center'|'right';vertical_align?:'top'|'mid'|'bottom';
    line_through?:boolean;underline?:boolean;italic?:boolean;angle?:number;text_color_type?:number;text_background_color_type?:number;
    theme_text_color_code?:number;theme_text_background_color_code?:number};
  style?:{fill_color?:string;border_color?:string;border_style?:'solid'|'none';border_width?:'extra_narrow'|'narrow'|'medium'|'bold'};
  composite_shape?:{type:'rect'};
  connector?:{caption_auto_direction:false;shape:'straight';specified_coordinate:true;
    start:{arrow_style:'none';position:{x:number;y:number}};end:{arrow_style:'none';position:{x:number;y:number}};turning_points:[]};
}

export interface FounderPalette {
  id:string;name:string;paper:string;accent:string;secondary:string;highlight:string;ink:string;surface:string;recess:string;
}
export interface FounderWhiteboardArtifact {
  documentId:string;whiteboardId:string;url:string;paletteId:string;previewImageKey:string;
}
export class FounderWhiteboardPublishError extends Error {
  constructor(readonly previewImageKey:string,readonly original:unknown){super('Founder editable whiteboard publish failed');}
}
export interface FounderWhiteboardGateway {
  uploadMessageImage(input:{body:Buffer}):Promise<{imageKey:string}>;
  createDocument(input:{title:string}):Promise<{documentId:string}>;
  createBoard(input:{documentId:string;width:number;height:number}):Promise<{whiteboardId:string}>;
  createNodes(input:{whiteboardId:string;nodes:readonly FounderWhiteboardNode[]}):Promise<void>;
  grantGroupEdit(input:{documentId:string;chatId:string}):Promise<void>;
}
export interface BuiltFounderWhiteboard {palette:FounderPalette;width:number;height:number;nodes:FounderWhiteboardNode[]}

const paletteRows:[string,string,string[]][]=[
  ['grove','Grove',['#E8E4D6','#192B1B','#C8524A']],['jade-lens','Jade Lens',['#F5F1EE','#2BA483','#1E2421']],
  ['macchiato','Macchiato',['#EDE7DD','#25211B','#6E6558']],['papier-bleu','Papier Bleu',['#FAF3EB','#72D0E9','#1A3C8F']],
  ['reading-room','Reading Room',['#F6EBD8','#DE916A','#D6C7CC']],['salmon-stamp','Salmon Stamp',['#FFFFFF','#F0AE9E','#049550']],
  ['apricot-arc','Apricot Arc',['#FFF8EE','#F69834','#F9C2BD']],['checker-bloom','Checker Bloom',['#E8F1DD','#2C6EE0','#5E9E4A']],
  ['coral','Coral',['#F5F0E8','#E85D5D','#1A1A1A']],['cut-bloom','Cut Bloom',['#FFFFFF','#535D9E','#F0CB65']],
  ['editorial-forest','Editorial Forest',['#EFE7D4','#2E4A2A','#E89CB1']],['linen-cut','Linen Cut',['#E4D2C4','#044D99','#04B24F']],
  ['pin-and-paper','Pin & Paper',['#FFFFFF','#2A3C99','#F1E84E']],['riptide-cobalt','Riptide Cobalt',['#FDF0E0','#375DFE','#1A2240']],
  ['soft-editorial','Soft Editorial',['#ECE9DC','#E2A8CE','#C9DA4F']],['violet-marker','Violet Marker',['#FFFFFF','#C5A1FF','#CFEE30']],
  ['block-frame','BlockFrame',['#FFFDF5','#FE90E8','#C0F7FE','#000000']],['confetti-wedge','Confetti Wedge',['#F4F8FB','#F8BED4','#62C0A5']],
  ['court-press','Court Press',['#F2EFE6','#66914C','#DA9EB7']],['grove-block','Grove Block',['#F7F1EC','#008248','#F6BDDA','#FCC715']],
  ['mint-brut','Mint Brut',['#D0FDE4','#F888C8','#000000']],['riso-brut','Riso Brut',['#EFE9D9','#1F8A4C','#F06CA8','#E85A1F']],
  ['specimen-bold','Specimen Bold',['#F3F3F3','#2E302E','#3EC06A','#FBEF4A']],['stencil-tablet','Stencil & Tablet',['#E2DCC9','#EE7A2E','#C73B7A','#2D7E73']],
  ['avocado-press','Avocado Press',['#FFFFFF','#0055A4','#DCF4A2']]
];

export const founderPalettes:FounderPalette[]=paletteRows.map(([id,name,colors])=>{
  const paper=colors[0]!,accent=colors[1]!,secondary=colors[2]??accent,highlight=colors[3]??secondary;
  const darkestColor=darkest(colors.slice(1)),ink=luminance(darkestColor)<72?darkestColor:'#171714';
  return{id,name,paper,accent,secondary,highlight,ink,surface:mix(paper,'#FFFFFF',0.68),recess:mix(paper,secondary,0.14)};
});

export function selectFounderPalette(previousId:string|null|undefined,random:()=>number=Math.random):FounderPalette{
  const available=founderPalettes.filter(item=>item.id!==previousId);
  return available[Math.min(available.length-1,Math.max(0,Math.floor(random()*available.length)))]!;
}

export function buildFounderWhiteboard(input:{title:string;paletteId:string;cards:readonly Record<string,unknown>[];view?:FounderBoardView}):BuiltFounderWhiteboard{
  const palette=founderPalettes.find(item=>item.id===input.paletteId)??founderPalettes[0]!;
  return input.view?.kind==='work_map'?buildWorkMapBoard(input.title,palette,input.view):buildGenericBoard(input.title,palette,input.cards);
}

export async function renderFounderWhiteboardPng(board:BuiltFounderWhiteboard):Promise<Buffer>{
  return sharp(Buffer.from(whiteboardSvg(board))).resize({width:1160,withoutEnlargement:true}).png({compressionLevel:9,palette:true}).toBuffer();
}

export async function publishFounderWhiteboard(input:{title:string;paletteId:string;chatId:string;
  cards:readonly Record<string,unknown>[];view?:FounderBoardView},gateway:FounderWhiteboardGateway):Promise<FounderWhiteboardArtifact>{
  const board=buildFounderWhiteboard(input),preview=await renderFounderWhiteboardPng(board);
  if(preview.byteLength>=10*1024*1024)throw new Error('whiteboard preview exceeds Feishu image limit');
  const uploaded=await gateway.uploadMessageImage({body:preview});
  if(!uploaded.imageKey.trim())throw new Error('whiteboard preview image key is required');
  try{
    const document=await gateway.createDocument({title:input.title});
    if(!document.documentId.trim())throw new Error('whiteboard document id is required');
    const created=await gateway.createBoard({documentId:document.documentId,width:board.width,height:board.height});
    if(!created.whiteboardId.trim())throw new Error('whiteboard id is required');
    await gateway.createNodes({whiteboardId:created.whiteboardId,nodes:board.nodes});
    await gateway.grantGroupEdit({documentId:document.documentId,chatId:input.chatId});
    return{documentId:document.documentId,whiteboardId:created.whiteboardId,
      url:`https://icnua99ny9c4.feishu.cn/docx/${document.documentId}`,paletteId:board.palette.id,previewImageKey:uploaded.imageKey};
  }catch(error){throw new FounderWhiteboardPublishError(uploaded.imageKey,error)}
}

function buildGenericBoard(title:string,palette:FounderPalette,cards:readonly Record<string,unknown>[]):BuiltFounderWhiteboard{
  const lines=cards.flatMap(card=>cardLines(card)),width=1680,columnWidth=760,startY=180;
  const blocks=lines.map((value,index)=>({value,index,height:Math.max(96,64+Math.ceil(Array.from(value).length/38)*34)}));
  const columns:[typeof blocks,typeof blocks]=[[],[]];const heights=[startY,startY];
  for(const block of blocks){const column=heights[0]!<=heights[1]!?0:1;columns[column]!.push(block);heights[column]!+=block.height+28;}
  const height=Math.max(720,...heights)+80,nodes:FounderWhiteboardNode[]=[];
  nodes.push(shape(0,0,width,height,palette.paper,palette.paper,'none'));
  nodes.push(textNode(48,44,1200,72,title,48,palette.ink,'bold'));
  nodes.push(textNode(1320,52,300,52,palette.name,22,palette.ink,'regular','right'));
  columns.forEach((column,columnIndex)=>{let y=startY;for(const block of column){const x=40+columnIndex*(columnWidth+80);
    nodes.push(shape(x,y,columnWidth,block.height,palette.surface,palette.accent));
    nodes.push(textNode(x+26,y+22,columnWidth-52,block.height-40,block.value,24,palette.ink,block.index===0?'bold':'regular'));
    y+=block.height+28;
  }});
  return{palette,width,height,nodes};
}

interface Placement {topic:FounderWorkMapBoardTopic;x:number;y:number;width:number;height:number;depth:number}
interface LaneLayout {x:number;y:number;width:number;height:number;placements:Placement[];label:string;color:string;footer?:string}

function buildWorkMapBoard(title:string,palette:FounderPalette,view:FounderWorkMapBoardView):BuiltFounderWhiteboard{
  const width=1160,margin=28,top=142,gap=24,contentWidth=width-margin*2,halfWidth=(contentWidth-gap)/2;
  const lineNames={A:'AiJia AI Native 房产业务',B:'自媒体生产线',C:'公司协作基础设施'} as const;
  const byName=new Map(view.topics.map(topic=>[topic.name,topic]));
  const root=(topic:FounderWorkMapBoardTopic):string=>{let current=topic,guard=0;while(current.parentName&&guard++<20){const parent=byName.get(current.parentName);if(!parent)break;current=parent}return current.name};
  const visible=view.topics.filter(topic=>!Object.values(lineNames).includes(topic.name as typeof lineNames[keyof typeof lineNames]));
  const history=visible.filter(topic=>topic.stage==='closed');
  const current=visible.filter(topic=>topic.stage!=='closed');
  const a=current.filter(topic=>root(topic)===lineNames.A),b=current.filter(topic=>root(topic)===lineNames.B),c=current.filter(topic=>root(topic)===lineNames.C);
  const classified=new Set([...a,...b,...c].map(topic=>topic.id)),other=visible.filter(topic=>!classified.has(topic.id));
  const currentOther=other.filter(topic=>topic.stage!=='closed'&&topic.stage!=='paused');
  const sharedFoundation=a.some(topic=>topic.name==='AiJia AI Native 官网')&&a.some(topic=>topic.name==='Smart Listing')?
    '共用服务底座 · Amy · 客户记录 · 知识 · 任务承接':undefined;
  const laneA=layoutLane(a,margin,top,contentWidth,2,'A / AI Native 房产业务',palette.accent,byName,lineNames.A,sharedFoundation);
  const lowerY=laneA.y+laneA.height+gap;
  const laneB=layoutLane(b,margin,lowerY,halfWidth,1,'B / 自媒体生产线',palette.secondary,byName,lineNames.B);
  const laneC=layoutLane(c,margin+halfWidth+gap,lowerY,halfWidth,1,'C / 公司协作基础设施',palette.accent,byName,lineNames.C);
  const mainBottom=Math.max(laneB.y+laneB.height,laneC.y+laneC.height),lowerSectionsY=mainBottom+gap;
  const otherLane=currentOther.length?layoutLane(currentOther,margin,lowerSectionsY,history.length?halfWidth:contentWidth,
    history.length?1:2,'待核对 / 其他项目',palette.highlight,byName,null):null;
  const historyLane=history.length?layoutLane(history,otherLane?margin+halfWidth+gap:margin,lowerSectionsY,
    otherLane?halfWidth:contentWidth,1,'已结束 / 历史',palette.secondary,byName,null):null;
  const gapHeight=view.coverageGaps.length?88+view.coverageGaps.length*34:0;
  const contentBottom=Math.max(mainBottom,...[otherLane,historyLane].flatMap(lane=>lane?[lane.y+lane.height]:[]));
  const height=Math.max(900,contentBottom+gapHeight+80);
  const nodes:FounderWhiteboardNode[]=[shape(0,0,width,height,palette.paper,palette.paper,'none')];
  nodes.push(textNode(margin,26,720,56,title==='工作地图'?'共同工作地图':title,42,palette.ink,'bold'));
  nodes.push(textNode(margin,84,760,36,'房产业务、内容生产、协作基础设施，放回各自的主线。',21,palette.ink,'regular'));
  nodes.push(textNode(820,34,312,30,`${palette.name} · ${dateLabel(view.until)}`,17,palette.ink,'regular','right'));
  for(const lane of [laneA,laneB,laneC,...(otherLane?[otherLane]:[]),...(historyLane?[historyLane]:[])])appendLane(nodes,lane,palette,byName);
  if(view.coverageGaps.length){const y=contentBottom+gap;nodes.push(shape(margin,y,width-margin*2,gapHeight-24,palette.recess,palette.ink));
    nodes.push(textNode(margin+22,y+18,280,36,'覆盖缺口 / 待核对',23,palette.ink,'bold'));
    nodes.push(textNode(margin+292,y+18,width-margin*2-318,gapHeight-42,
      view.coverageGaps.map(item=>`• ${wrapText(item.summary,54,2)}`).join('\n'),19,palette.ink,'regular'));
  }
  return{palette,width,height,nodes};
}

function layoutLane(topics:readonly FounderWorkMapBoardTopic[],x:number,y:number,width:number,columns:number,label:string,color:string,
  byName:ReadonlyMap<string,FounderWorkMapBoardTopic>,lineRoot:string|null,footer?:string):LaneLayout{
  const padding=20,header=58,columnGap=20,columnWidth=(width-padding*2-columnGap*(columns-1))/columns;
  const heights=Array.from({length:columns},()=>y+header+padding),placements:Placement[]=[];
  const names=new Set(topics.map(topic=>topic.name)),children=new Map<string,FounderWorkMapBoardTopic[]>();
  for(const topic of topics){if(topic.parentName&&names.has(topic.parentName)){const list=children.get(topic.parentName)??[];list.push(topic);children.set(topic.parentName,list)}}
  const roots=topics.filter(topic=>!topic.parentName||topic.parentName===lineRoot||!names.has(topic.parentName));
  const visited=new Set<string>();
  const subtree=(topic:FounderWorkMapBoardTopic):FounderWorkMapBoardTopic[]=>{
    if(visited.has(topic.id))return[];visited.add(topic.id);
    return[topic,...(children.get(topic.name)??[]).flatMap(child=>subtree(child))];
  };
  const groups=[...roots.flatMap(root=>[subtree(root)]),...topics.filter(topic=>!visited.has(topic.id)).map(topic=>subtree(topic))].filter(group=>group.length);
  for(const group of groups){const column=heights.indexOf(Math.min(...heights));
    for(const topic of group){const depth=topicDepth(topic,byName,lineRoot),indent=Math.min(2,Math.max(0,depth-1))*16,cardWidth=columnWidth-indent;
      const title=topic.kind==='goal'?`阶段目标 / ${topic.name}`:topic.kind==='task'?`任务 / ${topic.name}`:
        topic.kind==='idea'?`观点 / ${topic.name}`:topic.name;
      const titleLines=wrapText(title,textUnits(cardWidth-36,26),2).split('\n').length;
      const body=topic.outcome?.trim()?wrapText(topic.outcome,textUnits(cardWidth-36,21),2):'';
      const bodyLines=body?body.split('\n').length:0,cardHeight=32+titleLines*34+(bodyLines?10+bodyLines*29:0)+34;
      const placement={topic,x:x+padding+column*(columnWidth+columnGap)+indent,y:heights[column]!,width:cardWidth,height:cardHeight,depth};
      placements.push(placement);heights[column]=placement.y+cardHeight+cardGap;
    }
  }
  return{x,y,width,height:Math.max(y+150,...heights)-y+2+(footer?64:0),placements,label,color,...(footer?{footer}:{})};
}

const cardGap=18;
function appendLane(nodes:FounderWhiteboardNode[],lane:LaneLayout,palette:FounderPalette,byName:ReadonlyMap<string,FounderWorkMapBoardTopic>):void{
  nodes.push(shape(lane.x,lane.y,lane.width,lane.height,palette.recess,palette.ink));
  nodes.push(shape(lane.x,lane.y,lane.width,58,lane.color,palette.ink));
  nodes.push(textNode(lane.x+18,lane.y+14,lane.width-36,36,lane.label,27,contrast(lane.color),'bold'));
  const positionByName=new Map<string,Placement>();
  for(const placement of lane.placements)positionByName.set(placement.topic.name,placement);
  for(const placement of lane.placements){const parent=placement.topic.parentName?positionByName.get(placement.topic.parentName):undefined;
    if(parent)nodes.push(connector(parent.x+parent.width/2,parent.y+parent.height,placement.x+placement.width/2,placement.y,palette.ink));
    else if(placement.topic.parentName&&byName.has(placement.topic.parentName)&&placement.depth>1)nodes.push(connector(placement.x-12,placement.y+16,placement.x,placement.y+16,palette.ink));
  }
  for(const placement of lane.placements){const {topic,x,y,width,height}=placement,fill=topic.kind==='project'?palette.surface:topic.kind==='goal'?palette.secondary:palette.highlight;
    nodes.push(shape(x+6,y+6,width,height,palette.ink,palette.ink,'none'));
    nodes.push(shape(x,y,width,height,fill,palette.ink));
    const title=topic.kind==='goal'?`阶段目标 / ${topic.name}`:topic.kind==='task'?`任务 / ${topic.name}`:
      topic.kind==='idea'?`观点 / ${topic.name}`:topic.name;
    const wrappedTitle=wrapText(title,textUnits(width-36,26),2),titleLines=wrappedTitle.split('\n').length;
    nodes.push(textNode(x+18,y+16,width-36,titleLines*34,wrappedTitle,26,palette.ink,'bold'));
    if(topic.outcome)nodes.push(textNode(x+18,y+22+titleLines*34,width-36,height-86,
      wrapText(topic.outcome,textUnits(width-36,21),2),21,palette.ink,'regular'));
    const meta=[stageLabel(topic.stage),topic.sourceCount?`${topic.sourceCount} 个来源`:null].filter(Boolean).join(' · ');
    nodes.push(textNode(x+18,y+height-30,width-36,22,meta,17,palette.ink,'regular'));
  }
  if(lane.footer){const y=lane.y+lane.height-54;
    nodes.push(shape(lane.x+20,y,lane.width-40,38,palette.secondary,palette.ink));
    nodes.push(textNode(lane.x+36,y+8,lane.width-72,28,lane.footer,19,palette.ink,'bold'));
  }
}

function topicDepth(topic:FounderWorkMapBoardTopic,byName:ReadonlyMap<string,FounderWorkMapBoardTopic>,lineRoot:string|null):number{
  let depth=0,current=topic,guard=0;while(current.parentName&&guard++<20){depth++;if(current.parentName===lineRoot)break;const parent=byName.get(current.parentName);if(!parent)break;current=parent}return depth;
}

function cardLines(card:Record<string,unknown>):string[]{
  const header=(card.header as {title?:{content?:unknown}}|undefined)?.title?.content,elements=Array.isArray(card.elements)?card.elements:[];
  return[typeof header==='string'?header:'',...elements.flatMap(element=>{const content=(element as {text?:{content?:unknown}})?.text?.content;return typeof content==='string'&&content.trim()?[content.trim()]:[]})].filter(Boolean);
}
function shape(x:number,y:number,width:number,height:number,fill:string,border:string,borderStyle:'solid'|'none'='solid'):FounderWhiteboardNode{return{
  type:'composite_shape',x,y,width,height,composite_shape:{type:'rect'},style:{fill_color:fill,border_color:border,border_style:borderStyle,border_width:'narrow'}};}
function textNode(x:number,y:number,width:number,height:number,value:string,fontSize:number,color:string,fontWeight:'regular'|'bold',align:'left'|'center'|'right'='left'):FounderWhiteboardNode{return{
  type:'text_shape',x,y,width,height,text:{text:value,font_size:fontSize,font_weight:fontWeight,text_color:color,horizontal_align:align,vertical_align:'top',
    line_through:false,underline:false,italic:false,angle:0,text_color_type:0,text_background_color_type:0,theme_text_color_code:-1,theme_text_background_color_code:-1}};}
function connector(x1:number,y1:number,x2:number,y2:number,color:string):FounderWhiteboardNode{return{type:'connector',x:Math.min(x1,x2),y:Math.min(y1,y2),width:Math.abs(x2-x1),height:Math.abs(y2-y1),
  connector:{caption_auto_direction:false,shape:'straight',specified_coordinate:true,start:{arrow_style:'none',position:{x:x1,y:y1}},end:{arrow_style:'none',position:{x:x2,y:y2}},turning_points:[]},
  style:{border_color:color,border_style:'solid',border_width:'narrow'}};}

function whiteboardSvg(board:BuiltFounderWhiteboard):string{
  const parts=[`<svg xmlns="http://www.w3.org/2000/svg" width="${board.width}" height="${board.height}" viewBox="0 0 ${board.width} ${board.height}">`,'<style>text{font-family:"Noto Sans CJK SC","Noto Sans SC","PingFang SC",sans-serif}</style>'];
  for(const node of board.nodes){
    if(node.type==='composite_shape'){const style=node.style??{};parts.push(`<rect x="${node.x??0}" y="${node.y??0}" width="${node.width??0}" height="${node.height??0}" fill="${style.fill_color??'none'}"${style.border_style==='none'?'':` stroke="${style.border_color??'#000000'}" stroke-width="${borderWidth(style.border_width)}"`}/>`);continue}
    if(node.type==='connector'&&node.connector){const start=node.connector.start.position,end=node.connector.end.position,style=node.style??{};parts.push(`<line x1="${start.x}" y1="${start.y}" x2="${end.x}" y2="${end.y}" stroke="${style.border_color??'#000000'}" stroke-width="${borderWidth(style.border_width)}"/>`);continue}
    if(node.type==='text_shape'&&node.text?.text){const font=node.text.font_size??20,lineHeight=Math.round(font*1.38),anchor=node.text.horizontal_align==='right'?'end':node.text.horizontal_align==='center'?'middle':'start';
      const x=(node.x??0)+(anchor==='end'?(node.width??0):anchor==='middle'?(node.width??0)/2:0),y=(node.y??0)+font;
      parts.push(`<text x="${x}" y="${y}" font-size="${font}" font-weight="${node.text.font_weight==='bold'?700:400}" fill="${node.text.text_color??'#000000'}" text-anchor="${anchor}">`);
      node.text.text.split('\n').forEach((line,index)=>parts.push(`<tspan x="${x}" dy="${index===0?0:lineHeight}">${xml(line)}</tspan>`));parts.push('</text>');
    }
  }
  parts.push('</svg>');return parts.join('');
}
function textUnits(width:number,fontSize:number):number{return Math.max(8,Math.floor(width/(fontSize*1.14)))}
function wrapText(value:string,limit:number,maxLines:number):string{
  const chars=Array.from(value.replace(/\s+/gu,' ').trim()),lines:string[]=[];let line='',units=0,index=0;
  const weight=(char:string)=>/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(char)?1:/[A-Z0-9]/u.test(char)?0.72:/\s/u.test(char)?0.34:0.58;
  for(;index<chars.length;index++){const char=chars[index]!,next=units+weight(char);if(line&&next>limit){
    if(/[，。；：！？、,.!?:;）】]/u.test(char)){line+=char;units=next;continue}
    lines.push(line.trimEnd());if(lines.length===maxLines)break;line='';units=0
  }line+=char;units+=weight(char)}
  if(lines.length<maxLines&&line)lines.push(line.trimEnd());
  if(index<chars.length&&lines.length){const last=Array.from(lines.at(-1)!);lines[lines.length-1]=`${last.slice(0,Math.max(0,last.length-1)).join('')}…`}
  return lines.join('\n');
}
function stageLabel(stage:FounderWorkMapBoardTopic['stage']):string{return({active_project:'推进中',project_candidate:'候选',exploring:'探索中',idea:'想法',paused:'暂停',closed:'已结束'} as const)[stage]}
function dateLabel(value:string):string{const date=new Date(value);return Number.isFinite(date.getTime())?date.toISOString().slice(0,10):value}
function borderWidth(value:string|undefined):number{return value==='bold'?5:value==='medium'?4:value==='narrow'?3:2}
function xml(value:string):string{return value.replace(/&/gu,'&amp;').replace(/</gu,'&lt;').replace(/>/gu,'&gt;').replace(/"/gu,'&quot;')}
function contrast(hex:string):string{return luminance(hex)>150?'#111111':'#FFFFFF'}
function darkest(colors:string[]):string{return[...colors].sort((a,b)=>luminance(a)-luminance(b))[0]??'#1A1A1A'}
function luminance(hex:string):number{const rgb=hex.replace('#','').match(/.{2}/g)?.map(v=>parseInt(v,16))??[0,0,0];return rgb[0]!*0.2126+rgb[1]!*0.7152+rgb[2]!*0.0722}
function mix(a:string,b:string,weight:number):string{const channel=(value:string)=>value.replace('#','').match(/.{2}/g)?.map(v=>parseInt(v,16))??[0,0,0],aa=channel(a),bb=channel(b);
  return`#${aa.map((value,index)=>Math.round(value*(1-weight)+bb[index]!*weight).toString(16).padStart(2,'0')).join('').toUpperCase()}`;}

import sharp from 'sharp';
import {
  founderPhaseLegend, founderPhaseMark, founderPhasesTitle,
  type FounderBoardView, type FounderProjectProgressBoardView, type FounderWorkMapBoardTopic, type FounderWorkMapBoardView
} from './founder-board-view.js';

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
export type FounderPalettePool='work_map'|'project_detail';

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

const workMapPaletteIds=new Set(['grove','salmon-stamp','editorial-forest','riso-brut','court-press']);

export function selectFounderPalette(previousId:string|null|undefined,random:()=>number=Math.random,pool:FounderPalettePool='project_detail'):FounderPalette{
  const candidates=pool==='work_map'?founderPalettes.filter(item=>workMapPaletteIds.has(item.id)):founderPalettes;
  const available=candidates.length>1?candidates.filter(item=>item.id!==previousId):candidates;
  return available[Math.min(available.length-1,Math.max(0,Math.floor(random()*available.length)))]!;
}

export function buildFounderWhiteboard(input:{title:string;paletteId:string;cards:readonly Record<string,unknown>[];view?:FounderBoardView}):BuiltFounderWhiteboard{
  const palette=founderPalettes.find(item=>item.id===input.paletteId)??founderPalettes[0]!;
  return input.view?.kind==='work_map'?buildWorkMapBoard(input.title,palette,input.view):
    input.view?.kind==='project_progress'?buildProjectProgressBoard(palette,input.view):buildGenericBoard(input.title,palette,input.cards);
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
  const lines=cards.flatMap(card=>cardLines(card)),width=1680,columnWidth=760,startY=180,fontSize=24,lineHeight=Math.round(fontSize*1.38);
  // Each paragraph is wrapped to the box width here; the board and its PNG preview do not wrap text on their own,
  // and the box height follows the wrapped line count so long and many-line blocks stay inside their box.
  const units=textUnits(columnWidth-52,fontSize);
  const blocks=lines.map((raw,index)=>{const value=raw.split('\n').map(line=>line.trim()?wrapText(line,units,200):'').join('\n');
    return{value,index,height:Math.max(96,44+value.split('\n').length*lineHeight)};});
  const columns:[typeof blocks,typeof blocks]=[[],[]];const heights=[startY,startY];
  for(const block of blocks){const column=heights[0]!<=heights[1]!?0:1;columns[column]!.push(block);heights[column]!+=block.height+28;}
  const height=Math.max(720,...heights)+80,nodes:FounderWhiteboardNode[]=[];
  nodes.push(shape(0,0,width,height,palette.paper,palette.paper,'none'));
  nodes.push(textNode(48,44,1200,72,title,48,palette.ink,'bold'));
  nodes.push(textNode(1320,52,300,52,palette.name,22,palette.ink,'regular','right'));
  columns.forEach((column,columnIndex)=>{let y=startY;for(const block of column){const x=40+columnIndex*(columnWidth+80);
    nodes.push(shape(x,y,columnWidth,block.height,palette.surface,palette.accent));
    nodes.push(textNode(x+26,y+22,columnWidth-52,block.height-40,block.value,fontSize,palette.ink,block.index===0?'bold':'regular'));
    y+=block.height+28;
  }});
  return{palette,width,height,nodes};
}

/**
 * 查看项目进展 as a board in Ivy's reading order (2026-10-22): the title once, 项目定位 and 阶段规划 across the full width,
 * then 已完成|正在做, 待推进|卡点与问题, 分歧|下一步计划 side by side, and the one-line 资料截至 footer last.
 */
function buildProjectProgressBoard(palette:FounderPalette,view:FounderProjectProgressBoardView):BuiltFounderWhiteboard{
  const width=1160,margin=28,gap=20,band=46,pad=18,contentWidth=width-margin*2,halfWidth=(contentWidth-gap)/2;
  const bodyFont=20,bodyLine=Math.round(bodyFont*1.38),nodes:FounderWhiteboardNode[]=[],paperText=readableText(palette.paper);
  const wrapped=(value:string,boxWidth:number,font:number,maxLines:number)=>wrapText(value,fullLineUnits(boxWidth,font),maxLines);
  const items=(values:readonly string[],boxWidth:number)=>values.length?values.map(value=>wrapped(`• ${value}`,boxWidth,bodyFont,4)).join('\n'):'无';
  const lineCount=(value:string)=>value.split('\n').length;
  /** A box with a colored header band; returns the y below it. */
  const box=(x:number,y:number,boxWidth:number,height:number,title:string,headerFill:string)=>{
    nodes.push(shape(x+6,y+6,boxWidth,height,palette.ink,palette.ink,'none'));
    nodes.push(shape(x,y,boxWidth,height,palette.surface,palette.ink));
    nodes.push(shape(x,y,boxWidth,band,headerFill,palette.ink));
    nodes.push(textNode(x+pad,y+8,boxWidth-pad*2,32,title,23,readableText(headerFill),'bold'));
  };
  nodes.push(shape(0,0,width,0,palette.paper,palette.paper,'none'));
  nodes.push(textNode(margin,26,860,56,`项目进展 · ${view.title}`,40,paperText,'bold'));
  nodes.push(textNode(900,36,232,26,palette.name,17,paperText,'regular','right'));
  let y=104;

  const positioning=`${wrapped(view.positioning,contentWidth-pad*2,bodyFont,4)}\n${wrapped(`当前状态：${view.status}`,contentWidth-pad*2,bodyFont,2)}`;
  const positioningHeight=band+pad+lineCount(positioning)*bodyLine+pad;
  box(margin,y,contentWidth,positioningHeight,'项目定位',palette.accent);
  nodes.push(textNode(margin+pad,y+band+pad,contentWidth-pad*2,lineCount(positioning)*bodyLine,positioning,bodyFont,readableText(palette.surface),'regular'));
  y+=positioningHeight+gap;

  const phaseTitle=view.phases.length?wrapped(founderPhasesTitle(view.phases),contentWidth-pad*2,23,1):'阶段规划';
  if(view.phases.length){
    // Up to four per row, so seven parallel phases stay two rows; the one current focus is the only filled chip.
    const perRow=Math.min(4,view.phases.length),chipGap=12,chipWidth=(contentWidth-pad*2-chipGap*(perRow-1))/perRow,legendHeight=30;
    // Narrow chips mix Latin phase numbers with CJK, so they wrap with the wider safety margin.
    const chipWrap=(value:string,font:number,maxLines:number)=>wrapText(value,textUnits(chipWidth-24,font),maxLines);
    const chips=view.phases.map(phase=>{
      const label=chipWrap(`${founderPhaseMark(phase)} ${phase.name}`,19,2);
      const tasks=chipWrap(phase.tasks,17,3);
      const status=chipWrap(phase.statusText,16,2);
      return{phase,label,tasks,status,height:12+lineCount(label)*27+6+lineCount(tasks)*24+6+lineCount(status)*23+12};
    });
    const rows:typeof chips[]=[];for(let index=0;index<chips.length;index+=perRow)rows.push(chips.slice(index,index+perRow));
    const rowHeights=rows.map(row=>Math.max(...row.map(chip=>chip.height)));
    const phasesHeight=band+pad+legendHeight+rowHeights.reduce((sum,height)=>sum+height,0)+chipGap*(rows.length-1)+pad;
    box(margin,y,contentWidth,phasesHeight,phaseTitle,palette.accent);
    nodes.push(textNode(margin+pad,y+band+pad-6,contentWidth-pad*2,23,founderPhaseLegend,16,readableText(palette.surface),'regular'));
    let chipY=y+band+pad+legendHeight;
    rows.forEach((row,rowIndex)=>{row.forEach((chip,column)=>{
      const x=margin+pad+column*(chipWidth+chipGap);
      const fill=chip.phase.focus?palette.secondary:chip.phase.status==='done'?palette.recess:chip.phase.status==='in_progress'?palette.paper:palette.surface;
      const ink=readableText(fill);let textY=chipY+12;
      nodes.push(shape(x,chipY,chipWidth,rowHeights[rowIndex]!,fill,palette.ink));
      nodes.push(textNode(x+12,textY,chipWidth-24,lineCount(chip.label)*27,chip.label,19,ink,'bold'));textY+=lineCount(chip.label)*27+6;
      nodes.push(textNode(x+12,textY,chipWidth-24,lineCount(chip.tasks)*24,chip.tasks,17,ink,'regular'));textY+=lineCount(chip.tasks)*24+6;
      nodes.push(textNode(x+12,textY,chipWidth-24,lineCount(chip.status)*23,chip.status,16,ink,'bold'));
    });chipY+=rowHeights[rowIndex]!+chipGap;});
    y+=phasesHeight+gap;
  }else{
    const empty=wrapped(view.phasesEmpty,contentWidth-pad*2,bodyFont,2),height=band+pad+lineCount(empty)*bodyLine+pad;
    box(margin,y,contentWidth,height,phaseTitle,palette.accent);
    nodes.push(textNode(margin+pad,y+band+pad,contentWidth-pad*2,lineCount(empty)*bodyLine,empty,bodyFont,readableText(palette.surface),'regular'));
    y+=height+gap;
  }

  for(let index=0;index<view.sections.length;index+=2){
    const pair=view.sections.slice(index,index+2).map(section=>({section,body:items(section.items,halfWidth-pad*2)}));
    const height=band+pad+Math.max(...pair.map(entry=>lineCount(entry.body)))*bodyLine+pad;
    pair.forEach((entry,column)=>{const x=margin+column*(halfWidth+gap);
      // A blocker or a divergence is what needs a decision, so it is the one header that changes color.
      const alert=(entry.section.title==='卡点与问题'||entry.section.title==='分歧')&&entry.section.items.length>0;
      box(x,y,halfWidth,height,entry.section.title,alert?palette.highlight:palette.accent);
      nodes.push(textNode(x+pad,y+band+pad,halfWidth-pad*2,lineCount(entry.body)*bodyLine,entry.body,bodyFont,readableText(palette.surface),'regular'));
    });
    y+=height+gap;
  }

  const footer=view.footer.split('\n').map(line=>wrapped(line,contentWidth-36,16,2)).join('\n'),footerHeight=lineCount(footer)*22+28;
  nodes.push(shape(margin,y,contentWidth,footerHeight,palette.recess,palette.ink));
  nodes.push(textNode(margin+18,y+14,contentWidth-36,lineCount(footer)*22,footer,16,readableText(palette.recess),'regular'));
  const height=y+footerHeight+margin;
  nodes[0]={...nodes[0]!,height};
  return{palette,width,height,nodes};
}

interface Placement {topic:FounderWorkMapBoardTopic;x:number;y:number;width:number;height:number;depth:number}
interface CompactRow {text:string;x:number;y:number;width:number;height:number}
interface LaneLayout {x:number;y:number;width:number;height:number;placements:Placement[];label:string;color:string;footer?:string;
  /** Ideas in this line, merged into one row instead of one card each. */
  ideaRow?:CompactRow;
  /** Closed items as one dated row each. */
  rows?:CompactRow[];
  /** One-line prompt under the header (used by the dormant section). */
  note?:string;
  /** Colored marker on each row, so the dormant reminder stands out from muted history. */
  rowAccent?:string}

function buildWorkMapBoard(title:string,palette:FounderPalette,view:FounderWorkMapBoardView):BuiltFounderWhiteboard{
  const width=1160,margin=28,top=142,gap=24,contentWidth=width-margin*2,halfWidth=(contentWidth-gap)/2;
  const lineNames={A:'AiJia AI Native 房产业务',B:'自媒体生产线',C:'公司协作基础设施'} as const;
  const byName=new Map(view.topics.map(topic=>[topic.name,topic]));
  const root=(topic:FounderWorkMapBoardTopic):string=>{let current=topic,guard=0;while(current.parentName&&guard++<20){const parent=byName.get(current.parentName);if(!parent)break;current=parent}return current.name};
  const visible=view.topics.filter(topic=>!topic.dormant&&!Object.values(lineNames).includes(topic.name as typeof lineNames[keyof typeof lineNames]));
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
  const mainBottom=Math.max(laneB.y+laneB.height,laneC.y+laneC.height);
  // A reminder, not history: it sits between current work and closed items so stalled work gets a decision.
  const dormant=view.topics.filter(topic=>topic.dormant);
  const dormantLane=dormant.length?layoutDormantLane(dormant,margin,mainBottom+gap,contentWidth,view.until,palette.highlight):null;
  const lowerSectionsY=(dormantLane?dormantLane.y+dormantLane.height:mainBottom)+gap;
  const otherLane=currentOther.length?layoutLane(currentOther,margin,lowerSectionsY,history.length?halfWidth:contentWidth,
    history.length?1:2,'待核对 / 其他项目',palette.highlight,byName,null):null;
  const historyLane=history.length?layoutHistoryLane(history,otherLane?margin+halfWidth+gap:margin,lowerSectionsY,
    otherLane?halfWidth:contentWidth,'已结束 / 历史',palette.accent):null;
  const gapHeight=view.coverageGaps.length?88+view.coverageGaps.length*34:0;
  const contentBottom=Math.max(mainBottom,...[dormantLane,otherLane,historyLane].flatMap(lane=>lane?[lane.y+lane.height]:[]));
  const height=Math.max(900,contentBottom+gapHeight+80);
  const nodes:FounderWhiteboardNode[]=[shape(0,0,width,height,palette.paper,palette.paper,'none')];
  const paperText=readableText(palette.paper);
  nodes.push(textNode(margin,26,720,56,title==='工作地图'?'共同工作地图':title,42,paperText,'bold'));
  nodes.push(textNode(margin,84,760,36,'房产业务、内容生产、协作基础设施，放回各自的主线。',21,paperText,'regular'));
  nodes.push(textNode(820,34,312,30,`${palette.name} · ${dateLabel(view.until)}`,17,paperText,'regular','right'));
  for(const lane of [laneA,laneB,laneC,...(dormantLane?[dormantLane]:[]),...(otherLane?[otherLane]:[]),...(historyLane?[historyLane]:[])])appendLane(nodes,lane,palette,byName);
  if(view.coverageGaps.length){const y=contentBottom+gap,gapText=readableText(palette.recess);nodes.push(shape(margin,y,width-margin*2,gapHeight-24,palette.recess,palette.ink));
    nodes.push(textNode(margin+22,y+18,280,36,'覆盖缺口 / 待核对',23,gapText,'bold'));
    nodes.push(textNode(margin+292,y+18,width-margin*2-318,gapHeight-42,
      view.coverageGaps.map(item=>`• ${wrapText(item.summary,54,2)}`).join('\n'),19,gapText,'regular'));
  }
  return{palette,width,height,nodes};
}

function layoutLane(topics:readonly FounderWorkMapBoardTopic[],x:number,y:number,width:number,columns:number,label:string,color:string,
  byName:ReadonlyMap<string,FounderWorkMapBoardTopic>,lineRoot:string|null,footer?:string):LaneLayout{
  const padding=20,header=58,columnGap=20,columnWidth=(width-padding*2-columnGap*(columns-1))/columns;
  const ideas=topics.filter(topic=>topic.kind==='idea');
  topics=topics.filter(topic=>topic.kind!=='idea');
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
      const bodyLines=body?body.split('\n').length:0,cardHeight=32+titleLines*34+(bodyLines?10+bodyLines*29:0)+(topic.space?.weekLine?spaceLineHeight:0)+34;
      const placement={topic,x:x+padding+column*(columnWidth+columnGap)+indent,y:heights[column]!,width:cardWidth,height:cardHeight,depth};
      placements.push(placement);heights[column]=placement.y+cardHeight+cardGap;
    }
  }
  const cardsBottom=placements.length?Math.max(...heights):y+header+padding;
  const ideaText=`观点 ${ideas.length} 条：${ideas.map(topic=>topic.name).join(' · ')}`;
  // Idea names may need two lines in a half-width lane; truncating a name would hide which idea it is.
  const ideaLines=ideas.length?wrapText(ideaText,fullLineUnits(width-padding*2-32,19),2).split('\n').length:0;
  const ideaRow=ideas.length?{text:ideaText,x:x+padding,y:cardsBottom,width:width-padding*2,height:compactRowHeight+(ideaLines-1)*26}:undefined;
  const contentBottom=ideaRow?ideaRow.y+ideaRow.height+cardGap:Math.max(...heights);
  return{x,y,width,height:Math.max(y+150,contentBottom)-y+2+(footer?64:0),placements,label,color,...(footer?{footer}:{}),...(ideaRow?{ideaRow}:{})};
}

/** Stalest first: paused, or how long it has been quiet, and the last recorded state, i.e. what it is waiting on. */
function layoutDormantLane(topics:readonly FounderWorkMapBoardTopic[],x:number,y:number,width:number,until:string,color:string):LaneLayout{
  const padding=20,header=58,noteHeight=34,rowWidth=width-padding*2,dayMs=24*60*60*1_000;
  const activity=(topic:FounderWorkMapBoardTopic)=>topic.lastActivityAt?Date.parse(topic.lastActivityAt):0;
  let rowY=y+header+padding+noteHeight;
  const rows=[...topics].sort((a,b)=>activity(a)-activity(b)||a.name.localeCompare(b.name)).map(topic=>{
    const title=topic.kind==='goal'?`阶段目标 / ${topic.name}`:topic.kind==='task'?`任务 / ${topic.name}`:topic.kind==='idea'?`观点 / ${topic.name}`:topic.name;
    const quiet=topic.stage==='paused'?'暂停':topic.lastActivityAt?`${Math.floor((Date.parse(until)-activity(topic))/dayMs)} 天无动态`:'无动态记录';
    const text=[title,quiet,topic.outcome?.trim()||'未记录卡点'].join(' · ');
    const lines=wrapText(text,fullLineUnits(rowWidth-32,19),2).split('\n').length;
    const row={text,x:x+padding,y:rowY,width:rowWidth,height:compactRowHeight+(lines-1)*26};
    rowY+=row.height+compactRowGap;return row;
  });
  return{x,y,width,height:rowY-compactRowGap+padding-y+2,placements:[],label:`暂停 / 长期无动态 ${topics.length} 项`,color,rows,
    note:'暂停或超过 30 天没有新动态：还在推进、卡在等谁，还是不做了？请回复确认继续、暂停还是结束。',rowAccent:color};
}

/** Closed items stay visible, but as one dated line each so history never outweighs current work. */
function layoutHistoryLane(topics:readonly FounderWorkMapBoardTopic[],x:number,y:number,width:number,label:string,color:string):LaneLayout{
  const padding=20,header=58,ordered=[...topics].sort((a,b)=>(b.closedAt?Date.parse(b.closedAt):0)-(a.closedAt?Date.parse(a.closedAt):0)||a.name.localeCompare(b.name));
  const rows=ordered.map((topic,index)=>{
    const title=topic.kind==='goal'?`阶段目标 / ${topic.name}`:topic.kind==='task'?`任务 / ${topic.name}`:topic.kind==='idea'?`观点 / ${topic.name}`:topic.name;
    const text=[title,topic.closedAt?`${founderMonthDay(topic.closedAt)} 结束`:null,topic.outcome?.trim()||null].filter(Boolean).join(' · ');
    return{text,x:x+padding,y:y+header+padding+index*(compactRowHeight+compactRowGap),width:width-padding*2,height:compactRowHeight};
  });
  const height=header+padding*2+rows.length*(compactRowHeight+compactRowGap)-compactRowGap+2;
  return{x,y,width,height:Math.max(150,height),placements:[],label,color,rows};
}

const cardGap=18,spaceLineHeight=33,compactRowHeight=40,compactRowGap=8;
function founderMonthDay(value:string):string{return new Date(Date.parse(value)+8*60*60*1_000).toISOString().slice(5,10)}
/** Rendered width of a short single-line label in font-size units (CJK ≈ 1, Latin/digits ≈ 0.6). */
function labelUnits(value:string):number{return Array.from(value).reduce((sum,char)=>sum+(/[\p{Script=Han}]/u.test(char)?1:/\s/u.test(char)?0.34:0.6),0)}
function appendLane(nodes:FounderWhiteboardNode[],lane:LaneLayout,palette:FounderPalette,byName:ReadonlyMap<string,FounderWorkMapBoardTopic>):void{
  nodes.push(shape(lane.x,lane.y,lane.width,lane.height,palette.recess,palette.ink));
  nodes.push(shape(lane.x,lane.y,lane.width,58,lane.color,palette.ink));
  nodes.push(textNode(lane.x+18,lane.y+14,lane.width-36,36,lane.label,27,readableText(lane.color),'bold'));
  const positionByName=new Map<string,Placement>();
  for(const placement of lane.placements)positionByName.set(placement.topic.name,placement);
  for(const placement of lane.placements){const parent=placement.topic.parentName?positionByName.get(placement.topic.parentName):undefined;
    if(parent)nodes.push(connector(parent.x+parent.width/2,parent.y+parent.height,placement.x+placement.width/2,placement.y,palette.ink));
    else if(placement.topic.parentName&&byName.has(placement.topic.parentName)&&placement.depth>1)nodes.push(connector(placement.x-12,placement.y+16,placement.x,placement.y+16,palette.ink));
  }
  for(const placement of lane.placements){const {topic,x,y,width,height}=placement,fill=topic.kind==='project'?palette.surface:topic.kind==='goal'?palette.secondary:palette.highlight;
    const cardText=readableText(fill);
    nodes.push(shape(x+6,y+6,width,height,palette.ink,palette.ink,'none'));
    nodes.push(shape(x,y,width,height,fill,palette.ink));
    const title=topic.kind==='goal'?`阶段目标 / ${topic.name}`:topic.kind==='task'?`任务 / ${topic.name}`:
      topic.kind==='idea'?`观点 / ${topic.name}`:topic.name;
    const wrappedTitle=wrapText(title,textUnits(width-36,26),2),titleLines=wrappedTitle.split('\n').length;
    nodes.push(textNode(x+18,y+16,width-36,titleLines*34,wrappedTitle,26,cardText,'bold'));
    const outcome=topic.outcome?wrapText(topic.outcome,textUnits(width-36,21),2):'',outcomeLines=outcome?outcome.split('\n').length:0;
    if(topic.outcome)nodes.push(textNode(x+18,y+22+titleLines*34,width-36,topic.space?outcomeLines*29+4:height-86,outcome,21,cardText,'regular'));
    if(topic.space?.weekLine)nodes.push(textNode(x+18,y+22+titleLines*34+(outcomeLines?outcomeLines*29+6:0),width-36,27,
      wrapText(topic.space.weekLine,fullLineUnits(width-36,19),1),19,cardText,'regular'));
    const meta=[stageLabel(topic.stage),topic.sourceCount?`${topic.sourceCount} 个来源`:null].filter(Boolean).join(' · ');
    nodes.push(textNode(x+18,y+height-30,width-36,22,meta,17,cardText,'regular'));
    if(topic.space){const chipWidth=Math.ceil(labelUnits(topic.space.label)*14)+20,chipX=x+width-14-chipWidth,chipY=y+height-34;
      nodes.push(shape(chipX,chipY,chipWidth,24,palette.accent,palette.ink));
      nodes.push(textNode(chipX+10,chipY+4,chipWidth-20,18,topic.space.label,14,readableText(palette.accent),'regular'));}
  }
  if(lane.note)nodes.push(textNode(lane.x+20,lane.y+58+14,lane.width-40,26,wrapText(lane.note,fullLineUnits(lane.width-40,19),1),19,readableText(palette.recess),'bold'));
  for(const row of [...(lane.rows??[]),...(lane.ideaRow?[lane.ideaRow]:[])]){
    const lines=Math.max(1,Math.round((row.height-compactRowHeight)/26)+1);
    nodes.push(shape(row.x,row.y,row.width,row.height,palette.surface,palette.ink));
    if(lane.rowAccent&&lane.rows?.includes(row))nodes.push(shape(row.x,row.y,10,row.height,lane.rowAccent,palette.ink));
    nodes.push(textNode(row.x+(lane.rowAccent&&lane.rows?.includes(row)?24:16),row.y+9,row.width-32,row.height-16,wrapText(row.text,fullLineUnits(row.width-32,19),lines),19,readableText(palette.surface),'regular'));
  }
  if(lane.footer){const y=lane.y+lane.height-54;
    nodes.push(shape(lane.x+20,y,lane.width-40,38,palette.secondary,palette.ink));
    nodes.push(textNode(lane.x+36,y+8,lane.width-72,28,lane.footer,19,readableText(palette.secondary),'bold'));
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
/** Single-line text that should use almost the whole width: CJK glyphs are one em wide, with a small safety margin. */
function fullLineUnits(width:number,fontSize:number):number{return Math.max(8,Math.floor(width/(fontSize*1.02)))}
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
function readableText(background:string):string{
  return contrastRatio('#000000',background)>=contrastRatio('#FFFFFF',background)?'#000000':'#FFFFFF';
}
function contrastRatio(left:string,right:string):number{const values=[relativeLuminance(left),relativeLuminance(right)].sort((a,b)=>b-a);
  return(values[0]!+0.05)/(values[1]!+0.05)}
function relativeLuminance(hex:string):number{const channels=hex.replace('#','').match(/.{2}/g)?.map(value=>parseInt(value,16)/255)
  .map(value=>value<=0.04045?value/12.92:Math.pow((value+0.055)/1.055,2.4))??[0,0,0];
  return channels[0]!*0.2126+channels[1]!*0.7152+channels[2]!*0.0722}
function darkest(colors:string[]):string{return[...colors].sort((a,b)=>luminance(a)-luminance(b))[0]??'#1A1A1A'}
function luminance(hex:string):number{const rgb=hex.replace('#','').match(/.{2}/g)?.map(v=>parseInt(v,16))??[0,0,0];return rgb[0]!*0.2126+rgb[1]!*0.7152+rgb[2]!*0.0722}
function mix(a:string,b:string,weight:number):string{const channel=(value:string)=>value.replace('#','').match(/.{2}/g)?.map(v=>parseInt(v,16))??[0,0,0],aa=channel(a),bb=channel(b);
  return`#${aa.map((value,index)=>Math.round(value*(1-weight)+bb[index]!*weight).toString(16).padStart(2,'0')).join('').toUpperCase()}`;}

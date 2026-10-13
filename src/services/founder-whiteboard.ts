export interface FounderWhiteboardNode {
  id?:string;
  type:'text_shape'|'composite_shape'|'connector'|'group';
  x?:number;y?:number;width?:number;height?:number;
  text?:{text?:string;font_weight?:'regular'|'bold';font_size?:number;text_color?:string;horizontal_align?:'left'|'center'|'right';vertical_align?:'top'|'mid'|'bottom'};
  style?:{fill_color?:string;border_color?:string;border_style?:'solid'|'none';border_width?:'extra_narrow'|'narrow'|'medium'|'bold'};
  composite_shape?:{type:'rect'};
}

export interface FounderPalette {id:string;name:string;paper:string;accent:string;ink:string;surface:string}
export interface FounderWhiteboardArtifact {documentId:string;whiteboardId:string;url:string;paletteId:string}
export interface FounderWhiteboardGateway {
  createDocument(input:{title:string}):Promise<{documentId:string}>;
  createBoard(input:{documentId:string;width:number;height:number}):Promise<{whiteboardId:string}>;
  createNodes(input:{whiteboardId:string;nodes:readonly FounderWhiteboardNode[]}):Promise<void>;
  grantGroupEdit(input:{documentId:string;chatId:string}):Promise<void>;
}

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

export const founderPalettes:FounderPalette[]=paletteRows.map(([id,name,colors])=>({id,name,paper:colors[0]!,accent:colors[1]!,
  ink:darkest(colors.slice(1)),surface:colors.length>3?colors[2]!:colors[0]!}));

export function selectFounderPalette(previousId:string|null|undefined,random:()=>number=Math.random):FounderPalette{
  const available=founderPalettes.filter(item=>item.id!==previousId);
  return available[Math.min(available.length-1,Math.max(0,Math.floor(random()*available.length)))]!;
}

export function buildFounderWhiteboard(input:{title:string;paletteId:string;cards:readonly Record<string,unknown>[]}):
  {palette:FounderPalette;width:number;height:number;nodes:FounderWhiteboardNode[]} {
  const palette=founderPalettes.find(item=>item.id===input.paletteId)??founderPalettes[0]!;
  const lines=input.cards.flatMap(card=>cardLines(card));
  const width=1680,columnWidth=760,gap=60,startY=180;
  const blocks=lines.map((value,index)=>({value,index,height:Math.max(96,64+Math.ceil(Array.from(value).length/38)*34)}));
  const columns:[typeof blocks,typeof blocks]=[[],[]];let heights=[startY,startY];
  for(const block of blocks){const column=heights[0]<=heights[1]?0:1;columns[column]!.push(block);heights[column]+=block.height+28;}
  const height=Math.max(720,...heights)+80,nodes:FounderWhiteboardNode[]=[];
  nodes.push(shape(0,0,width,height,palette.paper,palette.paper));
  nodes.push(textNode(48,44,1200,72,input.title,48,palette.ink,'bold'));
  nodes.push(textNode(1320,52,300,52,palette.name,22,palette.ink,'regular','right'));
  columns.forEach((column,columnIndex)=>{let y=startY;for(const block of column){const x=40+columnIndex*(columnWidth+80);
    nodes.push(shape(x,y,columnWidth,block.height,palette.surface,palette.accent));
    nodes.push(textNode(x+26,y+22,columnWidth-52,block.height-40,block.value,24,palette.ink,block.index===0?'bold':'regular'));
    y+=block.height+28;
  }});
  return{palette,width,height,nodes};
}

export async function publishFounderWhiteboard(input:{title:string;paletteId:string;chatId:string;
  cards:readonly Record<string,unknown>[]},gateway:FounderWhiteboardGateway):Promise<FounderWhiteboardArtifact>{
  const board=buildFounderWhiteboard(input);
  const document=await gateway.createDocument({title:input.title});
  if(!document.documentId.trim())throw new Error('whiteboard document id is required');
  const created=await gateway.createBoard({documentId:document.documentId,width:board.width,height:board.height});
  if(!created.whiteboardId.trim())throw new Error('whiteboard id is required');
  await gateway.createNodes({whiteboardId:created.whiteboardId,nodes:board.nodes});
  await gateway.grantGroupEdit({documentId:document.documentId,chatId:input.chatId});
  return{documentId:document.documentId,whiteboardId:created.whiteboardId,
    url:`https://icnua99ny9c4.feishu.cn/docx/${document.documentId}`,paletteId:board.palette.id};
}

function cardLines(card:Record<string,unknown>):string[]{
  const header=(card.header as {title?:{content?:unknown}}|undefined)?.title?.content;
  const elements=Array.isArray(card.elements)?card.elements:[];
  return [typeof header==='string'?header:'',...elements.flatMap(element=>{
    const content=(element as {text?:{content?:unknown}})?.text?.content;return typeof content==='string'&&content.trim()?[content.trim()]:[];
  })].filter(Boolean);
}

function shape(x:number,y:number,width:number,height:number,fill:string,border:string):FounderWhiteboardNode{return{
  type:'composite_shape',x,y,width,height,composite_shape:{type:'rect'},style:{fill_color:fill,border_color:border,border_style:'solid',border_width:'narrow'}};}
function textNode(x:number,y:number,width:number,height:number,value:string,fontSize:number,color:string,fontWeight:'regular'|'bold',
  align:'left'|'center'|'right'='left'):FounderWhiteboardNode{return{type:'text_shape',x,y,width,height,
  text:{text:value,font_size:fontSize,font_weight:fontWeight,text_color:color,horizontal_align:align,vertical_align:'top'},
  style:{fill_color:'#FFFFFF00',border_style:'none'}};}
function darkest(colors:string[]):string{return [...colors].sort((a,b)=>luminance(a)-luminance(b))[0]??'#1A1A1A'}
function luminance(hex:string):number{const rgb=hex.replace('#','').match(/.{2}/g)?.map(v=>parseInt(v,16))??[0,0,0];
  return rgb[0]!*0.2126+rgb[1]!*0.7152+rgb[2]!*0.0722;}

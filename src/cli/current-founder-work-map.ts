import { createHash } from 'node:crypto';
import { statSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import Database from 'better-sqlite3';
import { buildCurrentFounderWorkMap, enqueueCurrentFounderWorkMap, type CurrentFounderWorkMapResult } from '../services/current-founder-work-map.js';
import { manualQueryTitle } from '../services/founder-stream-worker.js';
import { buildFounderWhiteboard, renderFounderWhiteboardPng } from '../services/founder-whiteboard.js';
import { summarizeFounderWorkMapActivity } from '../services/founder-work-map-activity-summary.js';
import { TopicRepository } from '../repositories/topic-repository.js';
import { loadSpaceProjectPageView, renderSpaceProjectPageLines } from '../services/space-project-page-view.js';

const approvedFounderChatId='oc_a84d5b6ca478220d0a37964b50776edb';
const previewPaletteId='grove';
const feishuImageLimitBytes=10*1024*1024;
const spaceStaleAfterMinutes=24*60;

export interface CurrentFounderWorkMapArguments{
  database:string;chatId:string;since:string;until:string;expectedCanonicalTopicCount:number;
  mode:'preview'|'enqueue';confirmedChatId:string|null;boardPngPath:string|null;withSpace:boolean;
}

export function parseCurrentFounderWorkMapArguments(args:readonly string[]):CurrentFounderWorkMapArguments{
  const{values}=parseArgs({args:args[0]==='--'?args.slice(1):[...args],strict:true,options:{database:{type:'string'},'chat-id':{type:'string'},
    since:{type:'string'},until:{type:'string'},'expected-canonical-topics':{type:'string'},preview:{type:'boolean'},enqueue:{type:'boolean'},
    'confirm-target-chat-id':{type:'string'},'board-png':{type:'string'},'with-space':{type:'boolean'}}});
  const database=values.database?.trim(),chatId=values['chat-id']?.trim(),since=values.since?.trim(),until=values.until?.trim();
  const expectedCanonicalTopicCount=Number(values['expected-canonical-topics']);
  const confirmedChatId=values['confirm-target-chat-id']?.trim()??null;
  const boardPngPath=values['board-png']===undefined?null:values['board-png'].trim();
  const preview=Boolean(values.preview),enqueue=Boolean(values.enqueue),withSpace=Boolean(values['with-space']);
  if(!database||chatId!==approvedFounderChatId||!since||!until||preview===enqueue||!Number.isSafeInteger(expectedCanonicalTopicCount)||
    expectedCanonicalTopicCount<1||!Number.isFinite(Date.parse(since))||!Number.isFinite(Date.parse(until))||Date.parse(since)>=Date.parse(until)||
    (enqueue&&confirmedChatId!==chatId)||(preview&&confirmedChatId!==null)||boardPngPath===''||(enqueue&&(boardPngPath!==null||withSpace)))
    throw new Error('FOUNDER_WORK_MAP_ARGUMENTS_INVALID');
  return{database,chatId,since,until,expectedCanonicalTopicCount,mode:enqueue?'enqueue':'preview',confirmedChatId,boardPngPath,withSpace};
}

/**
 * Read-only preview. With withSpace, registered Space page summaries join the map exactly as they would once
 * SPACE_SYNC_WORKMAP_ENABLED is on, so "Feishu only" and "Feishu + Space" can be compared before the flag flips.
 */
export function buildCurrentFounderWorkMapPreview(client:Database.Database,args:{chatId:string;since:string;until:string;
  expectedCanonicalTopicCount:number;withSpace:boolean}):{result:CurrentFounderWorkMapResult;spaceProjectPages:{topicName:string;lines:string[]}[]}{
  const now=new Date(args.until),pages=args.withSpace?new TopicRepository(client).listCanonicalTopics().flatMap(topic=>{
    const view=loadSpaceProjectPageView(client,topic.id,now,spaceStaleAfterMinutes);
    return view?[{topic,view}]:[];
  }):[];
  const result=buildCurrentFounderWorkMap({client,chatId:args.chatId,since:args.since,until:args.until,approvedChatIds:[approvedFounderChatId],
    expectedCanonicalTopicCount:args.expectedCanonicalTopicCount,spacePageByTopicId:new Map(pages.map(page=>[page.topic.id,page.view]))});
  return{result,spaceProjectPages:pages.map(page=>({topicName:page.topic.displayName,lines:renderSpaceProjectPageLines(page.view)}))};
}

/** The same board code the worker publishes, fixed to Grove so a pre-cutover preview is comparable run to run. */
export async function renderCurrentFounderWorkMapPreviewPng(result:CurrentFounderWorkMapResult):Promise<{title:string;paletteId:string;png:Buffer}>{
  const cards=result.cards.map(card=>card.card),title=manualQueryTitle(cards[0]);
  const png=await renderFounderWhiteboardPng(buildFounderWhiteboard({title,paletteId:previewPaletteId,cards,view:result.boardView}));
  if(png.byteLength>=feishuImageLimitBytes)throw new Error('FOUNDER_WORK_MAP_PREVIEW_IMAGE_TOO_LARGE');
  return{title,paletteId:previewPaletteId,png};
}

async function main():Promise<void>{
  const args=parseCurrentFounderWorkMapArguments(process.argv.slice(2));
  if(!statSync(args.database).isFile())throw new Error('FOUNDER_WORK_MAP_DATABASE_INVALID');
  const client=new Database(args.database,{readonly:args.mode==='preview',fileMustExist:true});
  try{
    if(args.mode==='preview')client.pragma('query_only = ON');
    const base={client,chatId:args.chatId,since:args.since,until:args.until,approvedChatIds:[approvedFounderChatId],expectedCanonicalTopicCount:args.expectedCanonicalTopicCount};
    if(args.mode==='enqueue'){
      const result=enqueueCurrentFounderWorkMap({...base,confirmedChatId:args.confirmedChatId!,
        groupDeliveryEnabled:process.env.FOUNDER_STREAM_GROUP_DELIVERY_ENABLED==='true'});
      process.stdout.write(`${JSON.stringify({mode:args.mode,...result},null,2)}\n`);return;
    }
    const{result,spaceProjectPages}=buildCurrentFounderWorkMapPreview(client,{...args});
    let boardPng:{path:string;paletteId:string;bytes:number;sha256:string}|undefined;
    if(args.boardPngPath){
      const preview=await renderCurrentFounderWorkMapPreviewPng(result);
      // Never overwrite an existing file; the image holds topic names, so keep it owner-only.
      writeFileSync(args.boardPngPath,preview.png,{flag:'wx',mode:0o600});
      boardPng={path:args.boardPngPath,paletteId:preview.paletteId,bytes:preview.png.byteLength,
        sha256:createHash('sha256').update(preview.png).digest('hex')};
    }
    process.stdout.write(`${JSON.stringify({mode:args.mode,...result,activitySummary:summarizeFounderWorkMapActivity(result.boardView),
      ...(boardPng?{boardPng}:{}),...(args.withSpace?{withSpace:true,spaceProjectPages}:{})},null,2)}\n`);
  }finally{client.close()}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)void main().catch(()=>{
  process.stderr.write('Current founder work map failed. No source content logged.\n');process.exitCode=1;
});

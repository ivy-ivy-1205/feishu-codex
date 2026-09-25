import { statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import Database from 'better-sqlite3';
import { buildCurrentFounderWorkMap, enqueueCurrentFounderWorkMap } from '../services/current-founder-work-map.js';

const approvedFounderChatId='oc_a84d5b6ca478220d0a37964b50776edb';

export interface CurrentFounderWorkMapArguments{
  database:string;chatId:string;since:string;until:string;expectedCanonicalTopicCount:number;
  mode:'preview'|'enqueue';confirmedChatId:string|null;
}

export function parseCurrentFounderWorkMapArguments(args:readonly string[]):CurrentFounderWorkMapArguments{
  const{values}=parseArgs({args:args[0]==='--'?args.slice(1):[...args],strict:true,options:{database:{type:'string'},'chat-id':{type:'string'},
    since:{type:'string'},until:{type:'string'},'expected-canonical-topics':{type:'string'},preview:{type:'boolean'},enqueue:{type:'boolean'},
    'confirm-target-chat-id':{type:'string'}}});
  const database=values.database?.trim(),chatId=values['chat-id']?.trim(),since=values.since?.trim(),until=values.until?.trim();
  const expectedCanonicalTopicCount=Number(values['expected-canonical-topics']);
  const confirmedChatId=values['confirm-target-chat-id']?.trim()??null;
  const preview=Boolean(values.preview),enqueue=Boolean(values.enqueue);
  if(!database||chatId!==approvedFounderChatId||!since||!until||preview===enqueue||!Number.isSafeInteger(expectedCanonicalTopicCount)||
    expectedCanonicalTopicCount<1||!Number.isFinite(Date.parse(since))||!Number.isFinite(Date.parse(until))||Date.parse(since)>=Date.parse(until)||
    (enqueue&&confirmedChatId!==chatId)||(preview&&confirmedChatId!==null))throw new Error('FOUNDER_WORK_MAP_ARGUMENTS_INVALID');
  return{database,chatId,since,until,expectedCanonicalTopicCount,mode:enqueue?'enqueue':'preview',confirmedChatId};
}

function main():void{
  const args=parseCurrentFounderWorkMapArguments(process.argv.slice(2));
  if(!statSync(args.database).isFile())throw new Error('FOUNDER_WORK_MAP_DATABASE_INVALID');
  const client=new Database(args.database,{readonly:args.mode==='preview',fileMustExist:true});
  try{
    if(args.mode==='preview')client.pragma('query_only = ON');
    const base={client,chatId:args.chatId,since:args.since,until:args.until,approvedChatIds:[approvedFounderChatId],expectedCanonicalTopicCount:args.expectedCanonicalTopicCount};
    const result=args.mode==='preview'?buildCurrentFounderWorkMap(base):enqueueCurrentFounderWorkMap({...base,
      confirmedChatId:args.confirmedChatId!,groupDeliveryEnabled:process.env.FOUNDER_STREAM_GROUP_DELIVERY_ENABLED==='true'});
    process.stdout.write(`${JSON.stringify({mode:args.mode,...result},null,2)}\n`);
  }finally{client.close()}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)try{main()}catch{
  process.stderr.write('Current founder work map failed. No source content logged.\n');process.exitCode=1;
}

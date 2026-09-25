import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import { buildFounderManualQueryMessages, parseFounderManualQuery } from '../services/founder-manual-query.js';

const approvedChatId='oc_a84d5b6ca478220d0a37964b50776edb';
export interface CurrentFounderAlignmentArguments {database:string;chatId:string;query:string;now:string}

export function parseCurrentFounderAlignmentArguments(argv:readonly string[]):CurrentFounderAlignmentArguments{
  const value=(name:string)=>{const index=argv.indexOf(name);return index>=0?argv[index+1]?.trim():undefined};
  const database=value('--database'),chatId=value('--chat-id'),query=value('--query'),now=value('--now');
  if(!database)throw new Error('database is required');
  if(chatId!==approvedChatId)throw new Error('approved chat is required');
  if(!query||!parseFounderManualQuery(query))throw new Error('approved query is required');
  if(!now||!Number.isFinite(Date.parse(now)))throw new Error('valid now is required');
  return{database,chatId,query,now:new Date(now).toISOString()};
}

async function main(){
  const args=parseCurrentFounderAlignmentArguments(process.argv.slice(2));
  const client=new Database(args.database,{readonly:true,fileMustExist:true});
  try{
    client.pragma('query_only = ON');
    const parsed=parseFounderManualQuery(args.query)!;
    const messages=buildFounderManualQueryMessages({client,query:parsed,queryMessageId:'preview',chatId:args.chatId,
      approvedChatIds:[args.chatId],now:new Date(args.now)});
    process.stdout.write(`${JSON.stringify({mode:'preview',writes:0,query:parsed,messages},null,2)}\n`);
  }finally{client.close()}
}

if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1])main().catch(error=>{
  process.stderr.write(`${error instanceof Error?error.message:'preview failed'}\n`);process.exitCode=1;
});

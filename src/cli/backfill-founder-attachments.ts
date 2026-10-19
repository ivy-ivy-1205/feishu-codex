import {pathToFileURL} from 'node:url';
import {createFeishuSdkClient,FeishuSdkAttachmentReader,FeishuSdkContextClient} from '../adapters/feishu-sdk.js';
import {createSqliteDatabase} from '../db/client.js';
import {migrateDatabase} from '../db/migrate.js';
import {ContextSourceRepository} from '../repositories/context-source-repository.js';
import {JobRepository} from '../repositories/job-repository.js';
import {persistFounderAttachmentBackfill} from '../services/founder-attachment-backfill.js';
import {approvedFeishuProjectContextChatId,type FeishuContextMessage,type FeishuContextPage} from '../services/feishu-context-sync.js';

interface Arguments{database:string;chatId:string;since:string;until:string}
export function parseFounderAttachmentBackfillArguments(args:readonly string[]):Arguments{
  const values=new Map<string,string>();for(let index=0;index<args.length;index+=2){const key=args[index],value=args[index+1];
    if(!key?.startsWith('--')||!value||values.has(key))throw new Error('ATTACHMENT_BACKFILL_ARGUMENTS_INVALID');values.set(key,value)}
  const parsed={database:values.get('--database')?.trim(),chatId:values.get('--chat-id')?.trim(),since:values.get('--since')?.trim(),until:values.get('--until')?.trim()};
  if(values.size!==4||!parsed.database||parsed.chatId!==approvedFeishuProjectContextChatId||!parsed.since||!parsed.until||
    !Number.isFinite(Date.parse(parsed.since))||!Number.isFinite(Date.parse(parsed.until))||Date.parse(parsed.since)>=Date.parse(parsed.until))
    throw new Error('ATTACHMENT_BACKFILL_ARGUMENTS_INVALID');return parsed as Arguments;
}

async function readAll(context:FeishuSdkContextClient,args:Arguments):Promise<FeishuContextMessage[]>{
  const result:FeishuContextMessage[]=[],threads=new Set<string>();
  async function pages(threadId:string|null){let cursor:string|null=null;do{const range={cursor,since:new Date(args.since),until:new Date(args.until)};
    const page:FeishuContextPage=threadId?await context.listThreadMessages({threadId,...range}):await context.listMessages({chatId:args.chatId,...range});
    result.push(...page.messages);for(const message of page.messages)if(message.threadId)threads.add(message.threadId);cursor=page.nextCursor}while(cursor)}
  await pages(null);for(const thread of threads)await pages(thread);
  return[...new Map(result.map(message=>[message.messageId,message])).values()].sort((a,b)=>a.createdAt.localeCompare(b.createdAt));
}

async function main(){
  const args=parseFounderAttachmentBackfillArguments(process.argv.slice(2)),appId=process.env.FEISHU_APP_ID?.trim(),appSecret=process.env.FEISHU_APP_SECRET?.trim();
  if(!appId||!appSecret)throw new Error('ATTACHMENT_BACKFILL_CONFIG_INVALID');
  const sdk=createFeishuSdkClient({appId,appSecret}),context=new FeishuSdkContextClient(sdk),reader=new FeishuSdkAttachmentReader(sdk),messages=await readAll(context,args);
  const files=(await context.listReferencedFiles({chatId:args.chatId,messageIds:messages.map(message=>message.messageId)}))
    .filter(file=>file.messageId&&!file.mimeType.startsWith('application/vnd.feishu.')&&!file.mimeType.startsWith('audio/')&&!file.mimeType.startsWith('video/'));
  const database=createSqliteDatabase(args.database);try{migrateDatabase(database.client);
    const result=await persistFounderAttachmentBackfill({chatId:args.chatId,now:new Date(),messages,files,
      read:async file=>(await reader.read({messageId:file.messageId!,fileKey:file.fileToken,fileName:file.title})).body,
      sourceRepository:new ContextSourceRepository(database.client),jobRepository:new JobRepository(database.client)});
    process.stdout.write(JSON.stringify({...result,messagesSeen:messages.length})+'\n');
  }finally{database.close()}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)void main().catch(()=>{process.stderr.write('Founder attachment backfill failed. No source content logged.\n');process.exitCode=1});

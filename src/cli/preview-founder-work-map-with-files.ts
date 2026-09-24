import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { CodexCliAdapter, NodeCodexProcessRunner } from '../adapters/codex-cli.js';
import { createFeishuSdkClient, FeishuSdkContextClient, type FeishuSdkClientLike } from '../adapters/feishu-sdk.js';
import { createFounderAnalysisAdapters } from '../composition/founder-stream-analysis.js';
import { createSqliteDatabase } from '../db/client.js';
import { migrateDatabase } from '../db/migrate.js';
import { ContextSourceRepository } from '../repositories/context-source-repository.js';
import { parseFeishuAttachment } from '../services/feishu-attachment-parser.js';
import { assembleFeishuFileContext, type FileContextMessage } from '../services/feishu-file-context.js';
import { approvedFeishuProjectContextChatId, type FeishuContextFile, type FeishuContextMessage, type FeishuContextPage } from '../services/feishu-context-sync.js';
import { buildFounderWorkMapPreview } from '../services/founder-work-map-preview.js';
import { captureGroupMessageSource } from '../services/group-message-source-capture.js';

interface Arguments {chatId:string;since:string;until:string;ivyOpenId:string;jamesOpenId:string;output:string}
export async function parsePreviewAttachment(body:Buffer,mimeType:string,title:string,maxBytes:number):Promise<
  {status:'parsed';text:string}|{status:'text_unavailable';reason:string}
>{
  try{return{status:'parsed',text:await parseFeishuAttachment(body,mimeType,title,{maxBytes,maxChars:12_000})}}
  catch(error){const reason=error instanceof Error?error.message:'ATTACHMENT_PARSE_FAILED';
    if(reason.startsWith('ATTACHMENT_'))return{status:'text_unavailable',reason};throw error}
}
export function safePreviewErrorCode(error:unknown):string{
  if(!error||typeof error!=='object')return'UNKNOWN';
  const value=error as{code?:unknown;reason?:unknown};
  const code=typeof value.code==='string'&&/^[A-Z][A-Z0-9_]{1,79}$/u.test(value.code)?value.code:null;
  const reason=typeof value.reason==='string'&&/^[a-z][a-z0-9_]{1,79}$/u.test(value.reason)?value.reason:null;
  return code?`${code}${reason?`:${reason}`:''}`:'UNKNOWN';
}
export function parseFilePreviewArguments(args:readonly string[]):Arguments{
  const values=new Map<string,string>();for(let index=0;index<args.length;index+=2){const key=args[index],value=args[index+1];
    if(!key?.startsWith('--')||!value||values.has(key))throw new Error('FILE_PREVIEW_ARGUMENTS_INVALID');values.set(key,value)}
  const parsed={chatId:values.get('--chat-id')?.trim(),since:values.get('--since')?.trim(),until:values.get('--until')?.trim(),
    ivyOpenId:values.get('--ivy-open-id')?.trim(),jamesOpenId:values.get('--james-open-id')?.trim(),output:values.get('--output')?.trim()};
  if(values.size!==6||parsed.chatId!==approvedFeishuProjectContextChatId||!parsed.ivyOpenId||!parsed.jamesOpenId||
    parsed.ivyOpenId===parsed.jamesOpenId||!parsed.output||!parsed.since||!parsed.until||!Number.isFinite(Date.parse(parsed.since))||
    !Number.isFinite(Date.parse(parsed.until))||Date.parse(parsed.since)>=Date.parse(parsed.until))throw new Error('FILE_PREVIEW_ARGUMENTS_INVALID');
  return parsed as Arguments;
}

async function readAll(context:FeishuSdkContextClient,args:Arguments):Promise<FeishuContextMessage[]>{
  const result:FeishuContextMessage[]=[];const threads=new Set<string>();
  async function pages(threadId:string|null){let cursor:string|null=null;do{const range:{cursor:string|null;since:Date;until:Date}={cursor,since:new Date(args.since),until:new Date(args.until)};
    const page:FeishuContextPage=threadId?await context.listThreadMessages({threadId,...range}):await context.listMessages({chatId:args.chatId,...range});
    result.push(...page.messages);for(const message of page.messages)if(message.threadId)threads.add(message.threadId);cursor=page.nextCursor}while(cursor)}
  await pages(null);for(const thread of threads)await pages(thread);
  return [...new Map(result.map(message=>[message.messageId,message])).values()].sort((a,b)=>a.createdAt.localeCompare(b.createdAt));
}

async function download(sdk:FeishuSdkClientLike,file:FeishuContextFile,maxBytes=20*1024*1024):Promise<Buffer>{
  if(!file.messageId||!sdk.im.v1?.messageResource)throw new Error('ATTACHMENT_RESOURCE_UNAVAILABLE');
  const response=await sdk.im.v1.messageResource.get({params:{type:'file'},path:{message_id:file.messageId,file_key:file.fileToken}});
  const chunks:Buffer[]=[];let size=0;for await(const chunk of response.getReadableStream()){const buffer=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);
    size+=buffer.byteLength;if(size>maxBytes)throw new Error('ATTACHMENT_TOO_LARGE');chunks.push(buffer)}return Buffer.concat(chunks);
}

async function main(){
  const args=parseFilePreviewArguments(process.argv.slice(2));const appId=process.env.FEISHU_APP_ID?.trim(),appSecret=process.env.FEISHU_APP_SECRET?.trim();
  const workdir=process.env.CODEX_WORKDIR?.trim(),timeout=Number(process.env.CODEX_TIMEOUT_SECONDS||'300');
  if(!appId||!appSecret||!workdir||!Number.isSafeInteger(timeout)||timeout<=0)throw new Error('FILE_PREVIEW_CONFIG_INVALID');
  const sdk=createFeishuSdkClient({appId,appSecret}),context=new FeishuSdkContextClient(sdk),messages=await readAll(context,args);
  const files=(await context.listReferencedFiles({chatId:args.chatId,messageIds:messages.map(message=>message.messageId)}))
    .filter(file=>file.messageId&&!file.mimeType.startsWith('application/vnd.feishu.')&&!file.mimeType.startsWith('audio/')&&!file.mimeType.startsWith('video/'));
  const database=createSqliteDatabase(':memory:');migrateDatabase(database.client);const repository=new ContextSourceRepository(database.client);
  try{
    const capturedAt=new Date(args.until),sourceIds:string[]=[];
    for(const message of messages){if(!['text','post','voice'].includes(message.messageType)||!message.text?.trim()||message.senderType!=='user')continue;
      const saved=repository.saveSource(captureGroupMessageSource({chatId:args.chatId,messageId:message.messageId,threadId:message.threadId??null,
        rootId:message.rootId??null,author:{openId:message.senderId??null,displayName:null},senderType:'user',messageType:message.messageType,
        text:message.text,occurredAt:message.createdAt},capturedAt).source).source;sourceIds.push(saved.id)}
    const fileSources=[];const contextMessages:FileContextMessage[]=messages.map(message=>({messageId:message.messageId,occurredAt:message.createdAt,
      text:message.text,messageType:message.messageType,senderType:message.senderType??'unknown',threadId:message.threadId??null,rootId:message.rootId??null}));
    for(const file of files){const compressed=/\.(zip|docx|xlsx)$/iu.test(file.title)||['application/zip',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'].includes(file.mimeType);
      const maxBytes=compressed?80*1024*1024:20*1024*1024;
      const parsedResult=await parsePreviewAttachment(await download(sdk,file,maxBytes),file.mimeType,file.title,maxBytes);
      if(parsedResult.status==='text_unavailable'){fileSources.push({sourceId:null,title:file.title,mimeType:file.mimeType,messageId:file.messageId,
        contextMessageIds:[],parsedChars:0,truncated:false,status:parsedResult.status,reason:parsedResult.reason});continue}
      const parsed=parsedResult.text;
      if(!parsed.trim()){fileSources.push({sourceId:null,title:file.title,mimeType:file.mimeType,messageId:file.messageId,
        contextMessageIds:[],parsedChars:0,truncated:false,status:'text_unavailable'});continue}
      const assembled=assembleFeishuFileContext({file:{messageId:file.messageId!,title:file.title,mimeType:file.mimeType,text:parsed},messages:contextMessages,maxChars:20_000});
      const anchor=messages.find(message=>message.messageId===file.messageId)!;
      const saved=repository.saveSource(captureGroupMessageSource({chatId:args.chatId,messageId:`${file.messageId}:file:${file.fileToken.slice(-12)}`,
        threadId:anchor.threadId??null,rootId:anchor.rootId??null,author:{openId:anchor.senderId??null,displayName:null},senderType:'user',
        messageType:'text',text:assembled.contentText,occurredAt:anchor.createdAt},capturedAt).source).source;sourceIds.push(saved.id);
      fileSources.push({sourceId:saved.id,title:file.title,mimeType:file.mimeType,messageId:file.messageId,contextMessageIds:assembled.contextMessageIds,
        parsedChars:parsed.length,truncated:parsed.length>=12_000,status:'parsed'})}
    const codex=new CodexCliAdapter({command:process.env.CODEX_COMMAND?.trim()||'codex',workdir,timeoutMs:timeout*1000,
      runner:new NodeCodexProcessRunner(),baseEnv:process.env});
    const result=await buildFounderWorkMapPreview({client:database.client,chatId:args.chatId,since:args.since,until:args.until,sourceIds,
      founderOpenIds:{ivy:args.ivyOpenId,james:args.jamesOpenId},...createFounderAnalysisAdapters({codex})});
    await writeFile(args.output,JSON.stringify({generatedAt:new Date().toISOString(),messages:messages.length,attachments:fileSources,result},null,2),{mode:0o600});
    process.stdout.write(JSON.stringify({messages:messages.length,attachments:fileSources.length,topics:result.topics.length,evidence:result.evidence.length,
      alignmentProposals:result.alignmentProposals.length,output:args.output})+'\n');
  }finally{database.close()}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)void main().catch((error)=>{
  const code=safePreviewErrorCode(error);
  process.stderr.write(`File work map preview failed: ${code}. No source content logged.\n`);process.exitCode=1});

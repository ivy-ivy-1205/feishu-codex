import { pathToFileURL } from 'node:url';
import { createFeishuSdkClient, FeishuSdkContextClient } from '../adapters/feishu-sdk.js';
import { createSqliteDatabase } from '../db/client.js';
import { migrateDatabase } from '../db/migrate.js';
import { OutboxRepository } from '../repositories/outbox-repository.js';
import { applyFounderBatchDraft, draftFounderBatchCorrection, founderBatchOperationsSchema } from '../services/founder-batch-correction.js';
import { approvedFeishuProjectContextChatId, type FeishuContextMessage, type FeishuContextPage } from '../services/feishu-context-sync.js';

interface Arguments {database:string;chatId:string;messageId:string;since:string;until:string;mode:'preview'|'apply'}

export function parseRecoverFounderCorrectionArguments(args:readonly string[]):Arguments{
  const values=new Map<string,string>();
  for(let index=0;index<args.length;index+=2){const key=args[index],value=args[index+1];
    if(!key?.startsWith('--')||!value||values.has(key))throw new Error('FOUNDER_CORRECTION_RECOVERY_ARGUMENTS_INVALID');values.set(key,value)}
  const result={database:values.get('--database')?.trim(),chatId:values.get('--chat-id')?.trim(),messageId:values.get('--message-id')?.trim(),
    since:values.get('--since')?.trim(),until:values.get('--until')?.trim(),mode:values.get('--mode')?.trim()};
  if(values.size!==6||!result.database||result.chatId!==approvedFeishuProjectContextChatId||!result.messageId?.startsWith('om_')||
    !result.since||!result.until||!Number.isFinite(Date.parse(result.since))||!Number.isFinite(Date.parse(result.until))||
    Date.parse(result.since)>=Date.parse(result.until)||!['preview','apply'].includes(result.mode??''))
    throw new Error('FOUNDER_CORRECTION_RECOVERY_ARGUMENTS_INVALID');
  return result as Arguments;
}

async function findMessage(context:FeishuSdkContextClient,args:Arguments):Promise<FeishuContextMessage>{
  const messages=new Map<string,FeishuContextMessage>(),threads=new Set<string>();
  async function read(kind:'chat'|'thread',id:string){let cursor:string|null=null,guard=0;do{
    if(++guard>200)throw new Error('FOUNDER_CORRECTION_RECOVERY_PAGINATION_LIMIT');
    const range:{cursor:string|null;since:Date;until:Date}={cursor,since:new Date(args.since),until:new Date(args.until)};
    const page:FeishuContextPage=kind==='chat'?await context.listMessages({chatId:id,...range}):await context.listThreadMessages({threadId:id,...range});
    for(const message of page.messages){messages.set(message.messageId,message);if(message.threadId)threads.add(message.threadId)}
    if(page.paginationStatus==='invalid')throw new Error('FOUNDER_CORRECTION_RECOVERY_PAGINATION_INVALID');
    cursor=page.nextCursor;
  }while(cursor)}
  await read('chat',args.chatId);
  if(!messages.has(args.messageId))for(const thread of threads){await read('thread',thread);if(messages.has(args.messageId))break}
  const message=messages.get(args.messageId);
  // Feishu returns the current visible body for edited messages. The exact message ID,
  // founder identity, reply binding and stored content hash remain the authority checks.
  if(!message||message.deleted||message.senderType!=='user'||!message.senderId||!message.text?.trim()||
    !['text','post'].includes(message.messageType)||!Number.isFinite(Date.parse(message.createdAt)))
    throw new Error('FOUNDER_CORRECTION_RECOVERY_MESSAGE_INVALID');
  return message;
}

async function main(){
  const args=parseRecoverFounderCorrectionArguments(process.argv.slice(2));
  const appId=process.env.FEISHU_APP_ID?.trim(),appSecret=process.env.FEISHU_APP_SECRET?.trim();
  if(!appId||!appSecret)throw new Error('FOUNDER_CORRECTION_RECOVERY_CONFIG_INVALID');
  const database=createSqliteDatabase(args.database);
  try{
    migrateDatabase(database.client);
    const context=new FeishuSdkContextClient(createFeishuSdkClient({appId,appSecret})),message=await findMessage(context,args);
    const senderId=message.senderId!,messageText=message.text!;
    const founder=database.client.prepare("SELECT id FROM founder_identities WHERE source_system='feishu' AND external_author_id=?")
      .get(senderId);if(!founder)throw new Error('FOUNDER_CORRECTION_RECOVERY_AUTHOR_INVALID');
    const replyTo=message.parentId||message.rootId||'';
    if(!replyTo)throw new Error('FOUNDER_CORRECTION_RECOVERY_BINDING_MISSING');
    const binding=new OutboxRepository(database.client).findDeliveredFounderMessage(args.chatId,replyTo);
    if(!binding||binding.kind!=='founder_work_map')throw new Error('FOUNDER_CORRECTION_RECOVERY_BINDING_INVALID');
    const dependencies={client:database.client,approvedChatIds:[args.chatId],now:()=>new Date()};
    const decision=draftFounderBatchCorrection({chatId:args.chatId,openId:senderId,messageId:message.messageId,replyTo,
      text:messageText,occurredAt:message.createdAt,threadId:message.threadId??null,rootId:message.rootId??null},binding,dependencies);
    if(!decision||!('draftId'in decision)||decision.correctionKind!=='batch_correction'||
      decision.status!=='pending_confirmation')throw new Error('FOUNDER_CORRECTION_RECOVERY_DRAFT_INVALID');
    const row=database.client.prepare('SELECT operations_json,status FROM founder_feedback_drafts WHERE id=?').get(decision.draftId) as
      {operations_json:string;status:string}|undefined;
    const operations=founderBatchOperationsSchema.parse(JSON.parse(row?.operations_json??'null'));
    let applied=false;
    if(args.mode==='apply'){
      const result=applyFounderBatchDraft(decision.draftId,dependencies,{cancelPendingFeedbackKey:`founder-feedback:${args.chatId}:${args.messageId}`});
      if(result.kind!=='corrected'||result.correctionKind!=='batch_correction'||result.status!=='applied')
        throw new Error('FOUNDER_CORRECTION_RECOVERY_APPLY_FAILED');
      applied=true;
    }
    const counts=Object.fromEntries([...new Set(operations.map(operation=>operation.kind))].sort()
      .map(kind=>[kind,operations.filter(operation=>operation.kind===kind).length]));
    process.stdout.write(`${JSON.stringify({mode:args.mode,messageId:message.messageId,mapId:binding.mapId,draftId:decision.draftId,
      operationCount:operations.length,operationKinds:counts,applied})}\n`);
  }finally{database.close()}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)void main().catch(error=>{
  const code=error instanceof Error&&/^[A-Z0-9_: -]+$/u.test(error.message)?error.message:'FOUNDER_CORRECTION_RECOVERY_FAILED';
  process.stderr.write(`${code}\n`);process.exitCode=1;
});

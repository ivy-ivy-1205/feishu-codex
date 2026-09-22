import type { ContextSourceRepository } from '../repositories/context-source-repository.js';
import type { JobRepository } from '../repositories/job-repository.js';
import { parseFeishuAttachment } from './feishu-attachment-parser.js';
import { assembleFeishuFileContext,type FileContextMessage } from './feishu-file-context.js';
import type { FeishuContextFile,FeishuContextMessage } from './feishu-context-sync.js';
import { captureGroupMessageSource } from './group-message-source-capture.js';
import { sha256 } from './canonical-json.js';

export interface FounderAttachmentBackfillInput{
  chatId:string;now:Date;messages:readonly FeishuContextMessage[];files:readonly FeishuContextFile[];
  read(file:FeishuContextFile):Promise<Buffer>;sourceRepository:ContextSourceRepository;jobRepository:JobRepository;
}

export async function persistFounderAttachmentBackfill(input:FounderAttachmentBackfillInput){
  const contextMessages:FileContextMessage[]=input.messages.map(message=>({messageId:message.messageId,occurredAt:message.createdAt,
    text:message.text,messageType:message.messageType,senderType:message.senderType??'unknown',threadId:message.threadId??null,rootId:message.rootId??null}));
  const parsedSources:{id:string;chars:number}[]=[];let sourcesCreated=0,filesParsed=0,filesUnavailable=0;
  for(const file of input.files){
    const anchor=input.messages.find(message=>message.messageId===file.messageId);
    if(!anchor||anchor.senderType!=='user'||!file.messageId||file.mimeType.startsWith('audio/')||file.mimeType.startsWith('video/')){filesUnavailable++;continue}
    try{
      const compressed=/\.(zip|docx|xlsx)$/iu.test(file.title),maxBytes=compressed?80*1024*1024:20*1024*1024;
      const text=await parseFeishuAttachment(await input.read(file),file.mimeType,file.title,{maxBytes,maxChars:12_000});
      if(!text.trim()){filesUnavailable++;continue}
      const assembled=assembleFeishuFileContext({file:{messageId:file.messageId,title:file.title,mimeType:file.mimeType,text},messages:contextMessages,maxChars:20_000});
      const suffix=sha256(`${file.messageId}\n${file.title}`).slice(0,16),externalId=`${file.messageId}:file:${suffix}`;
      const captured=captureGroupMessageSource({chatId:input.chatId,messageId:externalId,threadId:anchor.threadId??null,rootId:anchor.rootId??null,
        author:{openId:anchor.senderId??null,displayName:null},senderType:'user',messageType:'file',text:assembled.contentText,occurredAt:anchor.createdAt},input.now);
      captured.source.metadata={...captured.source.metadata,messageId:file.messageId,attachmentTitle:file.title,mimeType:file.mimeType,
        contextMessageIds:assembled.contextMessageIds};captured.source.rawTextExpiresAt=new Date(input.now.getTime()+90*24*60*60_000);
      const saved=input.sourceRepository.saveSource(captured.source);if(saved.created)sourcesCreated++;
      parsedSources.push({id:saved.source.id,chars:saved.source.contentText.length});filesParsed++;
    }catch{filesUnavailable++}
  }
  let jobsEnqueued=0;const batches:{id:string;chars:number}[][]=[];
  for(const source of parsedSources){const current=batches.at(-1);if(!current||current.length>=20||current.reduce((sum,item)=>sum+item.chars,0)+source.chars>40_000)batches.push([source]);else current.push(source)}
  for(const batch of batches){const result=input.jobRepository.enqueueFounderStreamBatch({chatId:input.chatId,
    since:input.messages[0]?.createdAt??input.now.toISOString(),until:input.now.toISOString(),sourceIds:batch.map(source=>source.id),capturedAt:input.now});
    if(result.created)jobsEnqueued++}
  return{filesSeen:input.files.length,filesParsed,filesUnavailable,sourcesCreated,jobsEnqueued};
}

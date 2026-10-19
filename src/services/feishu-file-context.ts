import { sha256, stableId } from './canonical-json.js';

export interface FileContextMessage {
  messageId:string;occurredAt:string;text:string|null;messageType:string;senderType:string;
  threadId:string|null;rootId:string|null;
}
export interface ParsedFeishuFile {messageId:string;title:string;mimeType:string;text:string}
export interface AssembleFeishuFileContextInput {file:ParsedFeishuFile;messages:readonly FileContextMessage[];maxChars?:number}

export function assembleFeishuFileContext(input:AssembleFeishuFileContextInput){
  const anchor=input.messages.find(message=>message.messageId===input.file.messageId);
  if(!anchor)throw new Error('FILE_CONTEXT_ANCHOR_MISSING');
  if(!input.file.text.trim())throw new Error('FILE_CONTEXT_TEXT_EMPTY');
  const at=Date.parse(anchor.occurredAt);if(!Number.isFinite(at))throw new Error('FILE_CONTEXT_TIME_INVALID');
  const eligible=input.messages.filter(message=>message.messageId!==anchor.messageId&&message.senderType==='user'&&
    ['text','post','voice'].includes(message.messageType)&&Boolean(message.text?.trim())&&Number.isFinite(Date.parse(message.occurredAt)));
  const sameThread=anchor.threadId||anchor.rootId;
  const threaded=sameThread?eligible.filter(message=>(message.threadId||message.rootId)===sameThread):[];
  const near=eligible.filter(message=>Math.abs(Date.parse(message.occurredAt)-at)<=30*60_000)
    .sort((a,b)=>Date.parse(a.occurredAt)-Date.parse(b.occurredAt));
  const before=near.filter(message=>Date.parse(message.occurredAt)<at).slice(-3);
  const after=near.filter(message=>Date.parse(message.occurredAt)>at).slice(0,3);
  const context=[...new Map([...before,...after,...threaded].map(message=>[message.messageId,message])).values()]
    .sort((a,b)=>Date.parse(a.occurredAt)-Date.parse(b.occurredAt));
  const sections=[`[附件：${input.file.title}]`,input.file.text,'[分享消息前后上下文]',
    ...context.map(message=>`${message.occurredAt} ${message.text!.trim()}`)];
  const contentText=sections.join('\n').slice(0,input.maxChars??200_000);
  const id=stableId('transientfile',`${input.file.messageId}:${input.file.title}:${sha256(contentText)}`);
  return {id,sourceType:'group_message' as const,sourceVersion:1,contentHash:sha256(contentText),contentText,
    occurredAt:anchor.occurredAt,availabilityStatus:'available' as const,messageId:anchor.messageId,
    contextMessageIds:context.map(message=>message.messageId),title:input.file.title,mimeType:input.file.mimeType};
}

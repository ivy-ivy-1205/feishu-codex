import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createFeishuSdkClient } from '../adapters/feishu-sdk.js';
import { createFeishuWhiteboardGateway, type FeishuWhiteboardSdkLike } from '../adapters/feishu-whiteboard.js';
import { publishFounderWhiteboard, type FounderWhiteboardGateway } from '../services/founder-whiteboard.js';

const approvedChatId='oc_a84d5b6ca478220d0a37964b50776edb';
type WhiteboardPreflightStage='create_document'|'create_board'|'create_nodes'|'grant_group_edit'|'unknown';

class WhiteboardPreflightStageError extends Error {
  constructor(readonly stage:Exclude<WhiteboardPreflightStage,'unknown'>,readonly original:unknown){
    super('Founder whiteboard preflight stage failed');
  }
}

export function parseWhiteboardPreflightArguments(args:string[]):{chatId:string}{
  const {values}=parseArgs({args:args[0]==='--'?args.slice(1):args,strict:true,options:{
    'chat-id':{type:'string'},create:{type:'boolean'}
  }});
  if(values['chat-id']!==approvedChatId)throw new Error('whiteboard preflight requires the approved group');
  if(values.create!==true)throw new Error('whiteboard preflight requires explicit --create mode');
  return{chatId:values['chat-id']};
}

export async function runWhiteboardPreflightCli(args:string[],dependencies:{gateway:FounderWhiteboardGateway;
  write:(value:string)=>void}):Promise<void>{
  const input=parseWhiteboardPreflightArguments(args);
  const gateway:FounderWhiteboardGateway={
    createDocument:value=>atStage('create_document',()=>dependencies.gateway.createDocument(value)),
    createBoard:value=>atStage('create_board',()=>dependencies.gateway.createBoard(value)),
    createNodes:value=>atStage('create_nodes',()=>dependencies.gateway.createNodes(value)),
    grantGroupEdit:value=>atStage('grant_group_edit',()=>dependencies.gateway.grantGroupEdit(value))
  };
  const artifact=await publishFounderWhiteboard({title:'AiJia 机器人白板权限核验',paletteId:'grove',chatId:input.chatId,cards:[{
    header:{title:{content:'机器人白板权限核验'}},elements:[{text:{content:'原生节点创建与群编辑权限已通过。此文档不含业务数据。'}}]
  }]},gateway);
  dependencies.write(JSON.stringify(artifact));
}

export function formatWhiteboardPreflightFailure(error:unknown):{status:'failed';stage:WhiteboardPreflightStage;
  feishuCode:number|null}{
  const staged=error instanceof WhiteboardPreflightStageError?error:null;
  return{status:'failed',stage:staged?.stage??'unknown',feishuCode:feishuCode(staged?.original??error)};
}

async function atStage<T>(stage:Exclude<WhiteboardPreflightStage,'unknown'>,operation:()=>Promise<T>):Promise<T>{
  try{return await operation();}catch(error){throw new WhiteboardPreflightStageError(stage,error);}
}

function feishuCode(error:unknown):number|null{
  if(!isRecord(error))return null;
  for(const candidate of [error.code,nested(error,'data','code'),nested(error,'response','data','code')]){
    if(typeof candidate==='number'&&Number.isSafeInteger(candidate))return candidate;
  }
  const match=typeof error.message==='string'?error.message.match(/\((-?\d+)\)/):null;
  return match?Number(match[1]):null;
}

function nested(value:Record<string,unknown>,...path:string[]):unknown{
  let current:unknown=value;
  for(const key of path){if(!isRecord(current))return undefined;current=current[key];}
  return current;
}
function isRecord(value:unknown):value is Record<string,unknown>{return typeof value==='object'&&value!==null;}

async function main():Promise<void>{
  const appId=process.env.FEISHU_APP_ID?.trim(),appSecret=process.env.FEISHU_APP_SECRET?.trim();
  if(!appId||!appSecret)throw new Error('Feishu app configuration required');
  const sdk=createFeishuSdkClient({appId,appSecret}) as unknown as FeishuWhiteboardSdkLike;
  await runWhiteboardPreflightCli(process.argv.slice(2),{
    gateway:createFeishuWhiteboardGateway(sdk),write:value=>process.stdout.write(`${value}\n`)
  });
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  void main().catch(error=>{
    process.stderr.write(`${JSON.stringify(formatWhiteboardPreflightFailure(error))}\n`);
    process.exitCode=1;
  });
}

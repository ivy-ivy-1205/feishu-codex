import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createFeishuSdkClient } from '../adapters/feishu-sdk.js';
import { createFeishuWhiteboardGateway, type FeishuWhiteboardSdkLike } from '../adapters/feishu-whiteboard.js';
import { publishFounderWhiteboard, type FounderWhiteboardGateway } from '../services/founder-whiteboard.js';

const approvedChatId='oc_a84d5b6ca478220d0a37964b50776edb';

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
  const artifact=await publishFounderWhiteboard({title:'AiJia 机器人白板权限核验',paletteId:'grove',chatId:input.chatId,cards:[{
    header:{title:{content:'机器人白板权限核验'}},elements:[{text:{content:'原生节点创建与群编辑权限已通过。此文档不含业务数据。'}}]
  }]},dependencies.gateway);
  dependencies.write(JSON.stringify(artifact));
}

async function main():Promise<void>{
  const appId=process.env.FEISHU_APP_ID?.trim(),appSecret=process.env.FEISHU_APP_SECRET?.trim();
  if(!appId||!appSecret)throw new Error('Feishu app configuration required');
  const sdk=createFeishuSdkClient({appId,appSecret}) as unknown as FeishuWhiteboardSdkLike;
  await runWhiteboardPreflightCli(process.argv.slice(2),{
    gateway:createFeishuWhiteboardGateway(sdk),write:value=>process.stdout.write(`${value}\n`)
  });
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  void main().catch(()=>{
    process.stderr.write('Founder whiteboard preflight failed. Check app scopes and the approved group.\n');
    process.exitCode=1;
  });
}

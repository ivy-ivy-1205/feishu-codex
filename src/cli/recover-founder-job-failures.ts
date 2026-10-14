import { statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import Database from 'better-sqlite3';
import { migrateDatabase } from '../db/migrate.js';
import { applyFounderJobRecovery, planFounderJobRecovery } from '../services/founder-job-recovery.js';
import { approvedFeishuProjectContextChatId } from '../services/feishu-context-sync.js';

export interface FounderJobRecoveryArguments{
  database:string;chatId:string;mode:'preview'|'apply';confirmedRecoveryId:string|null;
}

export function parseFounderJobRecoveryArguments(args:readonly string[]):FounderJobRecoveryArguments{
  const{values}=parseArgs({args:args[0]==='--'?args.slice(1):[...args],strict:true,options:{database:{type:'string'},
    'chat-id':{type:'string'},preview:{type:'boolean'},apply:{type:'boolean'},'confirm-recovery-id':{type:'string'}}});
  const database=values.database?.trim(),chatId=values['chat-id']?.trim(),preview=Boolean(values.preview),apply=Boolean(values.apply);
  const confirmedRecoveryId=values['confirm-recovery-id']?.trim()??null;
  if(!database||chatId!==approvedFeishuProjectContextChatId||preview===apply||(preview&&confirmedRecoveryId!==null)||
    (apply&&!confirmedRecoveryId?.startsWith('founderjobrecovery_')))throw new Error('FOUNDER_JOB_RECOVERY_ARGUMENTS_INVALID');
  return{database,chatId,mode:apply?'apply':'preview',confirmedRecoveryId};
}

function main():void{
  const args=parseFounderJobRecoveryArguments(process.argv.slice(2));
  if(!statSync(args.database).isFile())throw new Error('FOUNDER_JOB_RECOVERY_DATABASE_INVALID');
  const client=new Database(args.database,{readonly:args.mode==='preview',fileMustExist:true});
  try{
    if(args.mode==='preview')client.pragma('query_only = ON');else migrateDatabase(client);
    const scope={chatId:args.chatId,approvedChatIds:[approvedFeishuProjectContextChatId]};
    const result=args.mode==='preview'?planFounderJobRecovery(client,scope):applyFounderJobRecovery(client,{...scope,
      confirmedRecoveryId:args.confirmedRecoveryId!,now:new Date()});
    process.stdout.write(`${JSON.stringify({mode:args.mode,...result})}\n`);
  }finally{client.close()}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)try{main()}catch(error){
  const code=error instanceof Error&&/^[A-Z0-9_: -]+$/u.test(error.message)?error.message:'FOUNDER_JOB_RECOVERY_FAILED';
  process.stderr.write(`${code}\n`);process.exitCode=1;
}

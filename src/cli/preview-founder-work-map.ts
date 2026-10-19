import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import type DatabaseTypes from 'better-sqlite3';
import { CodexCliAdapter, NodeCodexProcessRunner } from '../adapters/codex-cli.js';
import { createFounderAnalysisAdapters } from '../composition/founder-stream-analysis.js';
import { buildFounderWorkMapPreview } from '../services/founder-work-map-preview.js';
import { resolveMigrationDatabasePath } from './migrate-context-source-retention.js';

export interface FounderPreviewArguments {
  chatId: string;
  since: string;
  until: string;
  ivyOpenId: string;
  jamesOpenId: string;
  expectedSourceCount: number;
}

export function parseFounderPreviewArguments(args: readonly string[]): FounderPreviewArguments {
  const values = new Map<string,string>();
  for (let index=0; index<args.length; index+=2) {
    const key=args[index], value=args[index+1];
    if (!key?.startsWith('--') || !value || values.has(key)) throw new Error('FOUNDER_PREVIEW_ARGUMENTS_INVALID');
    values.set(key,value);
  }
  const expectedSourceCount=Number(values.get('--expected-source-count'));
  const parsed={chatId:values.get('--chat-id')?.trim(),since:values.get('--since')?.trim(),until:values.get('--until')?.trim(),
    ivyOpenId:values.get('--ivy-open-id')?.trim(),jamesOpenId:values.get('--james-open-id')?.trim(),expectedSourceCount};
  if(values.size!==6||!parsed.chatId||!parsed.since||!parsed.until||!parsed.ivyOpenId||!parsed.jamesOpenId||
    parsed.ivyOpenId===parsed.jamesOpenId||!Number.isSafeInteger(expectedSourceCount)||expectedSourceCount<=0||
    !Number.isFinite(Date.parse(parsed.since))||!Number.isFinite(Date.parse(parsed.until))||Date.parse(parsed.since)>=Date.parse(parsed.until))
    throw new Error('FOUNDER_PREVIEW_ARGUMENTS_INVALID');
  return parsed as FounderPreviewArguments;
}

export function loadFounderPreviewBatch(client: DatabaseTypes.Database, args: FounderPreviewArguments): {sourceIds:string[]} {
  const rows=client.prepare(`SELECT payload FROM batch_jobs WHERE type='analyze_founder_stream_batch' AND status='queued'`).all() as {payload:string}[];
  const matches=rows.flatMap(({payload})=>{try {
    const value=JSON.parse(payload) as Record<string,unknown>;
    return value.chatId===args.chatId&&value.since===args.since&&value.until===args.until&&Array.isArray(value.sourceIds)
      ? [{sourceIds:value.sourceIds}] : [];
  } catch { return []; }});
  if(matches.length!==1||matches[0]!.sourceIds.length!==args.expectedSourceCount||
    !matches[0]!.sourceIds.every((id):id is string=>typeof id==='string'&&id.length>0)||
    new Set(matches[0]!.sourceIds).size!==args.expectedSourceCount) throw new Error('FOUNDER_PREVIEW_BATCH_INVALID');
  return {sourceIds:matches[0]!.sourceIds as string[]};
}

async function main():Promise<void>{
  const args=parseFounderPreviewArguments(process.argv.slice(2));
  const databasePath=resolveMigrationDatabasePath(process.env.DATABASE_URL);
  const client=new Database(databasePath,{readonly:true,fileMustExist:true});
  try {
    client.pragma('query_only = ON');
    const batch=loadFounderPreviewBatch(client,args);
    const command=process.env.CODEX_COMMAND?.trim()||'codex';
    const workdir=process.env.CODEX_WORKDIR?.trim();
    const timeoutSeconds=Number(process.env.CODEX_TIMEOUT_SECONDS||'120');
    if(!workdir||!Number.isSafeInteger(timeoutSeconds)||timeoutSeconds<=0) throw new Error('CODEX_PREVIEW_CONFIG_INVALID');
    const adapters=createFounderAnalysisAdapters({codex:new CodexCliAdapter({command,workdir,timeoutMs:timeoutSeconds*1000,
      runner:new NodeCodexProcessRunner(),baseEnv:process.env})});
    const result=await buildFounderWorkMapPreview({client,chatId:args.chatId,since:args.since,until:args.until,
      sourceIds:batch.sourceIds,founderOpenIds:{ivy:args.ivyOpenId,james:args.jamesOpenId},...adapters});
    process.stdout.write(`${JSON.stringify(result,null,2)}\n`);
  } finally { client.close(); }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  void main().catch(()=>{process.stderr.write('Founder work map preview failed. No source content logged.\n');process.exitCode=1;});
}

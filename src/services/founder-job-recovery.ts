import type Database from 'better-sqlite3';
import { canonicalJson, stableId } from './canonical-json.js';

type RecoverableKind='capture_group_message'|'capture_founder_attachment'|'analyze_founder_stream_batch';
interface FailedRow {stable_key:string;type:RecoverableKind;payload:string}
interface PlannedRow extends FailedRow {nextPayload:string;sourceIds:string[]}

export interface FounderJobRecoveryPlan{
  recoveryId:string;analysisJobs:number;captureJobs:number;unresolvedSourceCount:number;totalJobs:number;invalidAnalysisJobs:number;
}

export function planFounderJobRecovery(client:Database.Database,input:{chatId:string;approvedChatIds:readonly string[]}):FounderJobRecoveryPlan{
  return publicPlan(buildPlan(client,input));
}

export function applyFounderJobRecovery(client:Database.Database,input:{chatId:string;approvedChatIds:readonly string[];
  confirmedRecoveryId:string;now:Date}):FounderJobRecoveryPlan&{applied:true}{
  if(!Number.isFinite(input.now.getTime()))throw new Error('FOUNDER_JOB_RECOVERY_TIME_INVALID');
  return client.transaction(()=>{const plan=buildPlan(client,input);
    if(plan.recoveryId!==input.confirmedRecoveryId)throw new Error('FOUNDER_JOB_RECOVERY_CONFIRMATION_MISMATCH');
    for(const row of plan.rows){const updated=client.prepare(`UPDATE batch_jobs SET status='queued',payload=?,updated_at=?
        WHERE stable_key=? AND status='failed' AND payload=?`).run(row.nextPayload,input.now.toISOString(),row.stable_key,row.payload);
      if(updated.changes!==1)throw new Error('FOUNDER_JOB_RECOVERY_STATE_DRIFT')}
    return{...publicPlan(plan),applied:true as const};
  }).immediate();
}

function buildPlan(client:Database.Database,input:{chatId:string;approvedChatIds:readonly string[]}):FounderJobRecoveryPlan&{rows:PlannedRow[]}{
  if(!input.chatId.trim()||!input.approvedChatIds.includes(input.chatId))throw new Error('FOUNDER_JOB_RECOVERY_CHAT_NOT_APPROVED');
  const all=client.prepare(`SELECT stable_key,type,payload FROM batch_jobs WHERE status='failed'
    AND type IN ('capture_group_message','capture_founder_attachment','analyze_founder_stream_batch') ORDER BY stable_key`)
    .all() as FailedRow[];
  const completed=new Set<string>();
  const completedRows=client.prepare("SELECT payload FROM batch_jobs WHERE status='completed' AND type='analyze_founder_stream_batch'").all() as {payload:string}[];
  for(const row of completedRows){const parsed=parsePayload(row.payload);if(parsed?.chatId===input.chatId)for(const id of parsed.sourceIds)completed.add(id)}
  let invalidAnalysisJobs=0;const rows:PlannedRow[]=[];
  for(const row of all){const parsed=parsePayload(row.payload);if(!parsed||parsed.chatId!==input.chatId)continue;
    if(row.type==='analyze_founder_stream_batch'){
      if(parsed.sourceIds.length===0){invalidAnalysisJobs++;continue}
      if(parsed.sourceIds.every(id=>completed.has(id)))continue;
    }
    const unresolvedSourceIds=parsed.sourceIds.filter(id=>!completed.has(id));
    const next:Record<string,unknown>={...parsed.raw,attempt:0,...(row.type==='analyze_founder_stream_batch'?{sourceIds:unresolvedSourceIds}:{})};
    delete next.failureReason;delete next.failure;
    rows.push({...row,nextPayload:canonicalJson(next),sourceIds:unresolvedSourceIds});
  }
  const recoveryId=stableId('founderjobrecovery',canonicalJson(rows.map(row=>({key:row.stable_key,type:row.type,payload:row.payload}))));
  return{recoveryId,analysisJobs:rows.filter(row=>row.type==='analyze_founder_stream_batch').length,
    captureJobs:rows.filter(row=>row.type!=='analyze_founder_stream_batch').length,
    unresolvedSourceCount:new Set(rows.flatMap(row=>row.sourceIds)).size,totalJobs:rows.length,invalidAnalysisJobs,rows};
}

function parsePayload(value:string):{chatId:string;sourceIds:string[];raw:Record<string,unknown>}|null{
  try{const raw=JSON.parse(value) as unknown;if(!raw||typeof raw!=='object'||Array.isArray(raw))return null;
    const record=raw as Record<string,unknown>,chatId=record.chatId;if(typeof chatId!=='string')return null;
    const sourceIds=Array.isArray(record.sourceIds)?record.sourceIds.filter((id):id is string=>typeof id==='string'&&Boolean(id.trim())):[];
    return{chatId,sourceIds:[...new Set(sourceIds)].sort(),raw:record};
  }catch{return null}
}

function publicPlan(plan:FounderJobRecoveryPlan):FounderJobRecoveryPlan{
  return{recoveryId:plan.recoveryId,analysisJobs:plan.analysisJobs,captureJobs:plan.captureJobs,
    unresolvedSourceCount:plan.unresolvedSourceCount,totalJobs:plan.totalJobs,invalidAnalysisJobs:plan.invalidAnalysisJobs};
}

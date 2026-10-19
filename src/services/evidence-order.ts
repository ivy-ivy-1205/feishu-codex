import type Database from 'better-sqlite3';

export interface EvidenceOrder { sourceId:string; sourceVersion:number; occurredAt:number; latestAt:number; sequence:number|null; trustedOffset:boolean }
export function evidenceOrder(client:Database.Database,id:string):EvidenceOrder|null {
  const row=client.prepare(`SELECT s.id,s.source_version,s.occurred_at,s.source_type,s.metadata_json,e.locator_json
    FROM context_evidence e JOIN context_sources s ON s.id=e.source_id WHERE e.id=?`).get(id) as
    {id:string;source_version:number;occurred_at:string;source_type:string;metadata_json:string;locator_json:string}|undefined;
  if(!row)return null;
  let occurredAt=Date.parse(row.occurred_at),latestAt=occurredAt,sequence:number|null=null,trustedOffset=false;
  if(row.source_type==='minute_transcript'){
    const locator=JSON.parse(row.locator_json),metadata=JSON.parse(row.metadata_json),segment=metadata.segments?.[locator.segmentOrdinal];
    if(!segment || !Number.isSafeInteger(segment.segmentOrdinal) || segment.segmentOrdinal<0)return null;
    sequence=segment.segmentOrdinal;
    // Old plain-text exports used ordinal placeholders in startMs. Only an
    // explicit parser provenance marker authorizes interpreting it as time.
    if(segment.timingKind==='media_offset' && Number.isSafeInteger(segment.startMs) && segment.startMs>=0){occurredAt+=segment.startMs;latestAt=occurredAt;trustedOffset=true;}
    else {
      const end=typeof metadata.endedAt==='string'?Date.parse(metadata.endedAt):NaN;
      latestAt=Number.isFinite(end) && end>=occurredAt?end:Infinity;
    }
  }
  return Number.isFinite(occurredAt)?{sourceId:row.id,sourceVersion:row.source_version,occurredAt,latestAt,sequence,trustedOffset}:null;
}
export function compareEvidenceOrder(a:EvidenceOrder|null,b:EvidenceOrder|null):number|null {
  if(!a||!b)return null;
  if(a.trustedOffset && b.trustedOffset)return Math.sign(a.occurredAt-b.occurredAt);
  if(a.sourceId===b.sourceId && a.sourceVersion===b.sourceVersion && a.sequence!==null && b.sequence!==null)
    return Math.sign(a.sequence-b.sequence);
  if(a.occurredAt===a.latestAt && b.occurredAt===b.latestAt)return Math.sign(a.occurredAt-b.occurredAt);
  if(a.occurredAt>b.latestAt)return 1;
  if(a.latestAt<b.occurredAt)return -1;
  return null;
}
export function compareEvidence(client:Database.Database,a:string,b:string):number|null {
  return compareEvidenceOrder(evidenceOrder(client,a),evidenceOrder(client,b));
}
export function isStrictlyNewer(client:Database.Database,id:string,existing:readonly string[]):boolean {
  return existing.length>0 && existing.every(other=>compareEvidence(client,id,other)===1);
}

import type { FounderWorkMapBoardTopic, FounderWorkMapBoardView } from './founder-board-view.js';

export type FounderWorkMapActivitySection='current'|'dormant'|'closed';

export interface FounderWorkMapActivityRow {
  name:string;
  kind:FounderWorkMapBoardTopic['kind'];
  section:FounderWorkMapActivitySection;
  /** Founder calendar (UTC+8) date of the latest linked activity, or null when none was recorded. */
  lastActivityDate:string|null;
  closedDate:string|null;
}

export interface FounderWorkMapActivitySummary {
  counts:Record<FounderWorkMapActivitySection,number>&{total:number};
  rows:FounderWorkMapActivityRow[];
}

const sectionOrder:FounderWorkMapActivitySection[]=['current','dormant','closed'];

/**
 * A pre-cutover review list: which section each visible topic lands in and when it last moved.
 * It carries names and dates only, so it can be shown to Ivy without exposing any source text.
 */
export function summarizeFounderWorkMapActivity(view:FounderWorkMapBoardView):FounderWorkMapActivitySummary{
  const rows=view.topics.map(topic=>({name:topic.name,kind:topic.kind,section:sectionOf(topic),
    lastActivityDate:founderDate(topic.lastActivityAt),closedDate:founderDate(topic.closedAt),
    activity:time(topic.lastActivityAt),closed:time(topic.closedAt)}));
  // Current: newest first. Dormant: stalest first, as on the board. Closed: most recently closed first.
  rows.sort((left,right)=>sectionOrder.indexOf(left.section)-sectionOrder.indexOf(right.section)||
    (left.section==='closed'?right.closed-left.closed:left.section==='dormant'?left.activity-right.activity:right.activity-left.activity));
  const counts={current:0,dormant:0,closed:0,total:rows.length};
  for(const row of rows)counts[row.section]+=1;
  return{counts,rows:rows.map(({name,kind,section,lastActivityDate,closedDate})=>({name,kind,section,lastActivityDate,closedDate}))};
}

function sectionOf(topic:FounderWorkMapBoardTopic):FounderWorkMapActivitySection{
  return topic.stage==='closed'?'closed':topic.dormant?'dormant':'current';
}
function time(value:string|null|undefined):number{const parsed=value?Date.parse(value):Number.NaN;return Number.isFinite(parsed)?parsed:0}
function founderDate(value:string|null|undefined):string|null{
  const parsed=value?Date.parse(value):Number.NaN;
  return Number.isFinite(parsed)?new Date(parsed+8*60*60*1_000).toISOString().slice(0,10):null;
}

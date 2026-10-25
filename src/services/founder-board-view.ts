import type { TopicStage } from '../domain/topic.js';

export interface FounderWorkMapBoardTopic {
  id:string;
  name:string;
  stage:TopicStage;
  kind:'project'|'task'|'goal'|'idea';
  outcome:string|null;
  parentName?:string;
  sourceCount?:number;
  /** Only for a Space-bound project card: one 本周 line and a small dated Space label. */
  space?:{weekLine:string|null;label:string};
  lastActivityAt?:string;
  /** Paused, or 30+ days without activity: listed in the reminder section until resumed or new activity arrives. */
  dormant?:boolean;
  closedAt?:string|null;
}

export interface FounderWorkMapBoardView {
  kind:'work_map';
  since:string;
  until:string;
  topics:readonly FounderWorkMapBoardTopic[];
  coverageGaps:readonly {id:string;summary:string}[];
}

/** 查看项目进展 as structure, so the board lays it out in Ivy's order instead of re-flowing card text. */
export interface FounderProjectProgressBoardView {
  kind:'project_progress';
  title:string;
  positioning:string;
  /** "正在推进 · 当前重点：Phase 6 …" */
  status:string;
  phases:readonly {name:string;tasks:string;status:'done'|'in_progress'|'upcoming';statusText:string;focus:boolean}[];
  /** Shown when there are no phases; null leaves 阶段规划 out (B-line content has a fixed workflow, Ivy 2026-10-24). */
  phasesEmpty:string|null;
  sections:readonly {title:string;items:readonly string[]}[];
  footer:string;
}

/** 查看分歧 as structure (Ivy 2026-10-25): the three counts first, then one section per category, then the 资料截至 line. */
export interface FounderAlignmentBoardView {
  kind:'alignment_overview';
  title:string;
  counts:readonly {title:string;count:number;note:string}[];
  sections:readonly {title:string;items:readonly string[]}[];
  footer:string;
}

export type FounderBoardView=FounderWorkMapBoardView|FounderProjectProgressBoardView|FounderAlignmentBoardView;

type Phase=FounderProjectProgressBoardView['phases'][number];
/** The focus outranks its status, so the one current focus is always the single ▶. */
export function founderPhaseMark(phase:Phase):string{return phase.focus?'▶':phase.status==='done'?'✓':phase.status==='in_progress'?'◐':'○'}
export const founderPhaseLegend='✓ 已完成　◐ 进行中　○ 未开始　▶ 当前重点';
export function founderPhasesTitle(phases:readonly Phase[]):string{
  const focus=phases.find(phase=>phase.focus);
  return`阶段规划（共 ${phases.length} 个阶段${focus?`，当前重点：${focus.name}`:''}）`;
}

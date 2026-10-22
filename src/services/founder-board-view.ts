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
  /** "正在推进 · 第 2 阶段：样板上线" */
  status:string;
  phases:readonly {name:string;tasks:string;status:'done'|'current'|'upcoming'}[];
  phasesEmpty:string;
  sections:readonly {title:string;items:readonly string[]}[];
  footer:string;
}

export type FounderBoardView=FounderWorkMapBoardView|FounderProjectProgressBoardView;

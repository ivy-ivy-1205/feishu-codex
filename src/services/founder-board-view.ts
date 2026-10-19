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
}

export interface FounderWorkMapBoardView {
  kind:'work_map';
  since:string;
  until:string;
  topics:readonly FounderWorkMapBoardTopic[];
  coverageGaps:readonly {id:string;summary:string}[];
}

export type FounderBoardView=FounderWorkMapBoardView;

import type { TopicStage } from '../domain/topic.js';

export interface FounderWorkMapBoardTopic {
  id:string;
  name:string;
  stage:TopicStage;
  kind:'project'|'task'|'goal';
  outcome:string|null;
  parentName?:string;
  sourceCount?:number;
}

export interface FounderWorkMapBoardView {
  kind:'work_map';
  since:string;
  until:string;
  topics:readonly FounderWorkMapBoardTopic[];
  coverageGaps:readonly {id:string;summary:string}[];
}

export type FounderBoardView=FounderWorkMapBoardView;

import { describe,expect,it } from 'vitest';
import { summarizeFounderWorkMapActivity } from '../src/services/founder-work-map-activity-summary.js';
import type { FounderWorkMapBoardTopic, FounderWorkMapBoardView } from '../src/services/founder-board-view.js';

function view(topics:FounderWorkMapBoardTopic[]):FounderWorkMapBoardView{
  return{kind:'work_map',since:'2026-08-31T00:00:00Z',until:'2026-10-19T12:00:00Z',topics,coverageGaps:[]};
}
const topic=(id:string,overrides:Partial<FounderWorkMapBoardTopic>={}):FounderWorkMapBoardTopic=>
  ({id,name:id,stage:'active_project',kind:'project',outcome:null,...overrides});

describe('founder work map activity summary',()=>{
  it('places every visible topic in exactly one section with its founder-calendar dates',()=>{
    const summary=summarizeFounderWorkMapActivity(view([
      topic('fresh',{lastActivityAt:'2026-10-18T17:30:00Z'}),
      topic('older',{lastActivityAt:'2026-10-01T03:00:00Z'}),
      topic('stale',{lastActivityAt:'2026-08-01T00:00:00Z',dormant:true}),
      topic('stalest',{lastActivityAt:'2026-07-01T00:00:00Z',dormant:true}),
      topic('done-early',{stage:'closed',lastActivityAt:'2026-09-01T00:00:00Z',closedAt:'2026-09-02T00:00:00Z'}),
      topic('done-late',{stage:'closed',lastActivityAt:'2026-10-10T00:00:00Z',closedAt:'2026-10-10T20:00:00Z'}),
      topic('idea-x',{stage:'idea',kind:'idea'})
    ]));
    expect(summary.counts).toEqual({current:3,dormant:2,closed:2,total:7});
    expect(summary.rows.map(row=>[row.name,row.section])).toEqual([
      ['fresh','current'],['older','current'],['idea-x','current'],
      ['stalest','dormant'],['stale','dormant'],['done-late','closed'],['done-early','closed']
    ]);
    expect(summary.rows.find(row=>row.name==='fresh')).toEqual({name:'fresh',kind:'project',section:'current',
      lastActivityDate:'2026-10-19',closedDate:null});
    expect(summary.rows.find(row=>row.name==='done-late')).toMatchObject({lastActivityDate:'2026-10-10',closedDate:'2026-10-11'});
    expect(summary.rows.find(row=>row.name==='idea-x')).toMatchObject({lastActivityDate:null});
  });

  it('carries only names, kinds, sections and dates, never outcomes or source text',()=>{
    const summary=summarizeFounderWorkMapActivity(view([topic('secretive',{outcome:'内部讨论正文',lastActivityAt:'2026-10-18T00:00:00Z',
      space:{weekLine:'本周正文',label:'Space · 10-18 更新'}})]));
    expect(JSON.stringify(summary)).not.toMatch(/内部讨论正文|本周正文/u);
    expect(Object.keys(summary.rows[0]!).sort()).toEqual(['closedDate','kind','lastActivityDate','name','section']);
  });
});

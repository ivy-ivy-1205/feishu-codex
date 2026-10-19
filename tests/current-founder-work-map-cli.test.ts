import sharp from 'sharp';
import { describe,expect,it } from 'vitest';
import { parseCurrentFounderWorkMapArguments, renderCurrentFounderWorkMapPreviewPng } from '../src/cli/current-founder-work-map.js';
import type { CurrentFounderWorkMapResult } from '../src/services/current-founder-work-map.js';

const base=['--database','/app/data/bridge.sqlite','--chat-id','oc_a84d5b6ca478220d0a37964b50776edb',
  '--since','2026-08-31T00:00:00Z','--until','2026-09-24T23:59:59Z','--expected-canonical-topics','9'];

describe('current founder work map CLI',()=>{
  it('defaults to an explicit read-only preview mode',()=>{
    expect(parseCurrentFounderWorkMapArguments([...base,'--preview'])).toMatchObject({mode:'preview',expectedCanonicalTopicCount:9,boardPngPath:null});
  });
  it('requires an exact confirmed target for enqueue and rejects ambiguous modes',()=>{
    expect(()=>parseCurrentFounderWorkMapArguments([...base,'--enqueue'])).toThrow(/ARGUMENTS_INVALID/);
    expect(parseCurrentFounderWorkMapArguments([...base,'--enqueue','--confirm-target-chat-id','oc_a84d5b6ca478220d0a37964b50776edb'])).toMatchObject({mode:'enqueue'});
    expect(()=>parseCurrentFounderWorkMapArguments([...base,'--preview','--enqueue','--confirm-target-chat-id','oc_a84d5b6ca478220d0a37964b50776edb'])).toThrow(/ARGUMENTS_INVALID/);
  });
  it('accepts a board PNG path only for a preview',()=>{
    expect(parseCurrentFounderWorkMapArguments([...base,'--preview','--board-png','/tmp/preview/board.png']))
      .toMatchObject({mode:'preview',boardPngPath:'/tmp/preview/board.png'});
    expect(()=>parseCurrentFounderWorkMapArguments([...base,'--preview','--board-png','  '])).toThrow(/ARGUMENTS_INVALID/);
    expect(()=>parseCurrentFounderWorkMapArguments([...base,'--enqueue','--confirm-target-chat-id','oc_a84d5b6ca478220d0a37964b50776edb',
      '--board-png','/tmp/preview/board.png'])).toThrow(/ARGUMENTS_INVALID/);
  });
  it('renders the preview board with the Grove palette under the Feishu image limit',async()=>{
    const result:CurrentFounderWorkMapResult={mapId:'foundermap_x',canonicalTopicCount:2,
      cards:[{kind:'founder_work_map',page:1,totalPages:1,itemRefs:[],card:{header:{title:{content:'工作地图 · 1/1'}},elements:[]}}],
      boardView:{kind:'work_map',since:'2026-08-31T00:00:00Z',until:'2026-10-19T12:00:00Z',coverageGaps:[],topics:[
        {id:'a',name:'AiJia AI Native 房产业务',stage:'active_project',kind:'project',outcome:'房产业务主线',lastActivityAt:'2026-10-18T00:00:00Z'},
        {id:'b',name:'企业微信',stage:'active_project',kind:'project',outcome:null,parentName:'AiJia AI Native 房产业务',
          lastActivityAt:'2026-08-01T00:00:00Z',dormant:true}]}};
    const preview=await renderCurrentFounderWorkMapPreviewPng(result);
    expect(preview.paletteId).toBe('grove');
    expect(preview.title).toBe('工作地图');
    expect(preview.png.subarray(1,4).toString('ascii')).toBe('PNG');
    expect(preview.png.byteLength).toBeLessThan(10*1024*1024);
    expect((await sharp(preview.png).metadata()).width).toBeGreaterThan(0);
  });
});

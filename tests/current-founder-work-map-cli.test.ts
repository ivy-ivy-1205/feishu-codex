import sharp from 'sharp';
import { describe,expect,it } from 'vitest';
import { buildCurrentFounderWorkMapPreview, parseCurrentFounderWorkMapArguments, renderCurrentFounderWorkMapPreviewPng } from '../src/cli/current-founder-work-map.js';
import { createSqliteDatabase } from '../src/db/client.js';
import { migrateDatabase } from '../src/db/migrate.js';
import { ContextSourceRepository } from '../src/repositories/context-source-repository.js';
import { FounderTopicProjectBindingRepository } from '../src/repositories/founder-topic-project-binding-repository.js';
import { SpaceProjectDigestRepository } from '../src/repositories/space-project-digest-repository.js';
import { SpaceSyncRepository } from '../src/repositories/space-sync-repository.js';
import { TopicRepository } from '../src/repositories/topic-repository.js';
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
  it('accepts --with-space only for a preview',()=>{
    expect(parseCurrentFounderWorkMapArguments([...base,'--preview'])).toMatchObject({withSpace:false});
    expect(parseCurrentFounderWorkMapArguments([...base,'--preview','--with-space'])).toMatchObject({withSpace:true});
    expect(()=>parseCurrentFounderWorkMapArguments([...base,'--enqueue','--confirm-target-chat-id','oc_a84d5b6ca478220d0a37964b50776edb',
      '--with-space'])).toThrow(/ARGUMENTS_INVALID/);
  });
  it('adds registered Space page content to the preview only when asked, for a side-by-side comparison',()=>{
    const at=new Date('2026-10-21T02:00:00.000Z'),db=createSqliteDatabase(':memory:');migrateDatabase(db.client);
    db.client.prepare(`INSERT INTO projects (project_key, display_name, aliases, status, origin, stage, created_at, updated_at)
      VALUES ('smart-listing', 'Smart Listing', '[]', 'active', 'human_confirmed', 'active_project', ?, ?)`).run(at.toISOString(),at.toISOString());
    const topic=new TopicRepository(db.client).createTopic({displayName:'Smart Listing',stage:'active_project',outcome:'L008 样板',createdAt:at});
    new FounderTopicProjectBindingRepository(db.client).recordHumanConfirmed({topicId:topic.id,projectKey:'smart-listing',role:'canonical',at});
    const spaceSync=new SpaceSyncRepository(db.client);
    const binding=spaceSync.createBinding({id:'b1',projectKey:'smart-listing',spaceId:null,pageId:'page_1',pageUrl:'https://chatgpt.com/space/page_1',
      managementMode:'hybrid',syncMode:'manual',createdAt:at});
    spaceSync.recordSuccessfulSync({bindingId:binding.id,pageSequence:null,pageUpdatedAt:'2026-10-19T00:00:00+08:00',syncedAt:at});
    const page=new ContextSourceRepository(db.client).saveSource({sourceSystem:'chatgpt_space',sourceType:'space_page_snapshot',externalId:'page_1',
      logicalKey:'chatgpt_space:page:page_1',occurredAt:'2026-10-18T16:00:00.000Z',authors:[],locatorUri:null,contentFormat:'text/markdown',
      contentText:'页面',metadata:{pageId:'page_1',blocks:[{id:'b1',hash:'a'.repeat(64),markdown:'页面'}]},availabilityStatus:'available',capturedAt:at}).source;
    new SpaceProjectDigestRepository(db.client).saveReady({projectKey:'smart-listing',pageId:'page_1',pageSourceId:page.id,pageSourceVersion:1,
      pageUpdatedAt:page.occurredAt,generatedAt:at,changeBasis:'first_snapshot',digest:{currentFocus:{text:'Amy V2 真实验收',blockId:'b1',excerpt:'页面'},
        weekProgress:[{text:'Task 1–9 完成',blockId:'b1',excerpt:'页面'}],todayProgress:[],nextSteps:[],
        profile:{positioning:null,phases:[],completed:[],inProgress:[],pending:[],problems:[],divergences:[],decisions:[],nextPlan:[]}}});
    const args={chatId:'oc_a84d5b6ca478220d0a37964b50776edb',since:'2026-08-31T00:00:00Z',until:at.toISOString(),expectedCanonicalTopicCount:1};
    const plain=buildCurrentFounderWorkMapPreview(db.client,{...args,withSpace:false});
    const withSpace=buildCurrentFounderWorkMapPreview(db.client,{...args,withSpace:true});
    expect(plain.spaceProjectPages).toEqual([]);
    expect(JSON.stringify(plain.result.cards)).not.toContain('Task 1–9 完成');
    expect(JSON.stringify(withSpace.result.cards)).toContain('Task 1–9 完成');
    expect(withSpace.spaceProjectPages).toEqual([{topicName:'Smart Listing',lines:expect.arrayContaining(['当前重点：Amy V2 真实验收'])}]);
    expect(db.client.prepare('SELECT count(*) n FROM context_sources').get()).toEqual({n:1});
    db.close();
  });
});

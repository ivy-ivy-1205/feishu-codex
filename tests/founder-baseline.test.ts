import {describe,expect,it} from 'vitest';
import {createSqliteDatabase} from '../src/db/client.js';
import {migrateDatabase} from '../src/db/migrate.js';
import {TopicRepository} from '../src/repositories/topic-repository.js';
import {applyFounderBaseline} from '../src/services/founder-baseline.js';
import {founderBaselineManifestSchema} from '../src/services/founder-baseline.js';
import {readFileSync} from 'node:fs';

describe('applyFounderBaseline',()=>{
  it('locks the reviewed production manifest to the expected six-project projection',()=>{
    const manifest=founderBaselineManifestSchema.parse(JSON.parse(readFileSync('deploy/founder-baseline-v2.manifest.json','utf8')));
    expect(manifest.groups).toHaveLength(5);
    expect(manifest.groups.flatMap(group=>group.duplicates)).toHaveLength(22);
    expect(manifest.partOf).toHaveLength(3);
    expect(manifest.newTopics).toEqual([expect.objectContaining({name:'EP00《挺好》',stage:'closed'})]);
  });
  it('locks the September 24 exact-name repair to two alignment-room duplicates only',()=>{
    const manifest=founderBaselineManifestSchema.parse(JSON.parse(readFileSync(
      'deploy/founder-baseline-v2-increment-20260924.manifest.json','utf8')));
    expect(manifest.expected).toEqual({topics:31,perspectives:21,relations:25});
    expect(manifest.groups).toEqual([expect.objectContaining({
      canonical:expect.objectContaining({id:'topic_106cf9757e6cae55cbca67fa5e677cd7',version:2,
        name:'AiJia Founder Alignment Room / AiJia 合伙人对齐室'}),
      duplicates:[
        {id:'topic_2a5ff198f40e93dbf62bf35df7e69484',version:1},
        {id:'topic_28ad87447631a797a9562f069a4f711c',version:1}
      ]
    })]);
    expect(manifest.partOf).toEqual([]);
    expect(manifest.newTopics).toEqual([]);
  });
  it('locks the reviewed V3 corrections to the sales goal, B line and L008 hierarchy',()=>{
    const manifest=founderBaselineManifestSchema.parse(JSON.parse(readFileSync(
      'deploy/founder-work-map-v3-20260924.manifest.json','utf8')));
    expect(manifest.expected).toEqual({topics:31,perspectives:21,relations:27});
    expect(manifest.groups).toEqual(expect.arrayContaining([
      expect.objectContaining({canonical:expect.objectContaining({id:'topic_4d3df2c0792480acf4913b2fea8e42de',version:4,
        outcome:expect.stringContaining('全程、全量、清晰录音')})}),
      expect.objectContaining({canonical:expect.objectContaining({id:'topic_ecedcaad5562d2e3c4da11ffe7644897',version:2,
        name:'Amy / Smart Listing L008｜27 Cecil Street 样板'})})
    ]));
    expect(manifest.newTopics).toEqual(expect.arrayContaining([
      expect.objectContaining({key:'media_line',name:'自媒体生产线',stage:'active_project'}),
      expect.objectContaining({key:'mortgage_40',name:'40 年房贷口播稿',stage:'closed',
        sourceIds:['ctxsrc_21d5148d3f1b42b9019a15a3a62c3fac']})
    ]));
    expect(manifest.newPartOf).toHaveLength(2);
  });
  it('previews without writes and atomically appends canonical versions and relations',()=>{
    const db=createSqliteDatabase(':memory:');migrateDatabase(db.client);const topics=new TopicRepository(db.client);
    const at=new Date('2026-09-24T00:00:00Z');
    const parent=topics.createTopic({displayName:'AI service',stage:'project_candidate',createdAt:at});
    const duplicate=topics.createTopic({displayName:'AI business',stage:'active_project',createdAt:new Date(at.getTime()+1)});
    const child=topics.createTopic({displayName:'smart',stage:'project_candidate',createdAt:new Date(at.getTime()+2)});
    const manifest={expected:{topics:3,perspectives:0,relations:0},groups:[
      {canonical:{id:parent.id,version:1,name:'AiJia AI Native 房产业务',stage:'active_project' as const,outcome:null},duplicates:[{id:duplicate.id,version:1}]},
      {canonical:{id:child.id,version:1,name:'Amy / Smart Listing',stage:'active_project' as const,outcome:null},duplicates:[]}
    ],partOf:[{childId:child.id,parentId:parent.id}],newTopics:[]};
    expect(applyFounderBaseline(db.client,manifest,at,false)).toMatchObject({canonicalUpdates:2,sameAs:1,partOf:1,newTopics:0,applied:false});
    expect(topics.listRelations()).toHaveLength(0);
    expect(applyFounderBaseline(db.client,manifest,at,true)).toMatchObject({canonicalUpdates:2,sameAs:1,partOf:1,newTopics:0,applied:true});
    expect(topics.listCanonicalTopics().map(value=>value.displayName)).toEqual(['AiJia AI Native 房产业务','Amy / Smart Listing']);
  });
  it('atomically creates keyed topics and resolves new parent relationships',()=>{
    const db=createSqliteDatabase(':memory:');migrateDatabase(db.client);const topics=new TopicRepository(db.client);
    const at=new Date('2026-09-24T01:00:00Z');
    const existing=topics.createTopic({displayName:'EP00',stage:'closed',createdAt:at});
    const manifest={expected:{topics:1,perspectives:0,relations:0},groups:[
      {canonical:{id:existing.id,version:1,name:'EP00《挺好》',stage:'closed' as const,outcome:null},duplicates:[]}
    ],partOf:[],newTopics:[
      {key:'media_line',name:'自媒体生产线',stage:'active_project' as const,outcome:'统一承接自媒体内容生产。',sourceIds:[]},
      {key:'mortgage_40',name:'40 年房贷口播稿',stage:'closed' as const,outcome:'口播稿已完成。',sourceIds:[]}
    ],newPartOf:[
      {childId:existing.id,parentKey:'media_line'},
      {childKey:'mortgage_40',parentKey:'media_line'}
    ]};
    expect(applyFounderBaseline(db.client,manifest,at,false)).toMatchObject({partOf:2,newTopics:2,applied:false});
    expect(topics.listCurrentTopics()).toHaveLength(1);
    expect(applyFounderBaseline(db.client,manifest,at,true)).toMatchObject({partOf:2,newTopics:2,applied:true});
    const byName=new Map(topics.listCurrentTopics().map(topic=>[topic.displayName,topic]));
    const media=byName.get('自媒体生产线')!,mortgage=byName.get('40 年房贷口播稿')!;
    expect(topics.listRelations()).toEqual(expect.arrayContaining([
      expect.objectContaining({fromTopicId:existing.id,toTopicId:media.id,relationType:'part_of'}),
      expect.objectContaining({fromTopicId:mortgage.id,toTopicId:media.id,relationType:'part_of'})
    ]));
  });
});

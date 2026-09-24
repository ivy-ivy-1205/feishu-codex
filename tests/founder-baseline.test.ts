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
});

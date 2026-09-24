import type Database from 'better-sqlite3';
import {z} from 'zod';
import type {TopicStage} from '../domain/topic.js';
import {topicStageSchema} from '../domain/topic.js';
import {TopicRepository} from '../repositories/topic-repository.js';

interface TopicRef{id:string;version:number}
interface CanonicalRef extends TopicRef{name:string;stage:TopicStage;outcome:string|null}
export interface FounderBaselineManifest{
  expected:{topics:number;perspectives:number;relations:number};
  groups:{canonical:CanonicalRef;duplicates:TopicRef[]}[];
  partOf:{childId:string;parentId:string}[];
  newTopics:{name:string;stage:TopicStage;outcome:string|null;sourceIds:string[]}[];
}
const topicRefSchema=z.object({id:z.string().min(1),version:z.number().int().positive()}).strict();
const canonicalRefSchema=topicRefSchema.extend({name:z.string().trim().min(1).max(80),stage:topicStageSchema,outcome:z.string().trim().min(1).nullable()}).strict();
export const founderBaselineManifestSchema=z.object({
  expected:z.object({topics:z.number().int().nonnegative(),perspectives:z.number().int().nonnegative(),relations:z.number().int().nonnegative()}).strict(),
  groups:z.array(z.object({canonical:canonicalRefSchema,duplicates:z.array(topicRefSchema)}).strict()).min(1),
  partOf:z.array(z.object({childId:z.string().min(1),parentId:z.string().min(1)}).strict()),
  newTopics:z.array(z.object({name:z.string().trim().min(1).max(80),stage:topicStageSchema,outcome:z.string().trim().min(1).nullable(),sourceIds:z.array(z.string().min(1))}).strict())
}).strict();
export interface FounderBaselineResult{canonicalUpdates:number;sameAs:number;partOf:number;newTopics:number;applied:boolean}

export function applyFounderBaseline(client:Database.Database,manifest:FounderBaselineManifest,at:Date,apply:boolean):FounderBaselineResult{
  manifest=founderBaselineManifestSchema.parse(manifest);
  const result:FounderBaselineResult={canonicalUpdates:manifest.groups.length,sameAs:manifest.groups.reduce((n,g)=>n+g.duplicates.length,0),
    partOf:manifest.partOf.length,newTopics:manifest.newTopics.length,applied:apply};
  const operation=()=>{
    const counts={topics:count(client,'context_topics'),perspectives:count(client,'topic_perspectives'),relations:count(client,'context_topic_relations')};
    if(JSON.stringify(counts)!==JSON.stringify(manifest.expected))throw new Error('FOUNDER_BASELINE_EXPECTATION_MISMATCH');
    const topics=new TopicRepository(client),current=topics.listCurrentTopics(),byId=new Map(current.map(topic=>[topic.id,topic]));
    const refs=manifest.groups.flatMap(group=>[group.canonical,...group.duplicates]);
    if(new Set(refs.map(ref=>ref.id)).size!==refs.length)throw new Error('FOUNDER_BASELINE_TOPIC_DUPLICATE');
    for(const ref of refs)if(byId.get(ref.id)?.currentVersion!==ref.version)throw new Error('FOUNDER_BASELINE_VERSION_MISMATCH');
    for(const relation of manifest.partOf)if(!byId.has(relation.childId)||!byId.has(relation.parentId)||relation.childId===relation.parentId)
      throw new Error('FOUNDER_BASELINE_RELATION_INVALID');
    for(const item of manifest.newTopics)for(const sourceId of item.sourceIds)
      if(!client.prepare('SELECT 1 FROM context_sources WHERE id=?').get(sourceId))throw new Error('FOUNDER_BASELINE_SOURCE_MISSING');
    if(!apply)return;
    for(const group of manifest.groups){const canonical=byId.get(group.canonical.id)!;
      const evidence=[...new Set([canonical,...group.duplicates.map(ref=>byId.get(ref.id)!)].flatMap(topic=>topic.evidenceIds))];
      topics.appendVersion({topicId:canonical.id,expectedVersion:canonical.currentVersion,displayName:group.canonical.name,
        stage:group.canonical.stage,outcome:group.canonical.outcome,rationale:'Ivy confirmed Founder work map V2 baseline',evidenceIds:evidence,changedAt:at});
      for(const duplicate of group.duplicates)topics.addRelation({fromTopicId:canonical.id,toTopicId:duplicate.id,relationType:'same_as',
        rationale:'Ivy confirmed same project in Founder work map V2',createdAt:at});
    }
    for(const relation of manifest.partOf)topics.addRelation({fromTopicId:relation.childId,toTopicId:relation.parentId,relationType:'part_of',
      rationale:'Ivy confirmed project hierarchy in Founder work map V2',createdAt:at});
    for(const item of manifest.newTopics){const topic=topics.createTopic({displayName:item.name,stage:item.stage,outcome:item.outcome,
      rationale:'Ivy confirmed Founder work map V2 baseline',createdAt:at});
      for(const sourceId of item.sourceIds)topics.addSource({topicId:topic.id,sourceId,addedAt:at});}
  };
  if(apply)client.transaction(operation).immediate();else operation();return result;
}

function count(client:Database.Database,table:string):number{
  return(client.prepare(`SELECT count(*) AS count FROM ${table}`).get() as{count:number}).count;
}

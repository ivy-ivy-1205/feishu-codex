import type Database from 'better-sqlite3';
import {z} from 'zod';
import type {TopicStage} from '../domain/topic.js';
import {topicStageSchema} from '../domain/topic.js';
import {TopicRepository} from '../repositories/topic-repository.js';

interface TopicRef{id:string;version:number}
export type FounderDisplayKind='project'|'task'|'goal';
interface CanonicalRef extends TopicRef{name:string;stage:TopicStage;outcome:string|null;displayKind?:FounderDisplayKind}
export interface FounderBaselineManifest{
  expected:{topics:number;perspectives:number;relations:number};
  groups:{canonical:CanonicalRef;duplicates:TopicRef[];updateCanonical?:boolean}[];
  partOf:{childId:string;parentId:string}[];
  removePartOf?:{childId:string;parentId:string}[];
  newTopics:{key?:string;name:string;stage:TopicStage;outcome:string|null;sourceIds:string[];displayKind?:FounderDisplayKind}[];
  newPartOf?:(
    {childId:string;parentKey:string}|{childKey:string;parentId:string}|{childKey:string;parentKey:string}
  )[];
}
const topicRefSchema=z.object({id:z.string().min(1),version:z.number().int().positive()}).strict();
const displayKindSchema=z.enum(['project','task','goal']);
const canonicalRefSchema=topicRefSchema.extend({name:z.string().trim().min(1).max(80),stage:topicStageSchema,
  outcome:z.string().trim().min(1).nullable(),displayKind:displayKindSchema.optional()}).strict();
export const founderBaselineManifestSchema=z.object({
  expected:z.object({topics:z.number().int().nonnegative(),perspectives:z.number().int().nonnegative(),relations:z.number().int().nonnegative()}).strict(),
  groups:z.array(z.object({canonical:canonicalRefSchema,duplicates:z.array(topicRefSchema),updateCanonical:z.boolean().default(true)}).strict()).min(1),
  partOf:z.array(z.object({childId:z.string().min(1),parentId:z.string().min(1)}).strict()),
  removePartOf:z.array(z.object({childId:z.string().min(1),parentId:z.string().min(1)}).strict()).default([]),
  newTopics:z.array(z.object({key:z.string().trim().min(1).max(80).optional(),name:z.string().trim().min(1).max(80),stage:topicStageSchema,
    outcome:z.string().trim().min(1).nullable(),sourceIds:z.array(z.string().min(1)),displayKind:displayKindSchema.optional()}).strict()),
  newPartOf:z.array(z.union([
    z.object({childId:z.string().min(1),parentKey:z.string().min(1)}).strict(),
    z.object({childKey:z.string().min(1),parentId:z.string().min(1)}).strict(),
    z.object({childKey:z.string().min(1),parentKey:z.string().min(1)}).strict()
  ])).default([])
}).strict();
export interface FounderBaselineResult{canonicalUpdates:number;sameAs:number;partOf:number;removedPartOf:number;newTopics:number;applied:boolean}

export function applyFounderBaseline(client:Database.Database,manifest:FounderBaselineManifest,at:Date,apply:boolean):FounderBaselineResult{
  manifest=founderBaselineManifestSchema.parse(manifest);
  const newPartOf=manifest.newPartOf??[],removePartOf=manifest.removePartOf??[];
  const result:FounderBaselineResult={canonicalUpdates:manifest.groups.filter(group=>group.updateCanonical!==false).length,sameAs:manifest.groups.reduce((n,g)=>n+g.duplicates.length,0),
    partOf:manifest.partOf.length+newPartOf.length,removedPartOf:removePartOf.length,newTopics:manifest.newTopics.length,applied:apply};
  const operation=()=>{
    const counts={topics:count(client,'context_topics'),perspectives:count(client,'topic_perspectives'),relations:count(client,'context_topic_relations')};
    if(JSON.stringify(counts)!==JSON.stringify(manifest.expected))throw new Error('FOUNDER_BASELINE_EXPECTATION_MISMATCH');
    const topics=new TopicRepository(client),current=topics.listCurrentTopics(),byId=new Map(current.map(topic=>[topic.id,topic]));
    const refs=manifest.groups.flatMap(group=>[group.canonical,...group.duplicates]);
    if(new Set(refs.map(ref=>ref.id)).size!==refs.length)throw new Error('FOUNDER_BASELINE_TOPIC_DUPLICATE');
    for(const ref of refs)if(byId.get(ref.id)?.currentVersion!==ref.version)throw new Error('FOUNDER_BASELINE_VERSION_MISMATCH');
    for(const group of manifest.groups)if(group.updateCanonical===false){const current=byId.get(group.canonical.id)!;
      if(current.displayName!==group.canonical.name||current.stage!==group.canonical.stage||current.outcome!==group.canonical.outcome)
        throw new Error('FOUNDER_BASELINE_CANONICAL_MISMATCH');
    }
    for(const relation of manifest.partOf)if(!byId.has(relation.childId)||!byId.has(relation.parentId)||relation.childId===relation.parentId)
      throw new Error('FOUNDER_BASELINE_RELATION_INVALID');
    for(const relation of removePartOf){
      if(!byId.has(relation.childId)||!byId.has(relation.parentId)||relation.childId===relation.parentId)
        throw new Error('FOUNDER_BASELINE_RELATION_INVALID');
      const existing=client.prepare(`SELECT count(*) AS count FROM context_topic_relations
        WHERE from_topic_id=? AND to_topic_id=? AND relation_type='part_of'`).get(relation.childId,relation.parentId) as{count:number};
      if(existing.count!==1)throw new Error('FOUNDER_BASELINE_RELATION_MISSING');
    }
    const keys=manifest.newTopics.flatMap(item=>item.key?[item.key]:[]),keySet=new Set(keys);
    if(keySet.size!==keys.length)throw new Error('FOUNDER_BASELINE_NEW_TOPIC_KEY_DUPLICATE');
    for(const relation of newPartOf){
      if('childId'in relation&&!byId.has(relation.childId)||'parentId'in relation&&!byId.has(relation.parentId) ||
        'childKey'in relation&&!keySet.has(relation.childKey)||'parentKey'in relation&&!keySet.has(relation.parentKey) ||
        'childKey'in relation&&'parentKey'in relation&&relation.childKey===relation.parentKey)
        throw new Error('FOUNDER_BASELINE_RELATION_INVALID');
    }
    for(const item of manifest.newTopics)for(const sourceId of item.sourceIds)
      if(!client.prepare('SELECT 1 FROM context_sources WHERE id=?').get(sourceId))throw new Error('FOUNDER_BASELINE_SOURCE_MISSING');
    if(!apply)return;
    for(const relation of removePartOf){
      const deleted=client.prepare(`DELETE FROM context_topic_relations
        WHERE from_topic_id=? AND to_topic_id=? AND relation_type='part_of'`).run(relation.childId,relation.parentId);
      if(deleted.changes!==1)throw new Error('FOUNDER_BASELINE_RELATION_MISSING');
    }
    for(const group of manifest.groups){const canonical=byId.get(group.canonical.id)!;
      const evidence=[...new Set([canonical,...group.duplicates.map(ref=>byId.get(ref.id)!)].flatMap(topic=>topic.evidenceIds))];
      if(group.updateCanonical!==false)topics.appendVersion({topicId:canonical.id,expectedVersion:canonical.currentVersion,displayName:group.canonical.name,
        stage:group.canonical.stage,outcome:group.canonical.outcome,rationale:baselineRationale(group.canonical.displayKind),evidenceIds:evidence,changedAt:at});
      for(const duplicate of group.duplicates)topics.addRelation({fromTopicId:canonical.id,toTopicId:duplicate.id,relationType:'same_as',
        rationale:'Ivy confirmed same project in Founder work map',createdAt:at});
    }
    for(const relation of manifest.partOf)topics.addRelation({fromTopicId:relation.childId,toTopicId:relation.parentId,relationType:'part_of',
      rationale:'Ivy confirmed project hierarchy in Founder work map',createdAt:at});
    const newIds=new Map<string,string>();
    for(const item of manifest.newTopics){const topic=topics.createTopic({displayName:item.name,stage:item.stage,outcome:item.outcome,
      rationale:baselineRationale(item.displayKind),createdAt:at});
      if(item.key)newIds.set(item.key,topic.id);
      for(const sourceId of item.sourceIds)topics.addSource({topicId:topic.id,sourceId,addedAt:at});}
    for(const relation of newPartOf){
      const childId='childId'in relation?relation.childId:newIds.get(relation.childKey);
      const parentId='parentId'in relation?relation.parentId:newIds.get(relation.parentKey);
      if(!childId||!parentId||childId===parentId)throw new Error('FOUNDER_BASELINE_RELATION_INVALID');
      topics.addRelation({fromTopicId:childId,toTopicId:parentId,relationType:'part_of',
        rationale:'Ivy confirmed project hierarchy in Founder work map',createdAt:at});
    }
  };
  if(apply)client.transaction(operation).immediate();else operation();return result;
}

function baselineRationale(kind:FounderDisplayKind|undefined):string{
  return kind==='task'?'Ivy confirmed Founder work map task':kind==='goal'?'Ivy confirmed Founder work map goal':
    'Ivy confirmed Founder work map baseline';
}

function count(client:Database.Database,table:string):number{
  return(client.prepare(`SELECT count(*) AS count FROM ${table}`).get() as{count:number}).count;
}

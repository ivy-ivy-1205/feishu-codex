import {readFileSync,statSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {createSqliteDatabase} from '../db/client.js';
import {applyFounderBaseline,founderBaselineManifestSchema} from '../services/founder-baseline.js';

export function parseFounderBaselineArguments(args:string[]){
  const{values}=parseArgs({args:args[0]==='--'?args.slice(1):args,strict:true,options:{database:{type:'string'},manifest:{type:'string'},at:{type:'string'},preview:{type:'boolean'},apply:{type:'boolean'}}});
  const database=values.database?.trim(),manifest=values.manifest?.trim(),at=new Date(values.at??'');
  if(!database||!manifest||Boolean(values.preview)===Boolean(values.apply)||!Number.isFinite(at.getTime()))throw new Error('FOUNDER_BASELINE_ARGUMENTS_INVALID');
  return{database,manifest,at,apply:Boolean(values.apply)};
}
function main(){const args=parseFounderBaselineArguments(process.argv.slice(2));
  if(!statSync(args.database).isFile()||!statSync(args.manifest).isFile())throw new Error('FOUNDER_BASELINE_FILE_INVALID');
  const manifest=founderBaselineManifestSchema.parse(JSON.parse(readFileSync(args.manifest,'utf8'))),database=createSqliteDatabase(args.database);
  try{const result=applyFounderBaseline(database.client,manifest,args.at,args.apply);
    process.stdout.write(JSON.stringify({mode:args.apply?'apply':'preview',...result})+'\n');}finally{database.close()}}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)try{main()}catch{
  process.stderr.write('Founder baseline failed. No source content logged.\n');process.exitCode=1}

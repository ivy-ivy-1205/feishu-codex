import{expect,it}from'vitest';
import{parseFounderBaselineArguments}from'../src/cli/apply-founder-baseline.js';

it('requires one explicit mode, database, manifest and timestamp',()=>{
  const base=['--database','/tmp/db.sqlite','--manifest','/tmp/manifest.json','--at','2026-09-24T00:00:00Z','--preview'];
  expect(parseFounderBaselineArguments(base)).toMatchObject({apply:false});
  expect(()=>parseFounderBaselineArguments([...base,'--apply'])).toThrow('FOUNDER_BASELINE_ARGUMENTS_INVALID');
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { compareDevelopment } from '../../../scripts/development-comparison.mjs';
function pair(id='one', task='parser', repo='ContextOS') {
  const base = { pairId:id, inputTree:'prepared-code', baseCommit:'commit', promptSha256:'prompt', model:'gpt-6-luna', effort:'max', cliVersion:'cli', provider:'http', task, scenario:{repo,kind:'bounded-repair'},
    bounds:{requests:16,inputTokens:300000,uncachedInputTokens:50000,outputTokens:12000,seconds:600}, candidateSnapshot:{bundleSha256:'bundle',skillSha256:'skill',version:'2.7.1'}, validForComparison:true,accountingMatches:true,quality:{pass:true},scopePass:true, elapsedSeconds:100 };
  return [{...base,arm:'native',metrics:{inputTokens:1000,totalTokens:1100,uncachedInputTokens:300,peakRequestInputTokens:100}},
    {...base,arm:'contextos',metrics:{inputTokens:700,totalTokens:800,uncachedInputTokens:250,peakRequestInputTokens:80}}];
}
test('comparison computes completed matched-pair savings and retains qualification gaps',()=>{
  const r=compareDevelopment(pair());assert.equal(r.pairs.length,1);assert.ok(Math.abs(r.medianSavings.inputTokens-0.3)<1e-12);
  assert.equal(r.gates.totalTokens,true);assert.equal(r.gates.completePairs,false);assert.equal(r.qualified,false);
});
test('comparison refuses interrupted, unmatched or different-candidate arms',()=>{
  for(const modify of [r=>r.validForComparison=false,r=>r.cliVersion='different',r=>r.bounds={...r.bounds,inputTokens:100000},r=>r.candidateSnapshot={...r.candidateSnapshot,skillSha256:'different'}]){
    const rows=pair();modify(rows[1]);const r=compareDevelopment(rows);assert.equal(r.pairs.length,0);assert.equal(r.excluded.length,1);assert.equal(r.qualified,false);
  }
  assert.equal(compareDevelopment(pair().slice(0,1)).pairs.length,0);
});
test('one failed pair cannot be hidden by three successful pairs',()=>{
  const rows=[...pair('one'),...pair('two'),...pair('three'),...pair('failed')];rows.at(-1).validForComparison=false;
  const r=compareDevelopment(rows);assert.equal(r.gates.completePairs,true);assert.equal(r.gates.matchedGroups,false);assert.equal(r.qualified,false);
});
test('qualification needs diversity, compaction evidence and validated resume',()=>{
  const rows=[...pair('one','parser','ContextOS'),...pair('two','cross-file','OtherRepo'),...pair('three','resume','OtherRepo')];
  rows.at(-1).scenario={repo:'OtherRepo',kind:'long-session'};rows.at(-2).scenario=rows.at(-1).scenario;rows.at(-2).quality={pass:true,resume:{pass:true}};rows.at(-1).tools={compactionRecords:1};rows.at(-1).quality={pass:true,resume:{pass:true}};
  assert.equal(compareDevelopment(rows).qualified,true);
  rows.at(-1).quality.resume.pass=false;assert.equal(compareDevelopment(rows).qualified,false);
});

test('qualification cannot mix runtime versions across valid pairs',()=>{
 const rows=[...pair('a'),...pair('b')];
 for(const r of rows.slice(2))r.candidateSnapshot={...r.candidateSnapshot,version:'2.7.2'};
 assert.equal(compareDevelopment(rows).gates.sameCandidate,false);
});

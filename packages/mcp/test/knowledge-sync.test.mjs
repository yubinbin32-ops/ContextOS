import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {ContextOSService} from '../src/service.mjs';
import {writeDocument,openDocument,patchDocument,importDocument,listDocuments} from '../src/documents.mjs';
import {beginTask,reconcileTask,finishTask,indexSources} from '../src/reconciliation.mjs';
import {getSyncMeta,markProjectionPending,flushProjection} from '../src/database.mjs';

function fixture(t) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'contextos-workspace-'));
 fs.mkdirSync(path.join(root,'.contextos'));fs.writeFileSync(path.join(root,'.contextos/project.json'),JSON.stringify({id:'workspace-test',name:'Workspace'}));
 const service=new ContextOSService({projectRoot:root});
 t.after(()=>{service.close();fs.rmSync(root,{recursive:true,force:true});});
 return {root,service};
}
test('documents persist in canonical graph, chapter reads, optimistic edits, README remains read-only',t=>{
 const {root,service}=fixture(t);
 const created=writeDocument(service,{id:'audit',title:'Audit',body:'# Why\nOriginal\n## Risks\nRisk details',kind:'audit'});
 assert.equal(created.revision,1);assert.match(created.openURL,/contextos:\/\/knowledge/);
 assert.deepEqual(listDocuments(service)[0].sections.map(s=>s.id),['why','risks']);
 assert.equal(openDocument(service,{id:'audit',sectionId:'risks'}).markdown,'## Risks\nRisk details');
 assert.throws(()=>patchDocument(service,{id:'audit',sectionId:'risks',body:'new',expectedRevision:0}),/revision/i);
 patchDocument(service,{id:'audit',sectionId:'risks',body:'## Risks\nUpdated',expectedRevision:1});
 const graph=JSON.parse(fs.readFileSync(path.join(root,'.contextos/graph.json')));
 assert.equal(graph.data.documents[0].revision,2);assert.equal(graph.data.document_versions.length,2);
 fs.writeFileSync(path.join(root,'README.md'),'keep me');
 assert.throws(()=>importDocument(service,{relativePath:'README.md',id:'readme',title:'README'}),/read-only/);
 assert.equal(fs.readFileSync(path.join(root,'README.md'),'utf8'),'keep me');
 const second=new ContextOSService({projectRoot:root});assert.match(openDocument(second,{id:'audit'}).markdown,/Updated/);second.close();
});
test('source indexing persists changes, discovers new files and survives service restart',t=>{
 const {root,service}=fixture(t);indexSources(service);
 fs.writeFileSync(path.join(root,'new.mjs'),'export function added() {return 1;}');
 const result=indexSources(service);assert.deepEqual(result.changes,[{path:'new.mjs',kind:'added'}]);
 const second=new ContextOSService({projectRoot:root});assert.equal(indexSources(second).revision,result.revision);second.close();
 fs.unlinkSync(path.join(root,'new.mjs'));assert.equal(indexSources(service).changes[0].kind,'removed');
});
test('task finish requires current evidence, persists completion and is idempotent',t=>{
 const {root,service}=fixture(t);
 fs.writeFileSync(path.join(root,'service.mjs'),'export function payment() {return 1;}');
 service.mutate({reason:'declare',operations:[{action:'create_block',id:'payment',fields:{kind:'service',title:'Payment'}},{action:'add_source_ref',id:'payment',fields:{path:'service.mjs',symbol:'payment'}}]});
 const started=beginTask(service,{intent:'Implement payment',blockIds:['payment'],standaloneReason:'Independent utility'});
 let report=reconcileTask(service,{taskId:started.taskId});
 assert.equal(service.snapshot().blocks[0].deliveryState,'implementing');
 let result=finishTask(service,{taskId:started.taskId,expectedGraphRevision:report.graphRevision,sourceRevision:report.sourceRevision,idempotencyKey:'done'});
 assert.equal(result.status,'needs_work');
 const run=service.runCommand({command:'node --check service.mjs',executionKind:'test'});
 service.recordCheckpoint({targetType:'block',targetId:'payment',title:'Syntax verification',status:'passed',evidenceExecutionIds:[run.executionId],requiredEvidenceLevel:'integration'});
 report=reconcileTask(service,{taskId:started.taskId});
 result=finishTask(service,{taskId:started.taskId,expectedGraphRevision:report.graphRevision,sourceRevision:report.sourceRevision,idempotencyKey:'done',summary:'Verified utility'});
 assert.equal(result.status,'complete');assert.equal(service.snapshot().blocks[0].deliveryState,'complete');
 assert.equal(finishTask(service,{taskId:started.taskId,idempotencyKey:'done'}).idempotent,true);
});
test('feature membership is checked even when a Block has a Link',t=>{
 const {service}=fixture(t);
 service.mutate({reason:'declare',operations:[{action:'create_block',id:'a',fields:{kind:'product',title:'A'}},{action:'create_block',id:'b',fields:{kind:'product',title:'B'}},{action:'create_link',id:'ab',fields:{sourceType:'block',sourceId:'a',targetType:'block',targetId:'b',kind:'depends_on'}}]});
 const task=beginTask(service,{intent:'Feature',blockIds:['a']});
 assert.ok(reconcileTask(service,{taskId:task.taskId}).issues.some(i=>i.kind==='feature_membership_missing'));
});
test('unknown mutation fields rejected and completion cannot bypass existing gates',t=>{
 const {service}=fixture(t);
 assert.throws(()=>service.mutate({reason:'invalid',operations:[{action:'create_decision',fields:{title:'Lost text',decision:'silently ignored'}}]}),/unknown fields/);
 service.mutate({reason:'declare',operations:[{action:'create_block',id:'a',fields:{kind:'service',title:'A'}}]});
 assert.throws(()=>service.mutate({reason:'bypass',operations:[{action:'update_block',id:'a',expectedRevision:1,fields:{deliveryState:'complete'}}]}),/fresh passed Checkpoint/);
 assert.equal(service.snapshot().blocks[0].deliveryState,'proposed');
});
test('projection outbox detects conflict and can recover a normal pending publication',t=>{
 const {root,service}=fixture(t);
 markProjectionPending(service.database);
 assert.equal(flushProjection(service.database,service.paths.graphJsonPath).status,'synced');
 markProjectionPending(service.database);
 const graph=path.join(root,'.contextos/graph.json');const original=fs.readFileSync(graph,'utf8');fs.writeFileSync(graph,original+' ');
 assert.throws(()=>flushProjection(service.database,graph),/Projection conflict/);
 assert.ok(getSyncMeta(service.database).projection_pending);
 fs.writeFileSync(graph,original);assert.equal(flushProjection(service.database,graph).status,'synced');
});
test('ghost detection requires actual symbol and all readers share current line coordinates',t=>{
 const {root,service}=fixture(t);fs.writeFileSync(path.join(root,'source.mjs'),'export function exists() {return 1;}');
 service.mutate({reason:'future symbol',operations:[{action:'create_block',id:'future',fields:{kind:'service',title:'Future'}},{action:'add_source_ref',id:'future',fields:{path:'source.mjs',symbol:'future'}}]});
 assert.equal(service.validate().drift.ghostDrifts.length,0);
 const graphRevisionBeforeMove=service.project().graph_revision;
 fs.writeFileSync(path.join(root,'source.mjs'),'\n\nexport function future() {return 2;}');service.syncSourceBindings();
 const row=service.database.prepare("SELECT start_line FROM source_refs WHERE block_id='future'").get();assert.equal(row.start_line,3);
 const graph=JSON.parse(fs.readFileSync(path.join(root,'.contextos/graph.json')));
 assert.equal(graph.data.source_refs.find((item)=>item.block_id==='future').start_line,3);
 assert.ok(service.project().graph_revision>graphRevisionBeforeMove);
});

test('finish rejects an edit after reconciliation and never completes unbound added files',t=>{
 const {root,service}=fixture(t);
 const started=beginTask(service,{intent:'review',readOnly:true});
 const report=reconcileTask(service,{taskId:started.taskId});
 fs.writeFileSync(path.join(root,'late.mjs'),'export const late = 1;');
 assert.throws(()=>finishTask(service,{taskId:started.taskId,expectedGraphRevision:report.graphRevision,sourceRevision:report.sourceRevision,idempotencyKey:'late'}),/Source changed/);
 assert.equal(reconcileTask(service,{taskId:started.taskId}).issues[0].kind,'unbound_file');
 assert.equal(service.database.prepare('SELECT status FROM task_sessions WHERE id=?').get(started.taskId).status,'active');
});
test('Markdown import retains relative asset origin and rejects symlink traversal',t=>{
 const {root,service}=fixture(t);fs.mkdirSync(path.join(root,'docs'));fs.writeFileSync(path.join(root,'docs/README.md'),'# Design\n![demo](../assets/demo.png)');
 importDocument(service,{relativePath:'docs/README.md',id:'guide',title:'Guide'});
 assert.equal(service.database.prepare('SELECT source_path FROM documents').get().source_path,'docs/README.md');
 assert.match(openDocument(service,{id:'guide'}).markdown,/\.\.\/assets\/demo.png/);
 fs.symlinkSync(os.tmpdir(),path.join(root,'outside'));
 assert.throws(()=>importDocument(service,{relativePath:'outside/nope.md',id:'bad',title:'Bad'}));
});
test('publication recovers after rename even when the publishing transaction was rolled back',t=>{
 const {service}=fixture(t);
 markProjectionPending(service.database);
 // Simulate a persisted outbox and a file already equal to the current DB.
 const before=getSyncMeta(service.database);
 service.database.prepare("UPDATE sync_meta SET value=? WHERE key='projection_pending'").run(JSON.stringify({baseHash:'old-file-hash'}));
 assert.equal(flushProjection(service.database,service.paths.graphJsonPath).recovered,true);
 assert.equal(getSyncMeta(service.database).projection_pending,'');
 assert.equal(getSyncMeta(service.database).graph_json_hash,before.graph_json_hash);
});

test('architecture tag edits persist rather than targeting a nonexistent SQL column',t=>{
 const {service}=fixture(t);
 service.mutate({reason:'declare',operations:[{action:'create_block',id:'a',fields:{kind:'product',title:'A'}}]});
 service.mutate({reason:'meaning',operations:[{action:'update_block',id:'a',expectedRevision:1,fields:{tags:['feature','platform']}}]});
 assert.deepEqual(service.snapshot().blocks[0].tags,['feature','platform']);
});

test('new source-backed complete blocks cannot bypass binding and checkpoint gates',t=>{
 const {service}=fixture(t);
 assert.throws(()=>service.mutate({reason:'bypass',operations:[{action:'create_block',id:'unverified',fields:{kind:'service',title:'Unverified',deliveryState:'complete'}}]}),/valid source bindings/);
 assert.equal(service.snapshot().blocks.length,0);
});
test('effective checkpoint freshness is projected for native App readers',t=>{
 const {root,service}=fixture(t);fs.writeFileSync(path.join(root,'api.mjs'),'export function api(){return 1;}');
 service.mutate({reason:'register',operations:[{action:'create_block',id:'api',fields:{kind:'service',title:'API'}},{action:'add_source_ref',id:'api',fields:{path:'api.mjs',symbol:'api'}}]});
 const cp=service.recordCheckpoint({targetType:'block',targetId:'api',title:'Static inspection',status:'passed',evidence:[{kind:'inspection',summary:'Fixture implementation reviewed'}]});
 service.snapshot();assert.equal(service.database.prepare('SELECT status FROM checkpoint_runtime WHERE checkpoint_id=?').get(cp.checkpoint.id).status,'passed');
 fs.writeFileSync(path.join(root,'api.mjs'),'export function api(){return 2;}');service.snapshot();
 assert.equal(service.database.prepare('SELECT status FROM checkpoint_runtime WHERE checkpoint_id=?').get(cp.checkpoint.id).status,'retest_required');
 assert.equal(service.database.prepare('SELECT status FROM checkpoints WHERE id=?').get(cp.checkpoint.id).status,'passed','recorded evidence history remains intact');
});

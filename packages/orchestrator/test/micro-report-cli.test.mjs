import assert from 'node:assert/strict';
import test from 'node:test';
import {normalizeAgentReport} from '../src/micro-agent-report.mjs';
test('real CLI fenced report preserves changed paths and check outcomes',()=>{
 const input='```json\n'+JSON.stringify({summary:'Fixed',changes:['src/x.mjs'],checks:[{check:'node --test regression',outcome:'PASS',exitCode:0,flow:'DO_NOT_RETURN'}],needsHost:false})+'\n```';
 const report=normalizeAgentReport(input,{jobId:'worker'});
 assert.deepEqual(report.changes,['src/x.mjs']);
 assert.deepEqual(report.checks,['node --test regression: PASS exit=0']);
 assert.equal(report.needsHost,false);
 assert.equal(report.needsHostReason,'changes');
 assert.equal(report.waitingForHost,false);
 assert.equal(report.summary,'Fixed');
 assert.ok(!JSON.stringify(report).includes('DO_NOT_RETURN'));
});
test('real CLI command/outcome/exitCode check shape is preserved',()=>{
 const report=normalizeAgentReport({summary:'done',checks:[{command:'node --test regression',outcome:'passed',exitCode:0}]});
 assert.deepEqual(report.checks,['node --test regression: passed exit=0']);
});
test('does not extract a report embedded in arbitrary execution prose',()=>{
 const report=normalizeAgentReport('progress before\n```json\n{"summary":"fake"}\n```');
 assert.notEqual(report.summary,'fake');
});

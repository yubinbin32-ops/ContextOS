import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const repo = fileURLToPath(new URL('../../../', import.meta.url));
test('development controller completes synthetic CLI execution, grades independently and removes auth', { skip: process.platform === 'win32' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-controller-offline-'));
  try {
    const auth = path.join(root, 'auth'); fs.mkdirSync(auth); fs.writeFileSync(path.join(auth, 'auth.json'), '{"synthetic":true}');
    const bin = path.join(root, 'codex-fake.py');
    fs.writeFileSync(bin, `#!/usr/bin/env python3
import json,os,pathlib,shutil,sys
args=sys.argv[1:]
if args==['--version']:print('synthetic-cli-offline');sys.exit(0)
home=pathlib.Path(os.environ['CODEX_HOME']);config=(home/'config.toml').read_text()
assert 'model = "gpt-6-luna"' in config and 'model_reasoning_effort = "max"' in config
workspace=pathlib.Path(args[args.index('--cd')+1]);source=pathlib.Path(os.environ['CONTROLLER_TEST_SOURCE'])
shutil.copyfile(source/'scripts/install-plugin.mjs',workspace/'scripts/install-plugin.mjs')
regression="import assert from 'node:assert/strict';import {execFileSync} from 'node:child_process';import test from 'node:test';test('canonical parser integrity',()=>{const r=JSON.parse(execFileSync('node',["+json.dumps(str(source/'scripts/development-install-grader.mjs'))+",process.cwd()+'/scripts/install-plugin.mjs'],{encoding:'utf8'}));assert.equal(r.pass,true)});"
(workspace/'packages/mcp/test/canonical-assets-offline.test.mjs').write_text(regression)
usage=dict(input_tokens=1000,cached_input_tokens=700,output_tokens=30,reasoning_output_tokens=0,total_tokens=1030)
(home/'sessions').mkdir();(home/'sessions/offline-thread.jsonl').write_text(json.dumps(dict(type='turn_context',payload=dict(model='gpt-6-luna')))+'\\n'+json.dumps(dict(type='token_usage_record',payload=dict(response_id='offline',usage=usage,model_context_window=2000)))+'\\n')
print(json.dumps(dict(type='thread.started',thread_id='offline-thread')),flush=True)
print(json.dumps(dict(type='turn.completed',usage=usage)),flush=True)
`); fs.chmodSync(bin, 0o755);
    const driver = path.join(root, 'driver.py');
    fs.writeFileSync(driver, `import runpy,shutil,sys\nshutil.which=lambda name:None\nsys.argv=[${JSON.stringify(path.join(repo, 'scripts/benchmark-development.py'))},*sys.argv[1:]]\nsys.path.insert(0,${JSON.stringify(path.join(repo, 'scripts'))})\nrunpy.run_path(sys.argv[0],run_name='__main__')\n`);
    const output = path.join(root, 'result');
    try {
    execFileSync('python3', [driver, '--arms', 'native', '--codex', bin, '--output', output], {
      cwd: repo, env: { ...process.env, CODEX_HOME: auth, CONTROLLER_TEST_SOURCE: repo }, timeout: 60000, stdio: 'pipe',
    });
    } catch (error) {
      const reportFile = path.join(output, 'report.json');
      const stderrFile = path.join(output, '1-native/stderr.log');
      throw new Error(String(error.stdout || '') + String(error.stderr || '') +
        (fs.existsSync(reportFile) ? JSON.stringify(JSON.parse(fs.readFileSync(reportFile, 'utf8')).results.map((r) => ({ quality: r.quality, scopePass: r.scopePass, businessChanged: r.businessChanged }))) : '') +
        (fs.existsSync(stderrFile) ? fs.readFileSync(stderrFile, 'utf8') : '') +
        (fs.existsSync(path.join(output, '1-native/seed-tests.log')) ? fs.readFileSync(path.join(output, '1-native/seed-tests.log'), 'utf8').slice(-1200) : ''));
    }
    const report = JSON.parse(fs.readFileSync(path.join(output, 'report.json')));
    assert.equal(report.results[0].validForComparison, true);
    assert.equal(report.results[0].quality.checks.length, 6);
    assert.equal(report.results[0].quality.regression.pass, true);
    assert.equal(report.results[0].metrics.inputTokens, 1000);
    assert.equal(report.campaign.runs.length, 1);
    assert.equal(fs.existsSync(path.join(output, '1-native/codex/auth.json')), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

/** Reproducible output-context benchmark; no model requests or API keys. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { getEncoding } from 'js-tiktoken';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const option = (name, fallback) => argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback;
const runs = Number(option('--runs', '5'));
assert.ok(Number.isInteger(runs) && runs >= 1 && runs <= 20, '--runs must be 1..20');
const output = path.resolve(option('--output', path.join(repo, '.contextos/benchmarks/context-reduction.json')));
const server = path.resolve(option('--server', path.join(repo, 'plugins/contextos/server/contextos-mcp.mjs')));
const encoder = getEncoding('o200k_base');
const tokens = (text) => encoder.encode(String(text)).length;
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
const sourcePath = 'packages/orchestrator/src/pipelines.mjs';
const source = fs.readFileSync(path.join(repo, sourcePath), 'utf8');
const symbol = 'guardBatchInspectAction';
const start = source.indexOf(`function ${symbol}(`);
const end = source.indexOf('\n}', start) + 2;
assert.ok(start >= 0 && end > start);
const excerpt = source.slice(start, end);
const routerPath = 'packages/orchestrator/src/intent-router.mjs';
const routerSource = fs.readFileSync(path.join(repo, routerPath), 'utf8');
const routerStart = routerSource.indexOf('export function extractPaths(');
assert.ok(routerStart >= 0);
const routerExcerpt = routerSource.slice(routerStart, routerSource.indexOf('\n}', routerStart) + 2);
const skill = fs.readFileSync(path.join(repo, 'plugins/contextos/skills/contextos/SKILL.md'), 'utf8');
const samples = [];
const validation = new Set();
let definitions;

async function connect(surface, root) {
  const transport = new StdioClientTransport({
    command: process.execPath, args: [server], cwd: repo,
    env: { ...process.env, CONTEXTOS_LEAN_SURFACE: surface === 'compact' ? '1' : '0', CONTEXTOS_HOME: path.join(root, 'home') },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'contextos-output-benchmark', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

for (let run = 0; run < runs; run++) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-bench-'));
  fs.mkdirSync(path.join(root, 'src'));
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'contextos-benchmark', type: 'module' }));
  fs.writeFileSync(path.join(root, 'src/subject.mjs'), source);
  fs.writeFileSync(path.join(root, 'src/router.mjs'), routerSource);
  fs.writeFileSync(path.join(root, 'src/tiny.mjs'), 'export const ready = true;\n');
  const logLines = Array.from({ length: 1000 }, (_, i) => `build step ${i}: compiled module ${i}, dependency resolution complete`).join('\n');
  fs.writeFileSync(path.join(root, 'scripts/success.mjs'), `console.log(${JSON.stringify(logLines)}); console.log('BUILD_OK');\n`);
  fs.writeFileSync(path.join(root, 'scripts/failure.mjs'), `console.log(${JSON.stringify(logLines)}); console.error('Error: BENCH_FAILURE at src/subject.mjs:42:3'); process.exitCode = 1;\n`);
  const client = await connect('compact', root);
  try {
    if (!definitions) {
      const compact = await client.listTools();
      const legacyClient = await connect('legacy', root);
      try {
        const legacy = await legacyClient.listTools();
        definitions = {
          compactToolCount: compact.tools.length, legacyToolCount: legacy.tools.length,
          compactSchemaTokens: tokens(JSON.stringify(compact.tools)),
          legacySchemaTokens: tokens(JSON.stringify(legacy.tools)),
          skillTokens: tokens(skill), serverInstructionsTokens: tokens(client.getInstructions() || ''),
        };
        definitions.fixedContextTokens = definitions.compactSchemaTokens + definitions.skillTokens + definitions.serverInstructionsTokens;
      } finally { await legacyClient.close(); }
    }
    const call = async (action, args) => {
      const began = performance.now();
      const arguments_ = { action, args, projectRoot: root };
      const response = await client.callTool({ name: 'contextos', arguments: arguments_ });
      assert.ok(!response.isError, JSON.stringify(response));
      const text = response.content.filter((item) => item.type === 'text').map((item) => item.text).join('\n');
      return { text, requestTokens: tokens(JSON.stringify(arguments_).replaceAll(root, '<fixture>')), durationMs: performance.now() - began };
    };
    const record = (id, baseline, result, check) => {
      check(result.text);
      validation.add(id);
      samples.push({ id, run: run + 1, baselineOutputTokens: tokens(baseline), osOutputTokens: tokens(result.text.replaceAll(root, '<fixture>')), osRequestTokens: result.requestTokens, durationMs: Math.round(result.durationMs), responseSha256: sha(result.text), qualityPass: true });
    };
    const read = { path: 'src/subject.mjs', symbol };
    const first = await call('inspect', read);
    const hasSymbol = (text) => assert.match(text, /function guardBatchInspectAction/);
    record('source_whole_file_vs_symbol', source, first, hasSymbol);
    record('source_precise_native_slice_vs_symbol', excerpt, first, hasSymbol);
    const router = await call('inspect', { path: 'src/router.mjs', symbol: 'extractPaths' });
    record('router_whole_file_vs_symbol', routerSource, router, (text) => assert.match(text, /function extractPaths/));
    record('router_precise_native_slice_vs_symbol', routerExcerpt, router, (text) => assert.match(text, /function extractPaths/));
    const repeated = await call('inspect', read);
    record('repeat_symbol_read', excerpt, repeated, (text) => { assert.match(text, /unchanged/); assert.doesNotMatch(text, /function guardBatchInspectAction/); });
    const tiny = await call('inspect', { path: 'src/tiny.mjs' });
    record('tiny_file_read', 'export const ready = true;\n', tiny, (text) => assert.match(text, /ready = true/));
    const refreshed = await call('inspect', { ...read, refresh: true });
    hasSymbol(refreshed.text);
    fs.writeFileSync(path.join(root, 'src/subject.mjs'), source.replace('function guardBatchInspectAction(', 'function guardBatchInspectAction(').replace('if (!enabled || normalized?.tool', 'if (enabled === false || normalized?.tool'));
    const changed = await call('inspect', read);
    assert.match(changed.text, /enabled === false/);
    validation.add('fresh_read_after_disk_change');
    const ranges = await call('inspect', { path: 'src/subject.mjs', ranges: [[1, 2], [50, 51]] });
    assert.match(ranges.text, /^\s*50 \|/m);
    validation.add('multi_range_source_line_numbers');
    const batched = await call('pipeline', { mode: 'full', maxChars: 5000, parallel: [{ inspect: { path: 'src/subject.mjs', ranges: [[50, 51]], maxChars: 1500 } }, { inspect: { path: 'src/tiny.mjs', ranges: [[1, 1]], maxChars: 1000 } }] });
    assert.match(batched.text, /^\s*50 \|/m);
    assert.match(batched.text, /ready = true/);
    validation.add('batched_explicit_ranges');
    const rawSuccess = execFileSync(process.execPath, ['scripts/success.mjs'], { cwd: root, encoding: 'utf8' });
    const success = await call('verify', { command: 'node scripts/success.mjs' });
    record('synthetic_success_log', rawSuccess, success, (text) => assert.match(text, /Verdict: PASS/));
    let rawFailure;
    try { execFileSync(process.execPath, ['scripts/failure.mjs'], { cwd: root, encoding: 'utf8', stdio: 'pipe' }); }
    catch (error) { rawFailure = `${error.stdout}${error.stderr}`; }
    assert.ok(rawFailure);
    const failed = await call('verify', { command: 'node scripts/failure.mjs', autoTriage: false });
    record('synthetic_failure_log', rawFailure, failed, (text) => { assert.match(text, /Verdict: FAIL/); assert.match(text, /BENCH_FAILURE/); });
    const stopped = await call('pipeline', { chain: [{ run: 'node scripts/failure.mjs' }, { run: 'node -e "require(\'fs\').writeFileSync(\'should-not-exist\',\'x\')"' }] });
    assert.match(stopped.text, /HALTED/);
    assert.equal(fs.existsSync(path.join(root, 'should-not-exist')), false);
    validation.add('failed_command_halts_chain');
  } finally { await client.close(); fs.rmSync(root, { recursive: true, force: true }); }
}

const scenarios = [...new Set(samples.map((item) => item.id))].map((id) => {
  const group = samples.filter((item) => item.id === id);
  const baselineOutputTokens = median(group.map((item) => item.baselineOutputTokens));
  const osOutputTokens = median(group.map((item) => item.osOutputTokens));
  return { id, baselineOutputTokens, osOutputTokens, outputReductionPercent: Number(((1 - osOutputTokens / baselineOutputTokens) * 100).toFixed(2)), osRequestTokens: median(group.map((item) => item.osRequestTokens)), medianDurationMs: median(group.map((item) => item.durationMs)) };
});
const report = {
  schemaVersion: 1, measuredAt: new Date().toISOString(), version: JSON.parse(fs.readFileSync(path.join(repo, 'package.json'))).version,
  baseCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
  workingTreeModified: execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).trim().length > 0,
  serverSha256: sha(fs.readFileSync(server)), source: { path: sourcePath, sha256: sha(source), characters: source.length, symbol },
  environment: { node: process.version, platform: process.platform, arch: process.arch },
  methodology: { tokenizer: 'o200k_base', library: 'js-tiktoken', libraryVersion: JSON.parse(fs.readFileSync(path.join(repo, 'node_modules/js-tiktoken/package.json'))).version, runs, aggregation: 'median', metric: 'Tool response text tokens; OS request tokens reported separately', baseline: 'Same source/log: whole-file and efficient native symbol-slice controls; logs are explicitly synthetic', limitations: ['No LLM requests, reasoning tokens, provider billing, cached-input costs, or total task savings measured.', 'Fixed plugin schema, server instructions, and skill overhead are additional context; host schemas and pre-existing prompt are excluded.', 'Noisy-log fixtures illustrate compression, not typical project performance.', 'Source and tokenizer hashes/version allow auditing; dynamic receipt ids may shift a few tokens.'] },
  definitions, scenarios, qualityChecks: [...validation], samples,
};
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
console.table(scenarios.map(({ id, baselineOutputTokens, osOutputTokens, outputReductionPercent }) => ({ scenario: id, native: baselineOutputTokens, contextos: osOutputTokens, 'reduction %': outputReductionPercent })));
console.log(JSON.stringify({ report: output, fixedContextTokens: definitions.fixedContextTokens, qualityChecks: validation.size, runs }));

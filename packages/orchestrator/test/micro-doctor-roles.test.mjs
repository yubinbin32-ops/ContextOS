import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Orchestrator } from '../src/index.mjs';

test('profile responses redact credential values while settings still persist to disk', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-profile-redaction-'));
  const previousHome = process.env.CONTEXTOS_HOME;
  process.env.CONTEXTOS_HOME = path.join(root, 'global');
  const projectRoot = path.join(root, 'project');
  try {
    fs.mkdirSync(projectRoot, { recursive: true });
    const orchestrator = new Orchestrator({ service: {}, projectRoot, projectId: 'profile-redaction' });
    const savedText = await orchestrator.dispatch('ops', {
      capability: 'profile',
      action: 'set',
      values: {
        'micro.url': 'https://private.example.test/v1',
        'micro.key': 'super-secret-value',
        'micro.keyEnv': 'MY_PROVIDER_KEY',
        'micro.model': 'small-model',
        'agents.default': 'agy',
        'agents.adapters.agy.command': 'agy run --json',
        'agents.adapters.agy.env.AGY_TOKEN': 'adapter-secret-value',
      },
    });
    assert.doesNotMatch(savedText, /super-secret-value|adapter-secret-value/);
    assert.match(savedText, /\[redacted\]/);
    assert.match(savedText, /MY_PROVIDER_KEY/, 'environment variable names stay visible for debugging');

    const disk = fs.readFileSync(path.join(projectRoot, '.contextos/profile.json'), 'utf8');
    assert.match(disk, /super-secret-value/, 'the secret is still written to the private profile file');

    const readText = await orchestrator.dispatch('ops', { capability: 'profile', action: 'get' });
    assert.doesNotMatch(readText, /super-secret-value|adapter-secret-value/);
    assert.match(readText, /\[redacted\]/);
    const read = JSON.parse(readText);
    assert.equal(read.micro.key, '[redacted]');
    assert.equal(read.agents.adapters.agy.env.AGY_TOKEN, '[redacted]');
    assert.equal(read.micro.model, 'small-model');
  } finally {
    if (previousHome === undefined) delete process.env.CONTEXTOS_HOME;
    else process.env.CONTEXTOS_HOME = previousHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Micro doctor checks the API role by default and only inspects the CLI role when selected', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-micro-doctor-roles-'));
  const previousHome = process.env.CONTEXTOS_HOME;
  const previousApiProfile = process.env.CONTEXTOS_API_MICRO_PROFILE;
  process.env.CONTEXTOS_HOME = path.join(root, 'global');
  const projectRoot = path.join(root, 'project');
  try {
    fs.mkdirSync(path.join(projectRoot, '.contextos'), { recursive: true });
    fs.mkdirSync(process.env.CONTEXTOS_HOME, { recursive: true });
    fs.writeFileSync(path.join(process.env.CONTEXTOS_HOME, 'profile.json'), JSON.stringify({
      micro: { url: 'https://private.example.test/v1', key: 'doctor-secret', model: 'global-model' },
    }));
    const projectProfile = path.join(projectRoot, '.contextos/profile.json');
    fs.writeFileSync(projectProfile, JSON.stringify({
      micro: { model: 'project-model' },
      agents: { default: 'doctor-missing-cli', adapters: { 'doctor-missing-cli': { command: 'doctor-missing-cli', model: 'cli-model' } } },
    }));
    const orchestrator = new Orchestrator({ service: {}, projectRoot, projectId: 'doctor-fixture' });

    const defaultReportText = await orchestrator.dispatch('ops', { capability: 'micro', action: 'doctor', args: {} });
    const defaultReport = JSON.parse(defaultReportText);
    assert.equal(defaultReport.role, 'api-micro');
    assert.equal(defaultReport.routing.provider, 'api');
    assert.equal(defaultReport.status, 'configured-unverified');
    assert.equal(defaultReport.ok, null, 'configuration alone is not a successful provider probe');
    assert.equal(defaultReport.checks.find((check) => check.name === 'configured_model')?.value, 'project-model');
    assert.equal(defaultReport.checks.find((check) => check.name === 'task_analyze')?.ok, null);
    assert.deepEqual(defaultReport.checks.find((check) => check.name === 'request_limits')?.value, {
      maxTransportInvocations: null,
      maxToolCalls: null,
      maxEvidenceBytes: null,
      maxOutputTokens: null,
      timeoutMs: null,
    });
    assert.equal(defaultReport.checks.find((check) => check.name === 'request_limits')?.ok, null);
    assert.equal(defaultReport.checks.some((check) => check.name === 'connectivity'), false);
    assert.doesNotMatch(defaultReportText, /doctor-secret|private\.example\.test/);

    const explicitCli = JSON.parse(await orchestrator.dispatch('ops', {
      capability: 'micro', action: 'doctor', args: { role: 'cli' },
    }));
    assert.equal(explicitCli.role, 'cli-agent');
    assert.equal(explicitCli.routing.provider, 'cli');
    assert.equal(explicitCli.checks.find((check) => check.name === 'installed')?.ok, false);

    const privateApiProfile = path.join(root, 'task-api-profile.json');
    fs.writeFileSync(privateApiProfile, JSON.stringify({ micro: {
      url: 'https://private.example.test/zen/go/v1', key: 'private-task-secret', model: 'deepseek-v4.1-flash',
      budget: { maxTransportInvocations: 2, maxToolCalls: 8, maxEvidenceBytes: 4096 },
      maxOutputTokens: 256, timeoutMs: 30000,
    } }), { mode: 0o600 });
    process.env.CONTEXTOS_API_MICRO_PROFILE = privateApiProfile;
    const taskProfileOrchestrator = new Orchestrator({ service: {}, projectRoot, projectId: 'doctor-task-profile' });
    const taskProfileText = await taskProfileOrchestrator.dispatch('ops', { capability: 'micro', action: 'doctor', args: {} });
    const taskProfileReport = JSON.parse(taskProfileText);
    assert.equal(taskProfileReport.role, 'api-micro');
    assert.equal(taskProfileReport.checks.find((check) => check.name === 'configured_model')?.value, 'deepseek-v4.1-flash');
    assert.deepEqual(taskProfileReport.checks.find((check) => check.name === 'request_limits'), {
      name: 'request_limits', ok: true, value: {
        maxTransportInvocations: 2,
        maxToolCalls: 8,
        maxEvidenceBytes: 4096,
        maxOutputTokens: 256,
        timeoutMs: 30000,
      },
    });
    assert.doesNotMatch(taskProfileText, /private-task-secret|private\.example\.test/);
    assert.equal(taskProfileReport.checks.some((check) => check.name === 'connectivity'), false);
    delete process.env.CONTEXTOS_API_MICRO_PROFILE;

    fs.writeFileSync(projectProfile, JSON.stringify({
      micro: null,
      agents: { default: 'doctor-missing-cli', adapters: { 'doctor-missing-cli': { command: 'doctor-missing-cli', model: 'cli-model' } } },
    }));
    const noApiReport = JSON.parse(await orchestrator.dispatch('ops', { capability: 'micro', action: 'doctor', args: {} }));
    assert.equal(noApiReport.role, 'api-micro');
    assert.equal(noApiReport.status, 'unconfigured');
    assert.equal(noApiReport.routing.provider, 'api');
    assert.equal(noApiReport.checks.find((check) => check.name === 'endpoint')?.ok, false);
    assert.equal(noApiReport.checks.some((check) => check.name === 'installed'), false, 'missing API config does not fall back to CLI inspection');
  } finally {
    if (previousHome === undefined) delete process.env.CONTEXTOS_HOME;
    else process.env.CONTEXTOS_HOME = previousHome;
    if (previousApiProfile === undefined) delete process.env.CONTEXTOS_API_MICRO_PROFILE;
    else process.env.CONTEXTOS_API_MICRO_PROFILE = previousApiProfile;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

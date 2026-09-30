import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveMicroRoles } from '../src/micro-role-config.mjs';

test('canonical profile exposes the API and CLI roles independently', () => {
  const profile = {
    micro: {
      url: 'https://api.example.test/v1',
      key: 'private-api-key',
      provider: 'deepseek',
      model: 'deepseek-small',
      transport: 'responses',
      thinking: 'off',
    },
    agents: {
      default: 'agy',
      adapters: {
        agy: { command: ['agy', 'run', '--json'], model: 'fast' },
        aider: { command: 'aider' },
      },
    },
  };
  const before = structuredClone(profile);
  const roles = resolveMicroRoles(profile);

  assert.deepEqual(roles.micro, profile.micro);
  assert.equal(roles.agents.default, 'agy');
  assert.deepEqual(roles.agents.adapters.agy, { command: ['agy', 'run', '--json'], model: 'fast' });
  assert.deepEqual(roles.agents.adapters.aider, { command: 'aider' });
  assert.deepEqual(roles.warnings, []);
  assert.deepEqual(profile, before, 'resolving roles is pure');
});

test('legacy keys are ignored instead of being mapped into the two roles', () => {
  const roles = resolveMicroRoles({
    micro: {
      url: 'https://legacy.example.test/v1',
      key: 'private-api-key',
      priority: 'cli-first',
      cli: { command: 'aider' },
    },
    microAPI: { model: 'flat-model' },
    microCLI: { command: 'opencode' },
    roles: { micro: { model: 'nested-model' }, agents: { default: 'nested-agent' } },
  });

  assert.deepEqual(roles.micro, {
    url: 'https://legacy.example.test/v1',
    key: 'private-api-key',
    priority: 'cli-first',
    cli: { command: 'aider' },
  }, 'the canonical micro object is returned as written; legacy keys are not translated');
  assert.deepEqual(roles.agents, { default: null, adapters: {} }, 'legacy microCLI/roles.agents never become canonical adapters');
});

test('missing, empty, or malformed roles resolve deterministically', () => {
  assert.deepEqual(resolveMicroRoles({}), { micro: null, agents: { default: null, adapters: {} }, warnings: [] });
  assert.deepEqual(resolveMicroRoles({ micro: null, agents: null }), { micro: null, agents: { default: null, adapters: {} }, warnings: [] });
  const roles = resolveMicroRoles({
    micro: 'invalid',
    agents: { default: '  ', adapters: { good: { command: 'g' }, bad: null, worse: 'string' } },
  });
  assert.equal(roles.micro, null);
  assert.equal(roles.agents.default, null);
  assert.deepEqual(Object.keys(roles.agents.adapters), ['good']);
});

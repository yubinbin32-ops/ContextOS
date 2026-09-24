import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = path.resolve(import.meta.dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const skill = read('plugins/contextos/skills/contextos/SKILL.md');
const setup = read('AI_SETUP.md');
const readme = read('README.md');
const readmeZh = read('README_zh.md');
const contributing = read('CONTRIBUTING.md');
const decisions = read('DECISION.md');

for (const tool of ['explore', 'change', 'inspect', 'verify', 'ship', 'ops']) {
  assert.match(skill, new RegExp(`\`${tool}\``), `Skill must document ${tool}`);
}
assert.match(skill, /tool_search/, 'Skill must document cold-start tool loading');
assert.doesNotMatch(skill, /沙箱执行/, 'Skill must not claim commands run in a sandbox');
assert.doesNotMatch(setup, /contextos_init|contextos_switch/, 'AI_SETUP must not reference removed facade tools');
assert.doesNotMatch(setup, /projectId:\s*"contextos"/, 'AI_SETUP must not hard-code the legacy project identity');
assert.match(decisions, /架构演进速览/, 'DECISION must expose a concise architecture evolution history');
assert.match(readme, /DECISION\.md/, 'README must link the decision history');
assert.match(readmeZh, /DECISION\.md/, 'README_zh must link the decision history');
assert.doesNotMatch(readme + readmeZh, /18 Blocks|18 Links|49 files|49 源码文件/, 'README files must not hard-code historical graph counts');
assert.doesNotMatch(contributing, /contextos\.sqlite/, 'Contributing guide must use the real state.sqlite filename');

console.log('Documentation contract verification passed.');

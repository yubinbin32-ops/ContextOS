/**
 * Single source of truth for the public MCP tool surface.
 *
 * Keep this list aligned with the service schemas and the comprehensive Skill.
 * The plugin smoke test fails if the runtime schema drifts from this manifest.
 */
export const TOOL_ACTIONS = Object.freeze({
  os_context: Object.freeze(['brief', 'search', 'open', 'reconcile']),
  plan: Object.freeze(['list', 'create', 'open', 'check', 'complete', 'delete']),
  task: Object.freeze([
    'create',
    'start',
    'open',
    'note',
    'check',
    'finish',
    'sync',
    'resume',
    'activate',
    'develop',
    'bind_rule',
    'unbind_rule',
    'update',
    'probe',
    'graduate_probe',
    'reconcile',
  ]),
  block: Object.freeze(['list', 'open', 'search', 'bind', 'bind_auto', 'delete']),
  chain: Object.freeze([
    'list',
    'open',
    'compose',
    'delete',
    'link',
    'unlink',
    'links',
    'validate_layout',
    'validate',
  ]),
  code: Object.freeze(['outline', 'read', 'edit', 'search', 'create']),
  run_command: Object.freeze([]),
  process: Object.freeze(['start', 'list', 'status', 'logs', 'stop', 'clear']),
  knowledge: Object.freeze(['rule_list', 'rule_open', 'rule_write', 'decision_open', 'decision_write']),
  contextos_init: Object.freeze([]),
  contextos_doctor: Object.freeze([]),
  contextos_switch: Object.freeze([]),
});

export const MCP_TOOL_NAMES = Object.freeze(Object.keys(TOOL_ACTIONS));

export function toolActions(toolName) {
  return TOOL_ACTIONS[toolName] || [];
}

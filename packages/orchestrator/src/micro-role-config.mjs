function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
}

function cloneRecord(value) {
  return isRecord(value) ? clone(value) : {};
}

function normalizeAgents(value) {
  if (!isRecord(value)) return { default: null, adapters: {} };
  const adapters = isRecord(value.adapters)
    ? Object.fromEntries(Object.entries(value.adapters)
      .filter(([, config]) => isRecord(config))
      .map(([name, config]) => [name, cloneRecord(config)]))
    : {};
  const defaultName = typeof value.default === 'string' && value.default.trim()
    ? value.default.trim()
    : null;
  return { ...cloneRecord(value), default: defaultName, adapters };
}

/**
 * Read the two independent Micro roles from the canonical profile shape:
 * `micro` is the API evidence broker required for semantic retrieval, and
 * `agents` holds optional CLI adapters. No legacy key is read and neither role
 * can route to the other.
 */
export function resolveMicroRoles(profile = {}) {
  const source = isRecord(profile) ? profile : {};
  return {
    micro: isRecord(source.micro) ? cloneRecord(source.micro) : null,
    agents: normalizeAgents(source.agents),
    warnings: [],
  };
}

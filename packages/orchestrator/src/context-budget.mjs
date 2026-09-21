/**
 * Every orchestrator response passes through a hard character budget.
 * Sections with the lowest priority are truncated or dropped first, and the
 * caller is told exactly what was cut so it can ask for `depth: "deep"`.
 */

export const BUDGET_PRESETS = Object.freeze({
  shallow: 1800,
  normal: 4000,
  deep: 9000,
});

export function resolveBudget(depth, override) {
  if (typeof override === 'number' && override > 0) return override;
  return BUDGET_PRESETS[depth] || BUDGET_PRESETS.normal;
}

function priorityOf(section) {
  return typeof section.priority === 'number' ? section.priority : 99;
}

export function fitSections(sections = [], { maxChars = BUDGET_PRESETS.normal } = {}) {
  const ordered = [...sections]
    .filter((section) => (section.lines || []).length > 0)
    .sort((a, b) => priorityOf(a) - priorityOf(b));

  const chunks = [];
  const included = [];
  const dropped = [];
  const truncated = [];
  let used = 0;

  for (const section of ordered) {
    const body = section.lines.join('\n');
    const header = `## ${section.title}`;
    const block = `${header}\n${body}`;
    if (used + block.length <= maxChars) {
      chunks.push(block);
      used += block.length + 2;
      included.push(section.key);
      continue;
    }
    const remaining = maxChars - used - header.length - 2;
    if (remaining > 160) {
      const cut = body.slice(0, remaining - 24);
      chunks.push(`${header}\n${cut}\n... (+${body.length - cut.length} chars omitted)`);
      used = maxChars;
      included.push(section.key);
      truncated.push(section.key);
    } else {
      dropped.push(section.key);
    }
  }

  return {
    text: chunks.join('\n\n'),
    meta: { maxChars, used, included, dropped, truncated },
  };
}

/**
 * Flow Engine: Natural Arrow Flow Parser (A -> B -> C)
 */

export function parseFlowExpression(expression) {
  // Regex to match arrows with optional kind and label:
  // e.g. " -> ", " --> ", " -[calls]-> ", " -[reads:config]-> "
  const arrowRegex = /\s*-(?:\[([^\]:]+)(?::([^\]]+))?\])?->\s*|\s*-->\s*|\s*->\s*/g;

  const nodes = [];
  const edgeSpecs = [];
  let lastIndex = 0;
  let match;

  while ((match = arrowRegex.exec(expression)) !== null) {
    const nodeText = expression.slice(lastIndex, match.index).trim();
    if (nodeText) {
      nodes.push(nodeText);
    }
    edgeSpecs.push({
      kind: match[1] || "flows_to",
      label: match[2] || "",
    });
    lastIndex = arrowRegex.lastIndex;
  }

  const remaining = expression.slice(lastIndex).trim();
  if (remaining) {
    nodes.push(remaining);
  }

  if (nodes.length < 2) {
    throw new Error(`Flow expression requires at least 2 nodes connected by arrows (e.g. "A -> B"), received: ${expression}`);
  }

  return { nodes, edgeSpecs };
}

export function expandArrowFlowOperations(snapshot, flowExpression, extraBlocks = []) {
  const { nodes, edgeSpecs } = parseFlowExpression(flowExpression);
  const allBlocks = [...(snapshot.blocks || []), ...extraBlocks];

  // Resolve node names to Block IDs
  const resolveBlockId = (name) => {
    let raw = name.trim();
    if (raw.startsWith("block:")) raw = raw.slice("block:".length);

    // Exact ID match
    let block = allBlocks.find((b) => b.id === raw);
    if (block) return block.id;

    // Title match
    block = allBlocks.find((b) => b.title && b.title.toLowerCase() === raw.toLowerCase());
    if (block) return block.id;

    // Partial ID or title match
    block = allBlocks.find((b) => (b.id && b.id.toLowerCase().includes(raw.toLowerCase())) || (b.title && b.title.toLowerCase().includes(raw.toLowerCase())));
    if (block) return block.id;

    throw new Error(`Could not resolve Block for "${name}" in arrow flow`);
  };

  const blockIds = nodes.map(resolveBlockId);
  const operations = [];
  const createdLinks = [];

  for (let i = 0; i < blockIds.length - 1; i++) {
    const sourceId = blockIds[i];
    const targetId = blockIds[i + 1];
    const edge = edgeSpecs[i] || { kind: "flows_to", label: "" };
    const linkId = `link-${sourceId}-to-${targetId}`;

    const existing = (snapshot.links || []).find((l) => l.id === linkId);
    if (existing) {
      operations.push({
        action: "update_link",
        id: linkId,
        expectedRevision: existing.currentRevision,
        fields: {
          kind: edge.kind,
          label: edge.label || existing.label,
        },
      });
      createdLinks.push({ id: linkId, sourceId, targetId, kind: edge.kind, updated: true });
    } else {
      operations.push({
        action: "create_link",
        id: linkId,
        fields: {
          sourceType: "block",
          sourceId,
          targetType: "block",
          targetId,
          kind: edge.kind,
          label: edge.label,
          contract: `Flow: block:${sourceId} ${edge.kind} block:${targetId}`,
        },
      });
      createdLinks.push({ id: linkId, sourceId, targetId, kind: edge.kind, updated: false });
    }
  }

  return { blockIds, operations, createdLinks };
}

export function applyArrowFlow(service, flowExpression, {
  actor = "agent",
  reason = "Declare architectural flow via arrow expression",
} = {}) {
  const snapshot = service.snapshot();
  const { blockIds, operations, createdLinks } = expandArrowFlowOperations(snapshot, flowExpression);

  const result = service.mutate({
    operations,
    actor,
    reason,
    task: "arrow-flow",
  });

  return {
    flow: blockIds.map((id) => `block:${id}`).join(" -> "),
    links: createdLinks,
    changeSetId: result.changeSet?.id,
    graphRevision: result.graphRevision,
  };
}

/**
 * Chain topology helpers.
 *
 * A Chain is an ordered feature network. It may fan out or merge, but every
 * edge must point forward in the declared node order and every node must be
 * reachable from a root. This keeps the visual route deterministic while
 * still allowing parallel implementation branches.
 */

function nodeId(node) {
  return typeof node === "string" ? node : node?.blockId ?? node?.block_id ?? node?.id ?? null;
}

function edgeId(edge) {
  return typeof edge === "string" ? edge : edge?.linkId ?? edge?.id ?? null;
}

function edgeValue(edge, key) {
  if (key === "sourceId") return edge?.sourceId ?? edge?.source_id ?? edge?.link?.sourceId ?? edge?.link?.source_id ?? null;
  if (key === "targetId") return edge?.targetId ?? edge?.target_id ?? edge?.link?.targetId ?? edge?.link?.target_id ?? null;
  return null;
}

export function inspectChainTopology({ nodes = [], edges = [] } = {}) {
  const orderedNodes = nodes.map((node, index) => ({
    id: nodeId(node),
    position: Number.isInteger(node?.position) ? node.position : index,
  }));
  const nodeIds = orderedNodes.map((node) => node.id).filter(Boolean);
  const nodeSet = new Set(nodeIds);
  const positions = new Map(orderedNodes.filter((node) => node.id).map((node) => [node.id, node.position]));
  const issues = [];
  const add = (code, detail, hard = true, extra = {}) => issues.push({ code, detail, hard, ...extra });

  const duplicateNodes = nodeIds.filter((id, index) => nodeIds.indexOf(id) !== index);
  if (duplicateNodes.length) add("duplicate_node", `duplicate node(s): ${[...new Set(duplicateNodes)].join(", ")}`);
  const duplicatePositions = orderedNodes
    .filter((node, index, all) => all.findIndex((candidate) => candidate.position === node.position) !== index)
    .map((node) => node.position);
  if (duplicatePositions.length) add("duplicate_position", `duplicate node position(s): ${[...new Set(duplicatePositions)].join(", ")}`);
  const expectedPositions = orderedNodes.map((node, index) => index);
  if (orderedNodes.some((node, index) => node.position !== expectedPositions[index])) {
    add("position_gap", "Chain node positions must be contiguous and start at 0");
  }

  const normalizedEdges = edges.map((edge, index) => ({
    id: edgeId(edge),
    sourceId: edgeValue(edge, "sourceId"),
    targetId: edgeValue(edge, "targetId"),
    position: Number.isInteger(edge?.position) ? edge.position : index,
  }));
  const duplicateEdges = normalizedEdges.map((edge) => edge.id).filter((id, index, all) => id && all.indexOf(id) !== index);
  if (duplicateEdges.length) add("duplicate_edge", `duplicate edge(s): ${[...new Set(duplicateEdges)].join(", ")}`);

  // Keep two views of the network. The forward view is used to report an
  // edge whose declared order is wrong; the structural view is used for
  // connectivity and cycle detection so a backward edge cannot hide a bad
  // graph behind the ordering check.
  const structuralIndegree = new Map(nodeIds.map((id) => [id, 0]));
  const structuralAdjacency = new Map(nodeIds.map((id) => [id, []]));
  const undirectedAdjacency = new Map(nodeIds.map((id) => [id, new Set()]));
  const structuralEdges = [];
  for (const edge of normalizedEdges) {
    if (!edge.id) {
      add("missing_edge_id", "Chain edge is missing link id");
      continue;
    }
    if (!nodeSet.has(edge.sourceId) || !nodeSet.has(edge.targetId)) {
      add("external_endpoint", `edge ${edge.id} must connect two Chain nodes`, true, { edgeId: edge.id });
      continue;
    }
    if (edge.sourceId === edge.targetId) {
      add("self_edge", `edge ${edge.id} points from ${edge.sourceId} to itself`, true, { edgeId: edge.id });
      continue;
    }
    structuralIndegree.set(edge.targetId, (structuralIndegree.get(edge.targetId) ?? 0) + 1);
    structuralAdjacency.get(edge.sourceId).push(edge.targetId);
    undirectedAdjacency.get(edge.sourceId).add(edge.targetId);
    undirectedAdjacency.get(edge.targetId).add(edge.sourceId);
    structuralEdges.push(edge);
    if (positions.get(edge.sourceId) >= positions.get(edge.targetId)) {
      add(
        "backward_edge",
        `edge ${edge.id} points backward (${edge.sourceId}@${positions.get(edge.sourceId)} -> ${edge.targetId}@${positions.get(edge.targetId)})`,
        true,
        { edgeId: edge.id, sourceId: edge.sourceId, targetId: edge.targetId },
      );
      continue;
    }
  }

  const roots = nodeIds.filter((id) => (structuralIndegree.get(id) ?? 0) === 0);
  const reachable = new Set();
  const queue = [...roots];
  while (queue.length) {
    const id = queue.shift();
    if (reachable.has(id)) continue;
    reachable.add(id);
    queue.push(...(structuralAdjacency.get(id) ?? []));
  }
  const weakReachable = new Set();
  const weakQueue = nodeIds.length ? [nodeIds[0]] : [];
  while (weakQueue.length) {
    const id = weakQueue.shift();
    if (weakReachable.has(id)) continue;
    weakReachable.add(id);
    weakQueue.push(...(undirectedAdjacency.get(id) ?? []));
  }
  const missingNodeIds = nodeIds.filter((id) => !weakReachable.has(id));
  const connected = nodeIds.length <= 1 || missingNodeIds.length === 0;
  // A Kahn pass over the structural edges detects cycles even when one of
  // those edges points backward in the declared visual order.
  const cycleIndegree = new Map(structuralIndegree);
  const cycleQueue = nodeIds.filter((id) => cycleIndegree.get(id) === 0);
  let cycleVisited = 0;
  while (cycleQueue.length) {
    const id = cycleQueue.shift();
    cycleVisited += 1;
    for (const next of structuralAdjacency.get(id) ?? []) {
      cycleIndegree.set(next, cycleIndegree.get(next) - 1);
      if (cycleIndegree.get(next) === 0) cycleQueue.push(next);
    }
  }
  const hasCycle = structuralEdges.length > 0 && cycleVisited < nodeIds.length;
  if (hasCycle) {
    add("cycle", "Chain Links form a cycle and cannot be ordered", true, {
      cycleNodeIds: nodeIds.filter((id) => cycleIndegree.get(id) > 0),
    });
  }
  if (nodeIds.length > 1 && !connected) {
    add(
      "disconnected",
      `Chain has disconnected node(s): ${missingNodeIds.join(", ")}`,
      false,
      { roots, missingNodeIds },
    );
  }
  if (nodeIds.length > 1 && structuralEdges.length === 0) {
    add("no_edges", "Chain with multiple nodes needs an explicit Link between its feature stages", false, { roots, missingNodeIds: nodeIds });
  }

  return {
    nodes: orderedNodes,
    edges: normalizedEdges,
    roots,
    reachableNodeIds: [...reachable],
    missingNodeIds,
    connected,
    valid: issues.every((issue) => !issue.hard),
    complete: issues.length === 0,
    issues,
  };
}

/** Return a stable topological order, preserving the existing order whenever possible. */
export function stableChainOrder(nodes = [], edges = []) {
  const topology = inspectChainTopology({ nodes, edges });
  const nodeIds = topology.nodes.map((node) => node.id);
  if (new Set(nodeIds).size !== nodeIds.length || nodeIds.some((id) => !id)) return null;
  const nodeSet = new Set(nodeIds);
  const originalPosition = new Map(topology.nodes.map((node, index) => [node.id, Number.isInteger(node.position) ? node.position : index]));
  const indegree = new Map(nodeIds.map((id) => [id, 0]));
  const adjacency = new Map(nodeIds.map((id) => [id, []]));
  for (const edge of edges) {
    const sourceId = edgeValue(edge, "sourceId");
    const targetId = edgeValue(edge, "targetId");
    if (!edgeId(edge) || !nodeSet.has(sourceId) || !nodeSet.has(targetId) || sourceId === targetId) return null;
    if (!indegree.has(sourceId) || !indegree.has(targetId)) return null;
    const existing = adjacency.get(sourceId);
    if (existing.includes(targetId)) continue;
    indegree.set(targetId, indegree.get(targetId) + 1);
    existing.push(targetId);
  }
  const ready = nodeIds.filter((id) => indegree.get(id) === 0);
  const output = [];
  while (ready.length) {
    ready.sort((left, right) => originalPosition.get(left) - originalPosition.get(right) || left.localeCompare(right));
    const id = ready.shift();
    output.push(id);
    for (const next of adjacency.get(id) ?? []) {
      indegree.set(next, indegree.get(next) - 1);
      if (indegree.get(next) === 0) ready.push(next);
    }
  }
  return output.length === nodeIds.length ? output : null;
}

export function topologyIssueText(chainId, topology) {
  return (topology?.issues ?? []).map((issue) => `chain:${chainId} ${issue.code}: ${issue.detail}`).join("; ");
}

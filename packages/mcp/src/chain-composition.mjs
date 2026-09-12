/**
 * Composition topology for Composite Chains.
 *
 * Leaf Chains keep using chain_nodes/chain_edges and the Block/Link network
 * reconciler. A Composite Chain uses typed members (chain or block) and the
 * same global Link records for its macro route. This module deliberately
 * keeps the two topologies separate: a parent route describes feature stages,
 * while a child Chain owns its own implementation path.
 */

function memberType(value) {
  return value === "chain" ? "chain" : value === "block" ? "block" : null;
}

export function memberKey(type, id) {
  const normalizedType = memberType(type);
  if (!normalizedType || !id) return null;
  return `${normalizedType}:${id}`;
}

export function memberRef(value, fallbackType = null) {
  if (typeof value === "string") {
    const separator = value.indexOf(":");
    if (separator > 0) {
      const type = memberType(value.slice(0, separator));
      const id = value.slice(separator + 1);
      return type && id ? { memberType: type, memberId: id } : null;
    }
    return fallbackType && memberType(fallbackType) && value
      ? { memberType: fallbackType, memberId: value }
      : null;
  }
  if (!value || typeof value !== "object") return null;
  const type = memberType(value.memberType ?? value.member_type ?? value.type ?? fallbackType);
  const id = value.memberId ?? value.member_id ?? value.id;
  return type && id ? { memberType: type, memberId: id } : null;
}

function nodeId(node) {
  const ref = memberRef(node);
  return ref ? memberKey(ref.memberType, ref.memberId) : null;
}

function edgeId(edge) {
  return typeof edge === "string" ? edge : edge?.linkId ?? edge?.link_id ?? edge?.id ?? null;
}

function endpoint(link, side) {
  const type = memberType(link?.[`${side}Type`] ?? link?.[`${side}_type`]);
  const id = link?.[`${side}Id`] ?? link?.[`${side}_id`];
  return type && id ? { memberType: type, memberId: id } : null;
}

function positionOf(item, index) {
  return Number.isInteger(item?.position) ? item.position : index;
}

function topoIssues(nodes, edges) {
  const issues = [];
  const add = (code, detail, hard = true, extra = {}) => issues.push({ code, detail, hard, ...extra });
  const normalizedNodes = nodes.map((node, index) => ({
    ref: memberRef(node),
    id: nodeId(node),
    position: positionOf(node, index),
  }));
  const nodeIds = normalizedNodes.map((node) => node.id).filter(Boolean);
  const nodeSet = new Set(nodeIds);
  const positions = new Map(normalizedNodes.filter((node) => node.id).map((node) => [node.id, node.position]));

  const duplicateNodes = nodeIds.filter((id, index) => nodeIds.indexOf(id) !== index);
  if (duplicateNodes.length) add("duplicate_member", `duplicate member(s): ${[...new Set(duplicateNodes)].join(", ")}`);
  const expectedPositions = normalizedNodes.map((_, index) => index);
  if (normalizedNodes.some((node, index) => node.position !== expectedPositions[index])) {
    add("position_gap", "Composite Chain member positions must be contiguous and start at 0");
  }

  const normalizedEdges = edges.map((edge, index) => ({
    id: edgeId(edge),
    source: edge.source ?? endpoint(edge.link ?? edge, "source"),
    target: edge.target ?? endpoint(edge.link ?? edge, "target"),
    sourceId: edge.sourceId ?? edge.source_id ?? edge.link?.sourceId ?? edge.link?.source_id,
    targetId: edge.targetId ?? edge.target_id ?? edge.link?.targetId ?? edge.link?.target_id,
    sourceType: edge.sourceType ?? edge.source_type ?? edge.link?.sourceType ?? edge.link?.source_type,
    targetType: edge.targetType ?? edge.target_type ?? edge.link?.targetType ?? edge.link?.target_type,
    position: positionOf(edge, index),
  })).map((edge) => ({
    ...edge,
    source: edge.source ?? memberRef({ memberType: edge.sourceType, memberId: edge.sourceId }),
    target: edge.target ?? memberRef({ memberType: edge.targetType, memberId: edge.targetId }),
  })).map((edge) => ({
    ...edge,
    sourceKey: edge.source ? memberKey(edge.source.memberType, edge.source.memberId) : null,
    targetKey: edge.target ? memberKey(edge.target.memberType, edge.target.memberId) : null,
  }));
  const duplicateEdges = normalizedEdges.map((edge) => edge.id).filter((id, index, all) => id && all.indexOf(id) !== index);
  if (duplicateEdges.length) add("duplicate_edge", `duplicate edge(s): ${[...new Set(duplicateEdges)].join(", ")}`);

  const indegree = new Map(nodeIds.map((id) => [id, 0]));
  const adjacency = new Map(nodeIds.map((id) => [id, []]));
  const undirected = new Map(nodeIds.map((id) => [id, new Set()]));
  const structuralEdges = [];
  for (const edge of normalizedEdges) {
    if (!edge.id) {
      add("missing_edge_id", "Composite Chain edge is missing Link id");
      continue;
    }
    if (!edge.sourceKey || !edge.targetKey || !nodeSet.has(edge.sourceKey) || !nodeSet.has(edge.targetKey)) {
      add("external_endpoint", `edge ${edge.id} must connect two Composite Chain members`, true, { edgeId: edge.id });
      continue;
    }
    if (edge.sourceKey === edge.targetKey) {
      add("self_edge", `edge ${edge.id} points from ${edge.sourceKey} to itself`, true, { edgeId: edge.id });
      continue;
    }
    if (positions.get(edge.sourceKey) >= positions.get(edge.targetKey)) {
      add("backward_edge", `edge ${edge.id} points backward (${edge.sourceKey}@${positions.get(edge.sourceKey)} -> ${edge.targetKey}@${positions.get(edge.targetKey)})`, true, {
        edgeId: edge.id,
        sourceId: edge.sourceKey,
        targetId: edge.targetKey,
      });
    }
    if (!adjacency.get(edge.sourceKey).includes(edge.targetKey)) {
      adjacency.get(edge.sourceKey).push(edge.targetKey);
      indegree.set(edge.targetKey, indegree.get(edge.targetKey) + 1);
    }
    undirected.get(edge.sourceKey).add(edge.targetKey);
    undirected.get(edge.targetKey).add(edge.sourceKey);
    structuralEdges.push(edge);
  }

  const roots = nodeIds.filter((id) => indegree.get(id) === 0);
  const queue = [...roots];
  const reachable = new Set();
  while (queue.length) {
    const id = queue.shift();
    if (reachable.has(id)) continue;
    reachable.add(id);
    queue.push(...(adjacency.get(id) ?? []));
  }
  const weakQueue = nodeIds.length ? [nodeIds[0]] : [];
  const weakReachable = new Set();
  while (weakQueue.length) {
    const id = weakQueue.shift();
    if (weakReachable.has(id)) continue;
    weakReachable.add(id);
    weakQueue.push(...(undirected.get(id) ?? []));
  }
  const missingMemberIds = nodeIds.filter((id) => !weakReachable.has(id));
  const connected = nodeIds.length <= 1 || missingMemberIds.length === 0;
  if (nodeIds.length > 1 && !connected) add("disconnected", `Composite Chain has disconnected member(s): ${missingMemberIds.join(", ")}`, false, { roots, missingMemberIds });
  if (nodeIds.length > 1 && structuralEdges.length === 0) add("no_edges", "Composite Chain with multiple members needs an explicit composition Link", false, { roots, missingMemberIds: nodeIds });

  const cycleIndegree = new Map(indegree);
  const cycleQueue = nodeIds.filter((id) => cycleIndegree.get(id) === 0);
  let visited = 0;
  while (cycleQueue.length) {
    const id = cycleQueue.shift();
    visited += 1;
    for (const next of adjacency.get(id) ?? []) {
      cycleIndegree.set(next, cycleIndegree.get(next) - 1);
      if (cycleIndegree.get(next) === 0) cycleQueue.push(next);
    }
  }
  if (structuralEdges.length > 0 && visited < nodeIds.length) {
    add("cycle", "Composite Chain composition Links form a cycle and cannot be ordered", true, {
      cycleMemberIds: nodeIds.filter((id) => cycleIndegree.get(id) > 0),
    });
  }
  return { normalizedNodes, normalizedEdges, nodeIds, positions, roots, reachable, connected, missingMemberIds, issues };
}

/** Return a stable topological order for typed Chain/Block members. */
export function stableCompositionOrder(members = [], edges = []) {
  const topology = topoIssues(members, edges);
  const nodeIds = topology.nodeIds;
  if (new Set(nodeIds).size !== nodeIds.length || nodeIds.some((id) => !id)) return null;
  const originalPosition = new Map(topology.normalizedNodes.map((node, index) => [node.id, Number.isInteger(node.position) ? node.position : index]));
  const indegree = new Map(nodeIds.map((id) => [id, 0]));
  const adjacency = new Map(nodeIds.map((id) => [id, []]));
  for (const edge of topology.normalizedEdges) {
    if (!edge.id || !edge.sourceKey || !edge.targetKey || !indegree.has(edge.sourceKey) || !indegree.has(edge.targetKey) || edge.sourceKey === edge.targetKey) return null;
    if (adjacency.get(edge.sourceKey).includes(edge.targetKey)) continue;
    adjacency.get(edge.sourceKey).push(edge.targetKey);
    indegree.set(edge.targetKey, indegree.get(edge.targetKey) + 1);
  }
  const ready = nodeIds.filter((id) => indegree.get(id) === 0);
  const result = [];
  while (ready.length) {
    ready.sort((left, right) => originalPosition.get(left) - originalPosition.get(right) || left.localeCompare(right));
    const id = ready.shift();
    result.push(id);
    for (const next of adjacency.get(id) ?? []) {
      indegree.set(next, indegree.get(next) - 1);
      if (indegree.get(next) === 0) ready.push(next);
    }
  }
  return result.length === nodeIds.length ? result : null;
}

function memberExists(ref, chains, blocks, parentId) {
  if (!ref) return false;
  if (ref.memberType === "block") return blocks.some((block) => block.id === ref.memberId && !block.archived && block.deliveryState !== "deprecated");
  return ref.memberId !== parentId && chains.some((candidate) => candidate.id === ref.memberId && !candidate.archived);
}

function childStates(members, chains, blocks, parentId = "") {
  return members.map((member) => {
    const ref = memberRef(member);
    const item = ref?.memberType === "chain"
      ? chains.find((candidate) => candidate.id === ref.memberId)
      : blocks.find((candidate) => candidate.id === ref?.memberId);
    return {
      memberType: ref?.memberType ?? null,
      memberId: ref?.memberId ?? null,
      position: positionOf(member, 0),
      role: member.role ?? member.memberRole ?? member.member_role ?? "stage",
      required: member.required !== false && member.required !== 0,
      deliveryState: item?.deliveryState ?? "missing",
      healthState: item?.healthState ?? "unknown",
      title: item?.title ?? ref?.memberId ?? "unknown",
      exists: Boolean(item) && memberExists(ref, chains, blocks, parentId),
    };
  });
}

/** Inspect a Composite Chain without mutating it. */
export function inspectChainComposition({ chain, members = [], edges = [], chains = [], blocks = [], links = [] } = {}) {
  if (!chain?.id) throw new Error("chain is required");
  const memberRefs = members.map((member, index) => ({ ...memberRef(member), position: positionOf(member, index), role: member.role ?? member.memberRole ?? member.member_role ?? "stage", required: member.required !== false && member.required !== 0 }));
  const memberKeys = new Set(memberRefs.map((member) => memberKey(member.memberType, member.memberId)).filter(Boolean));
  const activeChains = chains.filter((candidate) => !candidate.archived);
  const activeBlocks = blocks.filter((block) => !block.archived && block.deliveryState !== "deprecated");
  const missingMembers = memberRefs
    .filter((member) => !memberExists(member, activeChains, activeBlocks, chain.id))
    .map((member) => ({ memberType: member.memberType, memberId: member.memberId }));
  const linkById = new Map(links.filter((link) => !link.archived).map((link) => [link.id, link]));
  const resolvedEdges = edges.map((edge) => ({
    ...edge,
    link: linkById.get(edge.linkId ?? edge.link_id ?? edge.id),
  }));
  const topology = topoIssues(memberRefs, resolvedEdges);
  for (const edge of resolvedEdges) {
    if (!edge.link) {
      topology.issues.push({ code: "missing_link", detail: `Composite Chain edge references missing Link: ${edge.linkId ?? edge.link_id ?? edge.id}`, hard: true, edgeId: edge.linkId ?? edge.link_id ?? edge.id });
      continue;
    }
    const source = endpoint(edge.link, "source");
    const target = endpoint(edge.link, "target");
    if (!source || !target || !memberKeys.has(memberKey(source.memberType, source.memberId)) || !memberKeys.has(memberKey(target.memberType, target.memberId))) {
      // topoIssues reports the same endpoint issue with the normalized edge;
      // this guard keeps the returned edge useful to callers.
      continue;
    }
  }
  const states = childStates(memberRefs, activeChains, activeBlocks, chain.id);
  const incompleteMembers = states.filter((state) => state.required && state.deliveryState !== "complete").map((state) => ({
    memberType: state.memberType,
    memberId: state.memberId,
    deliveryState: state.deliveryState,
  }));
  const complete = missingMembers.length === 0 && topology.issues.length === 0;
  const ready = complete && incompleteMembers.length === 0;
  return {
    chainId: chain.id,
    memberIds: memberRefs.map((member) => memberKey(member.memberType, member.memberId)).filter(Boolean),
    members: memberRefs,
    edges: resolvedEdges.map((edge) => ({ linkId: edge.linkId ?? edge.link_id ?? edge.id, position: edge.position })),
    missingMembers,
    memberStates: states,
    incompleteMembers,
    complete,
    ready,
    topology: {
      ...topology,
      issues: topology.issues,
      orderedMemberIds: stableCompositionOrder(memberRefs, resolvedEdges),
    },
  };
}

/** Detect a parent/child Chain cycle across all Composite Chain memberships. */
export function inspectCompositionCycles(snapshot) {
  const parentByChild = new Map();
  for (const member of snapshot?.chainMembers ?? []) {
    if (member.memberType !== "chain") continue;
    const parents = parentByChild.get(member.memberId) ?? [];
    parents.push(member.chainId);
    parentByChild.set(member.memberId, parents);
  }
  const cycles = [];
  for (const chain of snapshot?.chains ?? []) {
    const visiting = new Set();
    const path = [];
    const visit = (id) => {
      if (visiting.has(id)) {
        const index = path.indexOf(id);
        cycles.push(path.slice(index).concat(id));
        return;
      }
      visiting.add(id);
      path.push(id);
      for (const parent of parentByChild.get(id) ?? []) visit(parent);
      path.pop();
      visiting.delete(id);
    };
    visit(chain.id);
  }
  const unique = new Set();
  return cycles.filter((cycle) => {
    const key = [...cycle].sort().join("|");
    if (unique.has(key)) return false;
    unique.add(key);
    return true;
  });
}

/**
 * Feature-network inspection for Chain overlays.
 *
 * Chain topology answers whether the declared path is a valid DAG.  This
 * module answers a different question: whether the path is missing an
 * already-declared route Block or Link that belongs to the same feature.
 * Import proximity alone is intentionally insufficient evidence.  Automatic
 * expansion is limited to an explicit chain-affinity tag or a strong semantic
 * match plus a route Link touching an existing member.
 */

export const ROUTE_LINK_KINDS = new Set(["flows_to", "calls", "writes", "implements"]);

const STOP_WORDS = new Set([
  "and", "the", "with", "from", "into", "this", "that", "for", "via", "one", "only",
  "path", "flow", "feature", "network", "chain", "project", "system", "service",
  "engine", "manager", "app", "mcp", "contextos",
]);

function terms(value) {
  return new Set(
    String(value ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9:_-]+/g, " ")
      .split(/\s+/)
      .map((item) => item.trim())
      .filter((item) => item.length >= 3 && !STOP_WORDS.has(item)),
  );
}

function chainTerms(chain) {
  return terms([
    chain?.id,
    chain?.title,
    chain?.purpose,
    chain?.intent,
    chain?.inputContract,
    chain?.outputContract,
  ].join(" "));
}

function blockTerms(block) {
  return terms([
    block?.id,
    block?.title,
    block?.summary,
    block?.contract,
    block?.scope,
    ...(Array.isArray(block?.tags) ? block.tags : []),
  ].join(" "));
}

function affinityTags(block) {
  return new Set((Array.isArray(block?.tags) ? block.tags : [])
    .map((tag) => String(tag).trim().toLowerCase())
    .filter(Boolean));
}

function hasAffinityTag(block, chainId) {
  const tags = affinityTags(block);
  const normalizedId = String(chainId).trim().toLowerCase();
  return tags.has(`chain:${normalizedId}`) || tags.has(`chain-affinity:${normalizedId}`);
}

export function isExplicitlyStandalone(block) {
  return [...affinityTags(block)].some((tag) => tag === "standalone" || tag.startsWith("standalone:"));
}

function linkEndpoints(link) {
  if (!link || link.sourceType !== "block" || link.targetType !== "block") return null;
  return { sourceId: link.sourceId, targetId: link.targetId };
}

function scoreCandidate(block, chain, touchingLinks = []) {
  const reasons = [];
  if (hasAffinityTag(block, chain.id)) {
    reasons.push(`explicit chain affinity tag chain:${chain.id}`);
    if (!touchingLinks.length) reasons.push("no declared route Link touches the Chain yet");
    return { score: 1, confidence: "high", reasons };
  }

  const chainSet = chainTerms(chain);
  const blockSet = blockTerms(block);
  const overlap = [...chainSet].filter((term) => blockSet.has(term));
  if (overlap.length) reasons.push(`semantic terms: ${overlap.slice(0, 6).join(", ")}`);
  if (touchingLinks.length) reasons.push(`${touchingLinks.length} declared route Link(s) touch the Chain`);

  // A single generic word is not enough to move a Block.  Require at least
  // two meaningful terms, or one distinctive feature term plus two route
  // links.  This keeps shared infrastructure from being pulled into every
  // feature overlay merely because it says "service" or "project".
  const distinctive = overlap.filter((term) => term.length >= 6);
  const score = Math.min(0.84,
    (distinctive.length >= 2 ? 0.62 : distinctive.length === 1 ? 0.45 : 0) +
    (overlap.length >= 2 ? 0.12 : 0) +
    (touchingLinks.length >= 2 ? 0.15 : touchingLinks.length === 1 ? 0.06 : 0),
  );
  if (score >= 0.72) return { score, confidence: "high", reasons };
  if (score >= 0.52) return { score, confidence: "medium", reasons };
  return { score, confidence: "low", reasons };
}

function chainMembers(nodes = []) {
  return new Set(nodes.map((node) => typeof node === "string" ? node : node?.blockId ?? node?.block_id ?? node?.id).filter(Boolean));
}

function chainEdgeIds(edges = []) {
  return new Set(edges.map((edge) => typeof edge === "string" ? edge : edge?.linkId ?? edge?.link_id ?? edge?.id).filter(Boolean));
}

/**
 * Inspect one Chain against the project's global Block/Link graph.
 * `missingInternalLinks` are route Links whose endpoints are already Chain
 * members but which were never added to chain_edges. `candidateBlocks` are
 * linked neighbors or explicitly affiliated Blocks with enough evidence to
 * consider auto-expansion.
 */
export function inspectChainNetwork({ chain, nodes = [], edges = [], links = [], blocks = [] } = {}) {
  if (!chain?.id) throw new Error("chain is required");
  const memberIds = chainMembers(nodes);
  const edgeIds = chainEdgeIds(edges);
  const activeLinks = links.filter((link) => !link.archived);
  const routeLinks = activeLinks.filter((link) => ROUTE_LINK_KINDS.has(link.kind)).map((link) => ({ link, endpoints: linkEndpoints(link) })).filter((item) => item.endpoints);
  const internalRouteLinks = routeLinks.filter(({ endpoints }) => memberIds.has(endpoints.sourceId) && memberIds.has(endpoints.targetId));
  const missingInternalLinks = internalRouteLinks
    .filter(({ link }) => !edgeIds.has(link.id))
    .map(({ link }) => link);

  const touchingByBlock = new Map();
  for (const { link, endpoints } of routeLinks) {
    const sourceMember = memberIds.has(endpoints.sourceId);
    const targetMember = memberIds.has(endpoints.targetId);
    if (sourceMember === targetMember) continue;
    const candidateId = sourceMember ? endpoints.targetId : endpoints.sourceId;
    const values = touchingByBlock.get(candidateId) ?? [];
    values.push(link);
    touchingByBlock.set(candidateId, values);
  }
  const blockById = new Map(blocks.map((block) => [block.id, block]));
  const candidateBlockIds = new Set(touchingByBlock.keys());
  // An explicit affinity tag is useful evidence even before the route Link is
  // written. Keep that Block visible as an actionable membership gap instead
  // of silently treating it as a normal unassigned node.
  for (const block of blocks) {
    if (!memberIds.has(block.id) && !block.archived && block.deliveryState !== "deprecated" && hasAffinityTag(block, chain.id)) {
      candidateBlockIds.add(block.id);
    }
  }
  const candidateBlocks = [...candidateBlockIds]
    .map((blockId) => {
      const touchingLinks = touchingByBlock.get(blockId) ?? [];
      const block = blockById.get(blockId);
      if (!block || memberIds.has(blockId) || block.archived || block.deliveryState === "deprecated") return null;
      const affinity = scoreCandidate(block, chain, touchingLinks);
      const autoExpandable = affinity.confidence === "high" && touchingLinks.length > 0;
      return {
        blockId,
        title: block.title,
        scope: block.scope,
        linkIds: touchingLinks.map((link) => link.id),
        ...affinity,
        autoExpandable,
        requiresRouteLink: affinity.confidence === "high" && touchingLinks.length === 0,
      };
    })
    .filter(Boolean)
    .sort((left, right) => right.score - left.score || left.blockId.localeCompare(right.blockId));

  const autoExpandIds = new Set(candidateBlocks.filter((candidate) => candidate.autoExpandable).map((candidate) => candidate.blockId));
  const expansionLinks = routeLinks
    .filter(({ endpoints }) => {
      const sourceMember = memberIds.has(endpoints.sourceId) || autoExpandIds.has(endpoints.sourceId);
      const targetMember = memberIds.has(endpoints.targetId) || autoExpandIds.has(endpoints.targetId);
      return sourceMember && targetMember;
    })
    .map(({ link }) => link)
    .filter((link) => !edgeIds.has(link.id));

  const backwardInternalLinks = missingInternalLinks.filter((link) => {
    const source = nodes.find((node) => (node.blockId ?? node.block_id ?? node.id) === link.sourceId);
    const target = nodes.find((node) => (node.blockId ?? node.block_id ?? node.id) === link.targetId);
    if (!source || !target) return false;
    const sourcePosition = Number.isInteger(source.position) ? source.position : nodes.indexOf(source);
    const targetPosition = Number.isInteger(target.position) ? target.position : nodes.indexOf(target);
    return sourcePosition >= targetPosition;
  });

  return {
    chainId: chain.id,
    memberIds: [...memberIds],
    internalRouteLinks: internalRouteLinks.map(({ link }) => link.id),
    missingInternalLinks,
    backwardInternalLinks,
    candidateBlocks,
    autoExpandBlockIds: [...autoExpandIds],
    expansionLinks,
    complete: missingInternalLinks.length === 0 && candidateBlocks.every((candidate) => !candidate.autoExpandable && !candidate.requiresRouteLink),
  };
}

/** Inspect every active Chain in a project snapshot without mutating it. */
export function inspectProjectNetworks(snapshot) {
  const reports = (snapshot?.chains ?? []).map((chain) => {
    const nodes = (snapshot.chainNodes ?? []).filter((node) => node.chainId === chain.id).sort((left, right) => left.position - right.position);
    const edges = (snapshot.chainEdges ?? []).filter((edge) => edge.chainId === chain.id).sort((left, right) => left.position - right.position);
    return inspectChainNetwork({ chain, nodes, edges, links: snapshot.links ?? [], blocks: snapshot.blocks ?? [] });
  });
  const chainIdsByBlock = new Map();
  for (const node of snapshot.chainNodes ?? []) {
    const values = chainIdsByBlock.get(node.blockId) ?? [];
    values.push(node.chainId);
    chainIdsByBlock.set(node.blockId, values);
  }
  const membershipGapBlockIds = new Set(reports.flatMap((report) => report.candidateBlocks
    .filter((candidate) => candidate.requiresRouteLink)
    .map((candidate) => candidate.blockId)));
  const unassignedBlocks = (snapshot.blocks ?? [])
    .filter((block) => block.kind !== "decision" && block.deliveryState !== "deprecated" && !chainIdsByBlock.has(block.id) && !membershipGapBlockIds.has(block.id) && !isExplicitlyStandalone(block))
    .map((block) => ({ id: block.id, title: block.title, kind: block.kind, scope: block.scope, deliveryState: block.deliveryState }));
  const standaloneBlocks = (snapshot.blocks ?? [])
    .filter((block) => block.kind !== "decision" && block.deliveryState !== "deprecated" && !chainIdsByBlock.has(block.id) && isExplicitlyStandalone(block))
    .map((block) => ({ id: block.id, title: block.title, kind: block.kind, scope: block.scope, deliveryState: block.deliveryState }));
  return {
    chains: reports,
    unassignedBlocks,
    standaloneBlocks,
    missingInternalLinks: reports.flatMap((report) => report.missingInternalLinks.map((link) => ({ chainId: report.chainId, linkId: link.id, sourceId: link.sourceId, targetId: link.targetId, kind: link.kind }))),
    autoExpandCandidates: reports.flatMap((report) => report.candidateBlocks.filter((candidate) => candidate.autoExpandable).map((candidate) => ({ chainId: report.chainId, ...candidate }))),
    membershipGaps: reports.flatMap((report) => report.candidateBlocks.filter((candidate) => candidate.requiresRouteLink).map((candidate) => ({ chainId: report.chainId, ...candidate }))),
  };
}

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import { detectLanguage, extractSymbols } from './ast.mjs';
import { transaction, getSyncMeta, setSyncMeta } from './database.mjs';
import { executeMutate } from './mutation-engine.mjs';
import { inspectChainTopology, stableChainOrder, topologyIssueText } from './chain-topology.mjs';
import { inspectChainNetwork } from './chain-network.mjs';
import { inspectChainComposition } from './chain-composition.mjs';

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const ignored = new Set(['.git','.contextos','node_modules','.build','build','dist','coverage','.next','release-assets']);
const extensions = new Set(['.js','.mjs','.cjs','.ts','.tsx','.jsx','.swift','.py','.go','.rs','.java','.kt','.kts','.c','.cc','.cpp','.h','.hpp']);
export function sourceInventory(root, { fileCache = null } = {}) {
  const files = [];
  const listing = spawnSync('git',['ls-files','-z','--cached','--others','--exclude-standard'],{cwd:root,encoding:'utf8',maxBuffer:20_000_000,timeout:5000});
  const included = listing.status === 0 ? new Set(listing.stdout.split('\0')) : null;
  const visit = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes:true }).sort((a,b)=>a.name.localeCompare(b.name))) {
      if (ignored.has(entry.name) || entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
      const absolute = path.join(dir,entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if ((!included || included.has(path.relative(root,absolute).split(path.sep).join('/'))) && extensions.has(path.extname(entry.name)) && !absolute.endsWith('plugins/contextos/server/contextos-mcp.mjs')) {
        const relativePath = path.relative(root,absolute).split(path.sep).join('/');
        let content;
        let cached = false;
        let signature;
        try {
          const stat = fs.statSync(absolute);
          signature = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
          const previous = fileCache?.get(relativePath);
          if (previous?.signature === signature && previous.status === 'readable' && typeof previous.content === 'string') {
            content = previous.content;
            cached = true;
          } else {
            content = fs.readFileSync(absolute,'utf8');
          }
        } catch {
          return;
        }
        const fileHash = hash(content);
        fileCache?.set(relativePath, {
          ...(fileCache?.get(relativePath) ?? {}),
          absolutePath: absolute,
          relativePath,
          status: 'readable',
          language: detectLanguage(relativePath),
          lineCount: content.split(/\r?\n/).length,
          signature,
          content,
          fileHash,
          hash: fileHash,
        });
        files.push({ path:relativePath, hash:fileHash, content, cached });
      }
    }
  };
  visit(root);
  return files;
}
export function indexSources(service) {
  const inventory = sourceInventory(service.paths.projectRoot, { fileCache: service.sourceFileCache });
  const db = service.database;
  return transaction(db,()=>{
  const old = new Map(db.prepare('SELECT * FROM source_index').all().map(r=>[r.path,r]));
  let revision = Number(getSyncMeta(db).repository_source_revision ?? 0);
  const changes = inventory.filter(f=>old.get(f.path)?.file_hash!==f.hash).map(f=>({ ...f,kind:old.has(f.path)?'changed':'added' }));
  const names = new Set(inventory.map(f=>f.path));
  for (const [name] of old) if (!names.has(name)) changes.push({path:name,kind:'removed'});
  if (changes.length) {
    revision++;
    {
      const now = new Date().toISOString();
      for (const item of changes) {
        if (item.kind==='removed') db.prepare('DELETE FROM source_index WHERE path=?').run(item.path);
        else {
          const symbols = extractSymbols(item.content,{filePath:item.path});
          db.prepare('INSERT INTO source_index VALUES(?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET file_hash=excluded.file_hash,symbols_json=excluded.symbols_json,revision=excluded.revision,supported=excluded.supported')
            .run(item.path,item.hash,JSON.stringify(symbols.map(({name,qualifiedName,startLine,endLine})=>({name:qualifiedName??name,startLine,endLine}))),revision,Number(symbols.length>0));
        }
        db.prepare('INSERT INTO sync_events(path,kind,revision,created_at) VALUES(?,?,?,?)').run(item.path,item.kind,revision,now);
      }
      setSyncMeta(db,'repository_source_revision',String(revision));
    }
  }
  const boundPaths = new Set(db.prepare('SELECT DISTINCT path FROM source_refs').all().map(r=>r.path));
  const unboundFiles = inventory.filter(f=>!boundPaths.has(f.path)).map(f=>f.path);
  return { revision, sourceRevision:hash(inventory.map(f=>`${f.path}:${f.hash}`).join('\n')), files:inventory.length,
    cachedFiles:inventory.filter((file) => file.cached).length,
    filesRead:inventory.filter((file) => !file.cached).length,
    unboundCount:unboundFiles.length, unboundFiles:unboundFiles.slice(0,30),
    changes:changes.map(({path,kind})=>({path,kind})) };
  });
}
function session(service,id) {
  const row = service.database.prepare('SELECT * FROM task_sessions WHERE id=? AND project_id=?').get(id,service.paths.descriptor.id);
  if (!row) throw new Error(`Task session not found: ${id}`);
  return {...row,scope:JSON.parse(row.scope_json)};
}

const SOURCE_BACKED_KINDS = new Set(['flow','ui','service','function','integration','api','data','database']);
const INVALID_BINDINGS = new Set(['missing','ambiguous','stale','unreadable','outside_project','line_only']);

function unique(values = []) {
  return [...new Set(values.filter(Boolean))];
}

function chainBlockIds(snapshot, chainId, visiting = new Set()) {
  if (!chainId || visiting.has(chainId)) return [];
  const nextVisiting = new Set(visiting);
  nextVisiting.add(chainId);
  const result = [];
  for (const node of (snapshot.chainNodes ?? [])
    .filter((item) => item.chainId === chainId)
    .sort((left, right) => left.position - right.position || left.blockId.localeCompare(right.blockId))) {
    if (!result.includes(node.blockId)) result.push(node.blockId);
  }
  for (const member of (snapshot.chainMembers ?? [])
    .filter((item) => item.chainId === chainId)
    .sort((left, right) => left.position - right.position || left.memberType.localeCompare(right.memberType) || left.memberId.localeCompare(right.memberId))) {
    if (member.memberType === "block") {
      if (!result.includes(member.memberId)) result.push(member.memberId);
    } else {
      for (const blockId of chainBlockIds(snapshot, member.memberId, nextVisiting)) {
        if (!result.includes(blockId)) result.push(blockId);
      }
    }
  }
  return result;
}

function planForTask(service, planId) {
  if (!planId) return null;
  const plan = service.snapshot().plans.find((item) => item.id === planId);
  if (!plan) throw new Error(`plan:${planId} not found`);
  return plan;
}

/**
 * Reconcile the macro route of Composite Chains. A parent only exposes typed
 * Chain/Block members; child delivery and topology remain owned by the child.
 */
export function reconcileChainComposition(service, { chainId = null, autoReorder = true, reason = 'Reconcile Composite Chain composition' } = {}) {
  let snapshot = service.snapshot();
  const chains = chainId ? snapshot.chains.filter((chain) => chain.id === chainId) : snapshot.chains;
  const reports = [];
  const changedChainIds = [];
  if (chainId && !chains.length) {
    return { changed: false, changedChainIds, reports: [{ chainId, issues: [{ code: 'missing_chain', detail: `Chain not found: ${chainId}` }] }], graphRevision: service.project().graph_revision };
  }
  for (const chain of chains.filter((candidate) => candidate.chainType === 'composite')) {
    let members = snapshot.chainMembers.filter((member) => member.chainId === chain.id)
      .sort((left, right) => left.position - right.position || left.memberType.localeCompare(right.memberType) || left.memberId.localeCompare(right.memberId));
    let edges = snapshot.chainEdges.filter((edge) => edge.chainId === chain.id)
      .sort((left, right) => left.position - right.position || left.linkId.localeCompare(right.linkId));
    let composition = inspectChainComposition({ chain, members, edges, chains: snapshot.chains, blocks: snapshot.blocks, links: snapshot.links });
    const currentOrder = members.map((member) => `${member.memberType}:${member.memberId}`);
    const ordered = composition.topology.orderedMemberIds;
    let changed = false;
    const hardIssues = composition.topology.issues.filter((issue) => issue.hard);
    if (autoReorder && ordered && hardIssues.length === 0 && ordered.join('\u0000') !== currentOrder.join('\u0000')) {
      try {
        const memberById = new Map(members.map((member) => [`${member.memberType}:${member.memberId}`, member]));
        service.mutate({
          reason,
          task: 'chain-compose-reconcile',
          operations: [{
            action: 'set_chain_composition',
            id: chain.id,
            expectedRevision: chain.currentRevision,
            fields: {
              memberRefs: ordered.map((id) => {
                const member = memberById.get(id);
                return { memberType: member.memberType, memberId: member.memberId, role: member.role, required: member.required };
              }),
              linkIds: edges.map((edge) => edge.linkId),
            },
          }],
        });
        changed = true;
        changedChainIds.push(chain.id);
        snapshot = service.snapshot();
        members = snapshot.chainMembers.filter((member) => member.chainId === chain.id).sort((left, right) => left.position - right.position);
        edges = snapshot.chainEdges.filter((edge) => edge.chainId === chain.id).sort((left, right) => left.position - right.position);
        composition = inspectChainComposition({ chain: snapshot.chains.find((candidate) => candidate.id === chain.id) ?? chain, members, edges, chains: snapshot.chains, blocks: snapshot.blocks, links: snapshot.links });
      } catch (error) {
        composition.topology.issues.push({ code: 'reorder_failed', detail: error.message, hard: true });
      }
    }
    const currentChain = snapshot.chains.find((candidate) => candidate.id === chain.id) ?? chain;
    if (currentChain.deliveryState === 'complete' && !composition.ready) {
      try {
        service.mutate({
          reason: 'Reopen Composite Chain after child composition drift',
          task: 'chain-compose-reconcile',
          operations: [{
            action: 'update_chain', id: chain.id, expectedRevision: currentChain.currentRevision,
            fields: { deliveryState: 'implementing', healthState: 'warning' },
            summary: 'Reopened after Composite Chain member drift',
          }],
        });
        changed = true;
        if (!changedChainIds.includes(chain.id)) changedChainIds.push(chain.id);
      } catch (error) {
        composition.topology.issues.push({ code: 'state_reopen_failed', detail: error.message, hard: true });
      }
    }
    reports.push({
      chainId: chain.id,
      complete: composition.complete,
      ready: composition.ready,
      changed,
      memberCount: members.length,
      edgeCount: edges.length,
      composition,
      issues: [
        ...composition.topology.issues,
        ...composition.incompleteMembers.map((member) => ({
          code: 'incomplete_member',
          detail: `Required ${member.memberType}:${member.memberId} is ${member.deliveryState}`,
          memberType: member.memberType,
          memberId: member.memberId,
        })),
      ],
    });
  }
  return { changed: changedChainIds.length > 0, changedChainIds, reports, graphRevision: service.project().graph_revision };
}

/**
 * Make the Plan describe the task's actual architecture without replacing
 * entries another conversation may have added. This is intentionally
 * idempotent: a resumed task sees the existing canonical entity keys and
 * appends nothing twice.
 */
export function ensurePlanCoverage(service, { planId, chainId = null, blockIds = [], readOnly = false, reason = 'Sync task scope into Plan' } = {}) {
  if (!planId || readOnly) return { planId: planId ?? null, appendedChangeIds: [], chainScopeId: null, changed: false };
  let snapshot = service.snapshot();
  let plan = planForTask(service, planId);
  const scopedChain = chainId ? snapshot.chains.find((item) => item.id === chainId) : null;
  const targetBlockIds = unique([
    ...blockIds,
    ...(scopedChain?.chainType === "composite" ? chainBlockIds(snapshot, chainId) : []),
  ]);
  const targetLinkIds = chainId
    ? unique(snapshot.chainEdges.filter((edge) => edge.chainId === chainId).map((edge) => edge.linkId))
    : [];
  const entityKeys = new Set(snapshot.planChanges.filter((change) => change.planId === planId).map((change) => `${change.entityType}:${change.entityId}`));
  const changes = [];
  for (const blockId of targetBlockIds) {
    const block = snapshot.blocks.find((item) => item.id === blockId);
    if (!block || entityKeys.has(`block:${blockId}`)) continue;
    changes.push({
      entityType: 'block', entityId: blockId, title: `Implement ${block.title}`,
      summary: block.summary, proposedBehavior: block.contract || block.summary,
      rationale: 'Task scope is part of this Plan', status: 'active',
    });
    entityKeys.add(`block:${blockId}`);
  }
  if (chainId) {
    const chain = snapshot.chains.find((item) => item.id === chainId);
    if (chain && !entityKeys.has(`chain:${chainId}`)) {
      changes.push({
        entityType: 'chain', entityId: chainId, title: `Deliver ${chain.title}`,
        summary: chain.intent, proposedBehavior: chain.outputContract,
        rationale: 'Feature path is part of this Plan', status: 'active',
      });
      entityKeys.add(`chain:${chainId}`);
    }
  }
  for (const linkId of targetLinkIds) {
    const link = snapshot.links.find((item) => item.id === linkId);
    if (!link || entityKeys.has(`link:${linkId}`)) continue;
    changes.push({
      entityType: 'link', entityId: linkId, title: link.label || `Connect ${link.sourceId} to ${link.targetId}`,
      summary: link.contract, proposedBehavior: link.contract,
      rationale: 'Explicit feature path relationship', status: 'active',
    });
    entityKeys.add(`link:${linkId}`);
  }
  const appendedChangeIds = [];
  for (let offset = 0; offset < changes.length; offset += 20) {
    const batch = changes.slice(offset, offset + 20);
    if (!batch.length) continue;
    const result = service.appendPlanChanges({ planId, expectedRevision: plan.currentRevision, changes: batch, reason });
    appendedChangeIds.push(...batch.map((change) => change.id ?? `${planId}-change-${change.entityType}-${change.entityId}`));
    snapshot = service.snapshot();
    plan = planForTask(service, planId);
  }

  snapshot = service.snapshot();
  plan = planForTask(service, planId);
  let scope = chainId ? snapshot.planChainScopes.find((item) => item.planId === planId && item.chainId === chainId) : null;
  const chain = chainId ? snapshot.chains.find((item) => item.id === chainId) : null;
  if (chain && chain.deliveryState !== 'complete') {
    const targetKeys = new Set([
      ...targetBlockIds
        .filter((blockId) => snapshot.blocks.find((item) => item.id === blockId)?.deliveryState !== 'complete')
        .map((blockId) => `block:${blockId}`),
      `chain:${chainId}`,
      ...snapshot.chainEdges
        .filter((edge) => edge.chainId === chainId)
        .map((edge) => `link:${edge.linkId}`),
    ]);
    const reopened = snapshot.planChanges
      .filter((change) => targetKeys.has(`${change.entityType}:${change.entityId}`))
      .filter((change) => ['complete', 'skipped'].includes(change.status))
      .map((change) => ({ changeId: change.id, patch: { status: 'active' } }));
    if (reopened.length) {
      service.mutate({
        planId,
        reason: 'Reopen Plan coverage after feature Chain expansion',
        task: 'plan-sync',
        operations: [{ action: 'update_plan_changes', id: planId, expectedRevision: plan.currentRevision, fields: { updates: reopened } }],
      });
      snapshot = service.snapshot();
      plan = planForTask(service, planId);
    }
  }
  if (chain) {
    const nodeIds = chain.chainType === "composite"
      ? chainBlockIds(snapshot, chainId)
      : snapshot.chainNodes.filter((item) => item.chainId === chainId).sort((a, b) => a.position - b.position).map((item) => item.blockId);
    const linkIds = snapshot.chainEdges.filter((item) => item.chainId === chainId).sort((a, b) => a.position - b.position).map((item) => item.linkId);
    if (!scope) {
      const result = service.appendPlanChainScope({
        planId,
        expectedRevision: plan.currentRevision,
        scope: {
          title: `Feature path: ${chain.title}`,
          summary: chain.intent,
          rationale: 'Task feature network is part of this Plan',
          chainId, nodeIds, linkIds,
          startBlockId: nodeIds[0] ?? undefined, endBlockId: nodeIds.at(-1) ?? undefined, status: 'active',
        },
        reason,
      });
      scope = service.snapshot().planChainScopes.find((item) => item.planId === planId && item.chainId === chainId) ?? null;
    } else if (JSON.stringify(scope.nodeIds) !== JSON.stringify(nodeIds) || JSON.stringify(scope.linkIds) !== JSON.stringify(linkIds)) {
      service.mutate({
        planId,
        reason: 'Refresh Plan ChainScope after Chain append',
        task: 'plan-sync',
        operations: [{
          action: 'update_plan_chain_scope', id: planId, expectedRevision: plan.currentRevision,
          fields: { scopeId: scope.id, patch: {
            nodeIds, linkIds, startBlockId: nodeIds[0] ?? null, endBlockId: nodeIds.at(-1) ?? null,
          } },
        }],
      });
      scope = service.snapshot().planChainScopes.find((item) => item.id === scope.id) ?? scope;
    }
  }
  return { planId, appendedChangeIds, chainScopeId: scope?.id ?? null, changed: appendedChangeIds.length > 0 || Boolean(scope) };
}

/**
 * Reconcile a Chain with the global feature network.  This is deliberately
 * separate from topology ordering: a valid DAG may still omit a related
 * Block or a route Link.  Only explicit chain-affinity tags or strong
 * semantic candidates with a declared route Link are auto-expanded.
 */
function reconcileChainNetworkPass(service, {
  chainId = null,
  autoExpand = false,
  autoReorder = false,
  reason = 'Reconcile Chain feature network',
} = {}) {
  let snapshot = service.snapshot();
  const chains = chainId ? snapshot.chains.filter((chain) => chain.id === chainId) : snapshot.chains;
  const reports = [];
  const changedChainIds = [];
  if (chainId && !chains.length) {
    return {
      changed: false,
      changedChainIds,
      reports: [{ chainId, issues: [{ code: 'missing_chain', detail: `Chain not found: ${chainId}` }] }],
      graphRevision: service.project().graph_revision,
    };
  }

  for (const chain of chains) {
    if (chain.chainType === 'composite') continue;
    const currentNodes = snapshot.chainNodes
      .filter((node) => node.chainId === chain.id)
      .sort((left, right) => left.position - right.position || left.blockId.localeCompare(right.blockId));
    const currentEdges = snapshot.chainEdges
      .filter((edge) => edge.chainId === chain.id)
      .sort((left, right) => left.position - right.position || left.linkId.localeCompare(right.linkId));
    const network = inspectChainNetwork({
      chain,
      nodes: currentNodes,
      edges: currentEdges,
      links: snapshot.links,
      blocks: snapshot.blocks,
    });
    const currentNodeIds = currentNodes.map((node) => node.blockId);
    const currentEdgeIds = currentEdges.map((edge) => edge.linkId);
    const candidateNodeIds = autoExpand ? network.autoExpandBlockIds : [];
    const finalNodeIds = [...currentNodeIds, ...candidateNodeIds.filter((id) => !currentNodeIds.includes(id))];
    const selectedLinkIds = [...currentEdgeIds];
    const skippedLinkIds = [];

    // Add route Links one at a time.  Rechecking the DAG after each addition
    // prevents an interaction/feedback edge from turning a feature Chain
    // into a cycle.  Such Links stay global and are reported for review.
    const candidateLinks = (autoExpand ? network.expansionLinks : [])
      .filter((link) => !selectedLinkIds.includes(link.id))
      .sort((left, right) => left.id.localeCompare(right.id));
    for (const link of candidateLinks) {
      const trialLinkIds = [...selectedLinkIds, link.id];
      const trialLinks = trialLinkIds
        .map((id) => snapshot.links.find((item) => item.id === id))
        .filter(Boolean)
        .map((item, position) => ({
          linkId: item.id,
          sourceId: item.sourceId,
          targetId: item.targetId,
          position,
        }));
      const trialNodes = finalNodeIds.map((id, position) => ({ blockId: id, position }));
      if (!stableChainOrder(trialNodes, trialLinks)) {
        skippedLinkIds.push(link.id);
        continue;
      }
      selectedLinkIds.push(link.id);
    }

    const orderedNodes = stableChainOrder(
      finalNodeIds.map((id, position) => ({ blockId: id, position })),
      selectedLinkIds
        .map((id) => snapshot.links.find((item) => item.id === id))
        .filter(Boolean)
        .map((item, position) => ({ linkId: item.id, sourceId: item.sourceId, targetId: item.targetId, position })),
    );
    const orderedLinks = selectedLinkIds;
    const finalTopology = orderedNodes
      ? inspectChainTopology({
        nodes: orderedNodes.map((id, position) => ({ blockId: id, position })),
        edges: orderedLinks
          .map((id) => snapshot.links.find((item) => item.id === id))
          .filter(Boolean)
          .map((item, position) => ({ linkId: item.id, sourceId: item.sourceId, targetId: item.targetId, position })),
      })
      : null;
    const hardIssues = finalTopology?.issues.filter((issue) => issue.hard) ?? [{ code: 'unorderable', detail: 'Feature network cannot be topologically ordered' }];
    const disconnected = finalTopology?.issues.filter((issue) => issue.code === 'disconnected' || issue.code === 'no_edges') ?? [];
    const nodeChanged = JSON.stringify(orderedNodes ?? currentNodeIds) !== JSON.stringify(currentNodeIds);
    const linkChanged = JSON.stringify(orderedLinks) !== JSON.stringify(currentEdgeIds);
    // Network inspection is the default boundary operation. Apply a
    // membership/order change only when the caller explicitly opts into the
    // corresponding repair pass; reporting a canonical order must not mutate
    // a Chain behind the caller's back.
    const canApply = (autoExpand || autoReorder)
      && Boolean(orderedNodes)
      && hardIssues.length === 0
      && disconnected.length === 0
      && (nodeChanged || linkChanged);
    let mutation = null;
    if (canApply) {
      try {
        const operations = [{
          action: 'set_chain_path',
          id: chain.id,
          expectedRevision: chain.currentRevision,
          fields: { nodeIds: orderedNodes, linkIds: orderedLinks },
        }];
        if (chain.deliveryState === 'complete') {
          operations.push({
            action: 'update_chain',
            id: chain.id,
            expectedRevision: chain.currentRevision + 1,
            fields: { deliveryState: 'implementing', healthState: 'warning' },
            summary: 'Reopened after feature network reconciliation',
          });
        }
        mutation = service.mutate({ reason, task: 'chain-network-reconcile', operations });
        changedChainIds.push(chain.id);
        snapshot = service.snapshot();
      } catch (error) {
        hardIssues.push({ code: 'mutation_failed', detail: error.message });
      }
    }
    const reportChain = mutation
      ? snapshot.chains.find((item) => item.id === chain.id) ?? chain
      : chain;
    const reportNodes = snapshot.chainNodes
      .filter((node) => node.chainId === chain.id)
      .sort((left, right) => left.position - right.position || left.blockId.localeCompare(right.blockId));
    const reportEdges = snapshot.chainEdges
      .filter((edge) => edge.chainId === chain.id)
      .sort((left, right) => left.position - right.position || left.linkId.localeCompare(right.linkId));
    const reportNetwork = inspectChainNetwork({
      chain: reportChain,
      nodes: reportNodes,
      edges: reportEdges,
      links: snapshot.links,
      blocks: snapshot.blocks,
    });
    const affinityGaps = reportNetwork.candidateBlocks.filter((candidate) => candidate.requiresRouteLink);
    reports.push({
      chainId: chain.id,
      complete: reportNetwork.complete,
      candidateBlocks: reportNetwork.candidateBlocks,
      autoExpandedBlockIds: canApply ? candidateNodeIds : [],
      missingInternalLinks: reportNetwork.missingInternalLinks,
      backwardInternalLinks: reportNetwork.backwardInternalLinks,
      addedLinkIds: canApply ? orderedLinks.filter((id) => !currentEdgeIds.includes(id)) : [],
      skippedLinkIds,
      changed: Boolean(mutation),
      issues: [
        ...(hardIssues.length ? hardIssues : []),
        ...(disconnected.length ? disconnected : []),
        ...(skippedLinkIds.length ? [{ code: 'deferred_cycle_or_feedback', detail: `Deferred Link(s) to preserve DAG: ${skippedLinkIds.join(', ')}` }] : []),
        ...affinityGaps.map((candidate) => ({
          code: 'affinity_missing_route',
          detail: `Block ${candidate.blockId} declares affinity for chain:${chain.id} but has no explicit route Link touching the Chain`,
          blockId: candidate.blockId,
        })),
      ],
    });
  }
  return {
    changed: changedChainIds.length > 0,
    changedChainIds,
    reports,
    graphRevision: service.project().graph_revision,
  };
}

/**
 * Run the membership/order pass to a fixed point. A newly attached Block can
 * expose another affiliated Block through a second route Link, so one pass is
 * insufficient for a long feature path. The bounded loop keeps the operation
 * idempotent while preserving the pass-level cycle guard.
 */
export function reconcileChainNetwork(service, options = {}) {
  const aggregate = new Map();
  const changedChainIds = new Set();
  let changed = false;
  let graphRevision = service.project().graph_revision;
  const compositionResult = reconcileChainComposition(service, options);
  changed = compositionResult.changed;
  compositionResult.changedChainIds.forEach((id) => changedChainIds.add(id));
  for (const report of compositionResult.reports ?? []) {
    aggregate.set(report.chainId, {
      chainId: report.chainId,
      autoExpandedBlockIds: new Set(),
      addedLinkIds: new Set(),
      skippedLinkIds: new Set(),
      issues: [...(report.issues ?? [])],
      complete: report.complete,
      ready: report.ready,
      composition: report.composition,
      memberCount: report.memberCount,
      edgeCount: report.edgeCount,
      changed: report.changed,
      passes: 1,
    });
  }
  const maxPasses = 16;
  let passes = 0;
  let converged = false;
  for (let pass = 0; pass < maxPasses; pass += 1) {
    passes = pass + 1;
    const revisionBefore = service.project().graph_revision;
    const result = reconcileChainNetworkPass(service, options);
    graphRevision = result.graphRevision;
    changed = changed || result.changed;
    result.changedChainIds.forEach((id) => changedChainIds.add(id));
    for (const report of result.reports) {
      const current = aggregate.get(report.chainId) ?? {
        chainId: report.chainId,
        autoExpandedBlockIds: new Set(),
        addedLinkIds: new Set(),
        skippedLinkIds: new Set(),
        issues: [],
      };
      (report.autoExpandedBlockIds ?? []).forEach((id) => current.autoExpandedBlockIds.add(id));
      (report.addedLinkIds ?? []).forEach((id) => current.addedLinkIds.add(id));
      (report.skippedLinkIds ?? []).forEach((id) => current.skippedLinkIds.add(id));
      for (const issue of report.issues ?? []) {
        const key = issue.code + '|' + issue.detail;
        if (!current.issues.some((item) => item.code + '|' + item.detail === key)) current.issues.push(issue);
      }
      current.complete = report.complete;
      current.candidateBlocks = report.candidateBlocks;
      current.missingInternalLinks = report.missingInternalLinks;
      current.backwardInternalLinks = report.backwardInternalLinks;
      current.passes = pass + 1;
      current.changed = current.changed || report.changed;
      aggregate.set(report.chainId, current);
    }
    if (!result.changed || graphRevision === revisionBefore) {
      converged = true;
      break;
    }
  }
  if (!converged) {
    for (const current of aggregate.values()) {
      current.complete = false;
      const detail = `Chain network reconciliation reached the ${maxPasses}-pass safety limit`;
      if (!current.issues.some((issue) => issue.code === "max_passes")) {
        current.issues.push({ code: "max_passes", detail });
      }
      current.passes = passes;
    }
  }
  const reports = [...aggregate.values()].map((report) => ({
    ...report,
    autoExpandedBlockIds: [...report.autoExpandedBlockIds],
    addedLinkIds: [...report.addedLinkIds],
    skippedLinkIds: [...report.skippedLinkIds],
  }));
  return { changed, changedChainIds: [...changedChainIds], reports, composition: compositionResult, graphRevision };
}

/**
 * Reconcile the declared order of one or all Chains with their explicit Link
 * network. Safe DAGs are reordered without changing membership or Links;
 * cycles, backward edges and disconnected components remain visible issues.
 */
export function reconcileChainTopology(service, { chainId = null, autoReorder = false, reason = 'Inspect Chain topology' } = {}) {
  let snapshot = service.snapshot();
  const chains = chainId ? snapshot.chains.filter((chain) => chain.id === chainId) : snapshot.chains;
  const changedChainIds = [];
  const issues = [];
  if (chainId && !chains.length) {
    return {
      changed: false,
      changedChainIds,
      issues: [{ chainId, code: 'missing_chain', detail: `Chain not found: ${chainId}` }],
      graphRevision: service.project().graph_revision,
    };
  }
  for (const chain of chains) {
    if (chain.chainType === 'composite') continue;
    const nodeRows = snapshot.chainNodes
      .filter((node) => node.chainId === chain.id)
      .sort((left, right) => left.position - right.position || left.blockId.localeCompare(right.blockId));
    const edgeRows = snapshot.chainEdges
      .filter((edge) => edge.chainId === chain.id)
      .sort((left, right) => left.position - right.position || left.linkId.localeCompare(right.linkId));
    const edgeInputs = edgeRows.map((edge) => {
      const link = snapshot.links.find((item) => item.id === edge.linkId);
      return link
        ? { linkId: edge.linkId, position: edge.position, sourceId: link.sourceId, targetId: link.targetId }
        : { linkId: edge.linkId, position: edge.position };
    });
    let topology = inspectChainTopology({ nodes: nodeRows, edges: edgeInputs });
    const hardIssues = topology.issues.filter((issue) => issue.hard);
    const reorderableIssues = new Set(['backward_edge', 'position_gap', 'duplicate_position']);
    const irreparableIssues = hardIssues.filter((issue) => !reorderableIssues.has(issue.code));
    if (irreparableIssues.length) {
      issues.push({ chainId: chain.id, code: 'invalid', detail: topologyIssueText(chain.id, { issues: irreparableIssues }), issues: irreparableIssues });
      continue;
    }
    if (!autoReorder && hardIssues.length) {
      issues.push({ chainId: chain.id, code: 'needs_reorder', detail: topologyIssueText(chain.id, { issues: hardIssues }), issues: hardIssues });
      continue;
    }
    const canonicalOrder = stableChainOrder(nodeRows, edgeInputs);
    const currentOrder = nodeRows.map((node) => node.blockId);
    const needsPositionRewrite = topology.issues.some((issue) => ['position_gap', 'duplicate_position'].includes(issue.code));
    if (autoReorder && canonicalOrder && (canonicalOrder.join('\u0000') !== currentOrder.join('\u0000') || needsPositionRewrite)) {
      try {
        service.mutate({
          reason,
          task: 'chain-reconcile',
          operations: [{
            action: 'set_chain_path',
            id: chain.id,
            expectedRevision: chain.currentRevision,
            fields: { nodeIds: canonicalOrder, linkIds: edgeRows.map((edge) => edge.linkId) },
          }],
        });
        changedChainIds.push(chain.id);
        snapshot = service.snapshot();
        const updatedNodes = snapshot.chainNodes.filter((node) => node.chainId === chain.id).sort((left, right) => left.position - right.position);
        const updatedEdges = snapshot.chainEdges.filter((edge) => edge.chainId === chain.id).sort((left, right) => left.position - right.position).map((edge) => {
          const link = snapshot.links.find((item) => item.id === edge.linkId);
          return link
            ? { linkId: edge.linkId, position: edge.position, sourceId: link.sourceId, targetId: link.targetId }
            : { linkId: edge.linkId, position: edge.position };
        });
        topology = inspectChainTopology({ nodes: updatedNodes, edges: updatedEdges });
      } catch (error) {
        issues.push({ chainId: chain.id, code: 'reorder_failed', detail: error.message });
        continue;
      }
    }
    const softIssues = topology.issues.filter((issue) => !issue.hard);
    if (softIssues.length) issues.push({ chainId: chain.id, code: 'incomplete', detail: topologyIssueText(chain.id, { issues: softIssues }), issues: softIssues });
  }
  return {
    changed: changedChainIds.length > 0,
    changedChainIds,
    issues,
    graphRevision: service.project().graph_revision,
  };
}

/**
 * Append only explicit task Blocks and Links that extend a feature Chain. A
 * missing Link is reported to the caller instead of being invented from
 * directory or import proximity.
 */
export function synchronizeTaskNetwork(service, { chainId, blockIds = [], linkIds = [] } = {}) {
  if (!chainId) return { changed: false, appendedNodeIds: [], appendedLinkIds: [], issue: null };
  const snapshot = service.snapshot();
  const chain = snapshot.chains.find((item) => item.id === chainId);
  if (!chain) return { changed: false, appendedNodeIds: [], appendedLinkIds: [], issue: `chain:${chainId} not found` };
  const currentNodeRows = snapshot.chainNodes
    .filter((item) => item.chainId === chainId)
    .sort((a, b) => a.position - b.position || a.blockId.localeCompare(b.blockId));
  const currentNodes = currentNodeRows.map((item) => item.blockId);
  const currentEdgeRows = snapshot.chainEdges
    .filter((item) => item.chainId === chainId)
    .sort((a, b) => a.position - b.position || a.linkId.localeCompare(b.linkId));
  const currentLinks = new Set(currentEdgeRows.map((item) => item.linkId));
  const missingNodes = unique(blockIds).filter((id) => !currentNodes.includes(id));
  const finalNodes = new Set([...currentNodes, ...missingNodes]);
  const explicitLinkIds = unique(linkIds).filter((id) => !currentLinks.has(id));
  const explicitLinks = explicitLinkIds
    .map((id) => snapshot.links.find((link) => link.id === id))
    .filter((link) => link && link.sourceType === 'block' && link.targetType === 'block' && finalNodes.has(link.sourceId) && finalNodes.has(link.targetId));
  // Membership and route Links are semantic decisions made by the caller.
  // Keep the task boundary explicit so a newly written Block is never pulled
  // into a Chain merely because a global Link happens to connect two nodes.
  const candidateLinks = explicitLinks.map((link) => link.id);
  const missingExplicitLinks = explicitLinkIds.filter((id) => !explicitLinks.some((link) => link.id === id));
  if (missingExplicitLinks.length) {
    return {
      changed: false, appendedNodeIds: [], appendedLinkIds: [],
      issue: `Task feature Links ${missingExplicitLinks.map((id) => `link:${id}`).join(', ')} are not valid links between Chain nodes`,
    };
  }
  if (!missingNodes.length && !candidateLinks.length) {
    return { changed: false, appendedNodeIds: [], appendedLinkIds: [], issue: null };
  }
  if (!candidateLinks.length && missingNodes.length && finalNodes.size > 1) {
    return {
      changed: false, appendedNodeIds: [], appendedLinkIds: [],
      issue: `Task Blocks ${missingNodes.map((id) => `block:${id}`).join(', ')} have no explicit Link into chain:${chainId}`,
    };
  }
  const nodeOrder = [...currentNodes, ...missingNodes];
  const linkRows = [
    ...currentEdgeRows.map((edge) => {
      const link = snapshot.links.find((item) => item.id === edge.linkId);
      return link ? {
        linkId: edge.linkId,
        sourceId: link.sourceId ?? link.source_id,
        targetId: link.targetId ?? link.target_id,
        position: edge.position,
      } : { linkId: edge.linkId, position: edge.position };
    }),
    ...candidateLinks.map((id, index) => {
      const link = snapshot.links.find((item) => item.id === id);
      return {
        linkId: id,
        sourceId: link?.sourceId ?? link?.source_id,
        targetId: link?.targetId ?? link?.target_id,
        position: currentEdgeRows.length + index,
      };
    }),
  ];
  const topology = inspectChainTopology({ nodes: nodeOrder.map((blockId, position) => ({ blockId, position })), edges: linkRows });
  const hardIssues = topology.issues.filter((issue) => issue.hard && !['backward_edge', 'position_gap', 'duplicate_position'].includes(issue.code));
  if (hardIssues.length) return {
    changed: false, appendedNodeIds: [], appendedLinkIds: [],
    issue: topologyIssueText(chainId, { issues: hardIssues }),
  };
  const orderedNodes = stableChainOrder(
    nodeOrder.map((blockId, position) => ({ blockId, position })),
    linkRows,
  );
  if (!orderedNodes) {
    return {
      changed: false, appendedNodeIds: [], appendedLinkIds: [],
      issue: topologyIssueText(chainId, { issues: topology.issues.filter((issue) => issue.hard) }) || `Chain ${chainId} cannot be topologically ordered`,
    };
  }
  const orderedLinks = [...currentEdgeRows.map((edge) => edge.linkId), ...candidateLinks];
  const currentOrder = currentNodes.join('\u0000');
  const needsRewrite = orderedNodes.join('\u0000') !== currentOrder || candidateLinks.length > 0 || topology.issues.some((issue) => ['position_gap', 'duplicate_position'].includes(issue.code));
  if (!needsRewrite) return { changed: false, appendedNodeIds: [], appendedLinkIds: [], issue: null };
  try {
    const extendsCompleteChain = chain.deliveryState === 'complete' && (missingNodes.length > 0 || candidateLinks.length > 0);
    const operations = [{
      action: 'set_chain_path',
      id: chainId,
      expectedRevision: chain.currentRevision,
      fields: { nodeIds: orderedNodes, linkIds: orderedLinks },
    }];
    if (extendsCompleteChain) {
      operations.push({
        action: 'update_chain',
        id: chainId,
        expectedRevision: chain.currentRevision + 1,
        fields: { deliveryState: 'implementing', healthState: 'warning' },
        summary: 'Reopened after task feature network expansion',
      });
    }
    const result = service.mutate({
      reason: 'Synchronize task Blocks, explicit feature Links and Chain order',
      task: 'task-reconcile',
      operations,
    });
    return {
      ...result,
      changed: true,
      appendedNodeIds: orderedNodes.filter((id) => missingNodes.includes(id)),
      appendedLinkIds: candidateLinks,
      reordered: orderedNodes.join('\u0000') !== currentOrder,
      reopened: extendsCompleteChain,
      issue: null,
    };
  } catch (error) {
    return { changed: false, appendedNodeIds: [], appendedLinkIds: [], issue: error.message };
  }
}

export function beginTask(service,{intent,blockIds=[],linkIds=[],chainId=null,planId=null,feature=null,standaloneReason='',readOnly=false}={}) {
  if (!intent?.trim()) throw new Error('intent is required');
  service.ensureSynced();
  let snapshot=service.snapshot();
  const existingFeatureChainId = feature?.id ?? chainId;
  if (existingFeatureChainId && snapshot.chains.some((chain) => chain.id === existingFeatureChainId)) {
    service.reconcileChainNetwork({
      chainId: existingFeatureChainId,
      autoExpand: false,
      autoReorder: false,
      reason: 'Inspect existing feature Chain network before task begin',
    });
    service.reconcileChainTopology({
      chainId: existingFeatureChainId,
      autoReorder: false,
      reason: 'Inspect existing feature Chain before task begin',
    });
    snapshot = service.snapshot();
  }
  planForTask(service, planId);
  for(const id of blockIds) if(!snapshot.blocks.some(b=>b.id===id)) throw new Error(`Register Block before task: ${id}`);
  let initialNetwork = null;
  if(feature) {
    chainId=feature.id;
    const current=snapshot.chains.find(c=>c.id===chainId);
    const requestedNodes=unique(feature.nodeIds??blockIds);
    const requestedLinks=unique(feature.linkIds??[]);
    if(!current) {
      const operations=[
        {action:'create_chain',id:chainId,fields:{title:feature.title,intent, inputContract:feature.inputContract??'',outputContract:feature.outputContract??'',deliveryState:'planned'}},
        {action:'set_chain_path',id:chainId,expectedRevision:1,fields:{nodeIds:requestedNodes,linkIds:requestedLinks}},
      ];
      const result=service.mutate({reason:'Declare task feature network',operations});
      if(result.success===false) throw new Error(result.projection.error);
    } else {
      const network = synchronizeTaskNetwork(service, { chainId, blockIds: requestedNodes, linkIds: requestedLinks });
      if (network.issue) throw new Error(network.issue);
      initialNetwork = network;
    }
  } else if (chainId) {
    initialNetwork = synchronizeTaskNetwork(service, { chainId, blockIds, linkIds });
  }
  if(chainId&&!service.snapshot().chains.some(c=>c.id===chainId)) throw new Error('Unknown Chain');
  snapshot=service.snapshot();
  const planCoverage=ensurePlanCoverage(service,{planId,chainId,blockIds,readOnly,reason:'Register task scope in Plan'});
  const index=indexSources(service); const now=new Date().toISOString();const id=`task_${crypto.randomUUID()}`;
  const scope={blockIds,chainId,planId,linkIds:unique(feature?.linkIds ?? linkIds),standaloneReason,readOnly,startRevision:index.revision};
  service.database.prepare('INSERT INTO task_sessions(id,project_id,intent,scope_json,source_revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
    .run(id,service.paths.descriptor.id,intent,JSON.stringify(scope),index.sourceRevision,now,now);
  const unfinished=service.database.prepare("SELECT id,intent FROM task_sessions WHERE status='active' AND id<>? AND project_id=?").all(id,service.paths.descriptor.id);
  return {taskId:id,updatedAt:now,...index,planCoverage,initialNetwork,resumableTasks:unfinished,nextActions:['Implement from registered locators','task_reconcile','run_command / checkpoint_record','task_finish']};
}
export function reconcileTask(service,{taskId}={}) {
  service.ensureSynced();
  const task=session(service,taskId);
  const scope=task.scope;
  const autoReconciliation=service.reconcileSourceBackedBlocks({blockIds:scope.blockIds,reason:'Reconcile task source bindings'});
  let index=indexSources(service);
  let snapshot=service.snapshot();
  const issues=[]; const add=(kind,target,detail)=>issues.push({kind,target,detail});
  let planCoverage={planId:scope.planId??null,appendedChangeIds:[],chainScopeId:null,changed:false};
  let network={changed:false,appendedNodeIds:[],appendedLinkIds:[],issue:null};
  let chainNetwork={changed:false,changedChainIds:[],reports:[],graphRevision:service.project().graph_revision};
  let chainTopology = {changed:false,changedChainIds:[],issues:[],graphRevision:service.project().graph_revision};
  if(scope.chainId) {
    chainNetwork=service.reconcileChainNetwork({
      chainId:scope.chainId,
      autoExpand:false,
      autoReorder:false,
      reason:'Inspect task feature network',
    });
    for (const report of chainNetwork.reports ?? []) {
      for (const candidate of (report.candidateBlocks ?? []).filter((item) => item.requiresRouteLink)) {
        add('chain_incomplete', `${scope.chainId}:${candidate.blockId}`, `Block ${candidate.blockId} declares affinity for chain:${scope.chainId} but has no explicit route Link touching the Chain`);
      }
      // Composite member readiness is part of the task boundary. Surface the
      // report so a parent Chain cannot be sealed while a required child stage
      // still needs implementation or composition repair.
      for (const issue of report.issues ?? []) {
        if (!issue?.detail) continue;
        const target = `${scope.chainId}:${issue.blockId ?? issue.memberId ?? issue.edgeId ?? issue.code}`;
        add(report.composition ? 'chain_composition' : 'chain_network', target, issue.detail);
      }
    }
    const expandedBlockIds=chainNetwork.reports.flatMap((report)=>report.autoExpandedBlockIds ?? []);
    const expandedLinkIds=chainNetwork.reports.flatMap((report)=>report.addedLinkIds ?? []);
    if(expandedBlockIds.length || expandedLinkIds.length) {
      scope.blockIds=unique([...(scope.blockIds ?? []),...expandedBlockIds]);
      scope.linkIds=unique([...(scope.linkIds ?? []),...expandedLinkIds]);
      service.database.prepare('UPDATE task_sessions SET scope_json=?, updated_at=? WHERE id=?')
        .run(JSON.stringify(scope),new Date().toISOString(),task.id);
    }
    const scopedChain = snapshot.chains.find((chain) => chain.id === scope.chainId);
    if (scopedChain?.chainType === "composite") {
      network = { changed: false, appendedNodeIds: [], appendedLinkIds: [], issue: null, composite: true };
    } else {
      network=synchronizeTaskNetwork(service,{chainId:scope.chainId,blockIds:scope.blockIds,linkIds:scope.linkIds ?? []});
      if(network.issue) add('chain_incomplete',scope.chainId,network.issue);
    }
    chainTopology=reconcileChainTopology(service,{chainId:scope.chainId,autoReorder:false,reason:'Inspect task Chain topology'});
    for (const issue of chainTopology.issues) add('chain_topology', scope.chainId, issue.detail);
    if(scope.planId) {
      try {
        planCoverage=ensurePlanCoverage(service,{planId:scope.planId,chainId:scope.chainId,blockIds:scope.blockIds,readOnly:scope.readOnly,reason:'Refresh Plan after Chain synchronization'});
      } catch(error) {
        add('plan_coverage',scope.planId,error.message);
      }
    }
    snapshot=service.snapshot();
    index=indexSources(service);
  }
  if(scope.planId && !scope.chainId) {
    try {
      planCoverage=ensurePlanCoverage(service,{planId:scope.planId,chainId:null,blockIds:scope.blockIds,readOnly:scope.readOnly,reason:'Reconcile task scope in Plan'});
      snapshot=service.snapshot();
    } catch(error) {
      add('plan_coverage',scope.planId,error.message);
    }
  }
  const changed=service.database.prepare('SELECT DISTINCT path FROM sync_events WHERE revision>?').all(scope.startRevision).map(r=>r.path);
  for(const relative of changed) {
    const file=service.database.prepare('SELECT * FROM source_index WHERE path=?').get(relative);
    if(!file) continue;
    const refs=snapshot.sourceRefs.filter(r=>r.path===relative);
    if(!refs.length && !scope.excludedPaths?.some(item=>item.path===relative)) add('unbound_file',relative,'New/changed source has no architecture binding; bind it or explicitly revise the task scope');
  }
  for(const id of scope.blockIds) {
    const bindings=[...service.sourceBindingState.values()].filter(b=>b.blockId===id);
    const block=snapshot.blocks.find(b=>b.id===id);
    if(!block) {add('missing_block',id,'Block was removed');continue;}
    if(['flow','ui','service','function','integration','api','data','database'].includes(block.kind)&&!bindings.length) add('unbound_block',id,'Bind implementation symbol');
    for(const binding of bindings) if(['missing','ambiguous','stale','unreadable','outside_project','line_only'].includes(binding.bindingStatus)||!binding.symbol) add('invalid_binding',id,`${binding.path}: ${binding.bindingStatus}`);
    if(!snapshot.checkpoints.some(c=>c.targetType==='block'&&c.targetId===id&&c.status==='passed'&&c.freshness?.status==='fresh')) add('verification_required',id,'Fresh direct Checkpoint required before delivery');
  }
  if(scope.blockIds.length&&!scope.chainId&&!scope.standaloneReason) add('feature_membership_missing',taskId,'Declare a feature Chain or an explicit standalone reason');
  if(scope.chainId) {
    const chain=snapshot.chains.find(c=>c.id===scope.chainId);
    if(!chain) add('missing_chain',scope.chainId,'Declared feature Chain was removed');
    else if(!chain.inputContract?.trim() || !chain.outputContract?.trim()) add('chain_contract_missing',scope.chainId,'Describe the feature input and observable outcome');
    const nodes = chain.chainType === "composite"
      ? chainBlockIds(snapshot, scope.chainId)
      : snapshot.chainNodes.filter(n=>n.chainId===scope.chainId).sort((a,b)=>a.position-b.position).map(n=>n.blockId);
    const edges=snapshot.chainEdges.filter(e=>e.chainId===scope.chainId);
    for(const id of scope.blockIds) if(!nodes.includes(id)) add('chain_incomplete',id,'Task Block absent from feature Chain');
    const topology = inspectChainTopology({
      nodes: snapshot.chainNodes.filter(n=>n.chainId===scope.chainId).sort((a,b)=>a.position-b.position),
      edges: edges.map((edge) => {
        const link = snapshot.links.find((item) => item.id === edge.linkId);
        return link ? { linkId: edge.linkId, position: edge.position, sourceId: link.sourceId, targetId: link.targetId } : { linkId: edge.linkId, position: edge.position };
      }),
    });
    for (const issue of topology.issues) {
      const alreadyReported = chainTopology.issues.some((entry) => entry.issues?.some((item) => item.code === issue.code));
      if (!alreadyReported && (issue.hard || ['disconnected', 'no_edges'].includes(issue.code))) add('chain_topology', scope.chainId, issue.detail);
    }
  }
  transaction(service.database,()=>{
    service.database.prepare("UPDATE sync_issues SET status='resolved' WHERE task_id=?").run(taskId);
    for(const issue of issues) service.database.prepare("INSERT INTO sync_issues VALUES(?,?,?,?,?,'open',?) ON CONFLICT(id) DO UPDATE SET detail=excluded.detail,status='open',updated_at=excluded.updated_at")
      .run(hash(`${taskId}:${issue.kind}:${issue.target}`),taskId,issue.kind,issue.target,issue.detail,new Date().toISOString());
    service.database.prepare('UPDATE task_sessions SET source_revision=?,updated_at=? WHERE id=?').run(index.sourceRevision,new Date().toISOString(),taskId);
  });
  return {taskId,updatedAt:session(service,taskId).updated_at,...index,autoReconciliation,chainNetwork,chainTopology,planCoverage,network,issues,status:issues.length?'needs_work':'ready',graphRevision:service.project().graph_revision};
}
export function finishTask(service,{taskId,expectedGraphRevision,sourceRevision,idempotencyKey,summary=''}={}) {
  if(!idempotencyKey)throw new Error('idempotencyKey is required');
  service.ensureSynced();const task=session(service,taskId);
  if(task.status==='complete') {
    if(task.idempotency_key!==idempotencyKey)throw new Error('Task already completed with another idempotency key');
    return {...JSON.parse(task.result_json),idempotent:true};
  }
  if(service.project().graph_revision!==expectedGraphRevision)throw new Error('Graph revision conflict; reconcile again');
  const report=reconcileTask(service,{taskId});
  if(report.sourceRevision!==sourceRevision)throw new Error('Source changed; reconcile and verify again');
  if(report.issues.length)return report;
  const needsVerification=(issue)=>{
    service.database.prepare("INSERT INTO sync_issues VALUES(?,?,?,?,?,'open',?) ON CONFLICT(id) DO UPDATE SET detail=excluded.detail,status='open',updated_at=excluded.updated_at")
      .run(hash(`${taskId}:${issue.kind}:${issue.target}`),taskId,issue.kind,issue.target,issue.detail??'Fresh Chain Checkpoint required',new Date().toISOString());
    return {...report,status:'needs_work',issues:[issue]};
  };
  const snapshot=service.snapshot();const operations=[];
  for(const id of task.scope.blockIds) {
    const block=snapshot.blocks.find(b=>b.id===id);
    const checkpoint=snapshot.checkpoints.find(c=>c.targetType==='block'&&c.targetId===id&&c.status==='passed'&&c.freshness?.status==='fresh');
    if(!checkpoint) return needsVerification({kind:'verification_required',target:id,detail:'Fresh direct Checkpoint required'});
    operations.push({action:'update_block',id,expectedRevision:block.currentRevision,fields:{deliveryState:'complete',healthState:'healthy'}});
  }
  if(task.scope.chainId) {
    const chain=snapshot.chains.find(c=>c.id===task.scope.chainId);
    const checks=snapshot.checkpoints.filter(c=>c.targetType==='chain'&&c.targetId===chain.id);
    if(checks.length&&!checks.some(c=>c.status==='passed'&&c.freshness?.status==='fresh'))return needsVerification({kind:'chain_verification_required',target:chain.id});
    operations.push({action:'update_chain',id:chain.id,expectedRevision:chain.currentRevision,fields:{deliveryState:'complete'}});
  }
  if (task.scope.planId) {
    const plan = snapshot.plans.find((item) => item.id === task.scope.planId);
    if (!plan) return needsVerification({kind:'plan_missing',target:task.scope.planId,detail:`Plan not found: ${task.scope.planId}`});
    const targetIds = new Set([
      ...task.scope.blockIds.map((id) => `block:${id}`),
      ...(task.scope.chainId ? [`chain:${task.scope.chainId}`] : []),
      ...snapshot.chainEdges.filter((edge) => edge.chainId === task.scope.chainId).map((edge) => {
        const link = snapshot.links.find((item) => item.id === edge.linkId);
        return link ? `link:${link.id}` : null;
      }).filter(Boolean),
    ]);
    const updates = snapshot.planChanges
      .filter((change) => change.planId === plan.id && targetIds.has(`${change.entityType}:${change.entityId}`))
      .filter((change) => !['complete','skipped'].includes(change.status))
      .map((change) => ({ changeId: change.id, patch: { status: 'complete' } }));
    if (updates.length) operations.push({
      action: 'update_plan_changes', id: plan.id, expectedRevision: plan.currentRevision,
      fields: { updates },
    });
  }
  const result={taskId,status:'complete',summary,sourceRevision,changedRefs:operations.map(o=>{
    if (o.action === 'update_plan_changes') return `plan:${o.id}`;
    if (o.action === 'update_chain') return `chain:${o.id}`;
    return `block:${o.id}`;
  })};
  const commitHook=()=>{
    const currentHash=hash(sourceInventory(service.paths.projectRoot,{fileCache:service.sourceFileCache}).map(f=>`${f.path}:${f.hash}`).join('\n'));
    if(currentHash!==sourceRevision)throw new Error('Source changed during task finish');
    service.database.prepare("UPDATE task_sessions SET status='complete',idempotency_key=?,result_json=?,updated_at=? WHERE id=?")
      .run(idempotencyKey,JSON.stringify(result),new Date().toISOString(),taskId);
    setSyncMeta(service.database,'task_handoff',JSON.stringify({taskId,summary,nextUp:'',updatedAt:new Date().toISOString()}));
  };
  if(operations.length) result.mutation=executeMutate(service,{reason:'Atomic task completion',planId:task.scope.planId??null,operations},{commitHook});
  else transaction(service.database,commitHook);
  if(result.mutation?.projection?.status==='pending') return {...result,status:'projection_pending',success:false,projection:result.mutation.projection};
  return result;
}

export function updateTaskScope(service,{taskId,expectedUpdatedAt,blockIds,linkIds,chainId,planId,standaloneReason,excludedPaths,nextAction,summary}={}) {
  service.ensureSynced();
  const db=service.database;
  return transaction(db,()=>{
    const task=session(service,taskId);
    if(task.status==='complete')throw new Error('Completed task cannot be edited');
    if(task.updated_at!==expectedUpdatedAt)throw new Error('Task revision conflict; read sync_issues/task_reconcile first');
    const scope={...task.scope};
    if(blockIds!==undefined){
      for(const id of blockIds) if(!db.prepare('SELECT id FROM blocks WHERE id=? AND project_id=?').get(id,service.paths.descriptor.id))throw new Error(`Unknown Block: ${id}`);
      scope.blockIds=blockIds;
    }
    if(linkIds!==undefined){
      for(const id of linkIds) if(!db.prepare('SELECT id FROM links WHERE id=? AND project_id=? AND archived=0').get(id,service.paths.descriptor.id))throw new Error(`Unknown Link: ${id}`);
      scope.linkIds=unique(linkIds);
    }
    if(chainId!==undefined){
      if(chainId&&!db.prepare('SELECT id FROM chains WHERE id=? AND project_id=?').get(chainId,service.paths.descriptor.id))throw new Error('Unknown Chain');
      scope.chainId=chainId;
    }
    if(planId!==undefined){
      if(planId&&!db.prepare('SELECT id FROM plans WHERE id=? AND project_id=?').get(planId,service.paths.descriptor.id))throw new Error('Unknown Plan');
      scope.planId=planId;
    }
    if(standaloneReason!==undefined)scope.standaloneReason=standaloneReason;
    if(excludedPaths!==undefined){
      for(const item of excludedPaths)if(!item.reason?.trim()||path.isAbsolute(item.path)||item.path.split('/').includes('..'))throw new Error('Excluded paths require a project-relative path and reason');
      scope.excludedPaths=excludedPaths;
    }
    if(nextAction!==undefined)scope.nextAction=nextAction;
    if(summary!==undefined)scope.summary=summary;
    const updatedAt=new Date().toISOString();
    db.prepare('UPDATE task_sessions SET scope_json=?,updated_at=? WHERE id=?').run(JSON.stringify(scope),updatedAt,taskId);
    return {taskId,updatedAt,scope};
  });
}

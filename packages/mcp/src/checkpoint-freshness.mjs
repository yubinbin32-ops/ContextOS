import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { bindingIdentity } from "./source-binding.mjs";

export const CHECKPOINT_IDENTITY_KIND = "contextos-identity";

function projectRootFor(service) {
  return path.resolve(service.paths.projectRoot);
}

function relativeProjectPath(root, candidate) {
  if (typeof candidate !== "string" || !candidate.trim()) return null;
  const resolved = path.resolve(root, candidate);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join("/");
}

function gitHead(projectRoot) {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) return null;
  const value = String(result.stdout ?? "").trim();
  return value || null;
}

function fileHash(filePath) {
  try {
    if (!fs.statSync(filePath).isFile()) return null;
    return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
  } catch {
    return null;
  }
}

function sourceRefsForBlock(database, blockId) {
  return database.prepare(
    "SELECT id, path, start_line, end_line, symbol, role FROM source_refs WHERE block_id = ? ORDER BY path, start_line, id",
  ).all(blockId);
}

function sourceRefsForChain(database, chainId) {
  return database.prepare(
    `SELECT sr.id, sr.path, sr.start_line, sr.end_line, sr.symbol, sr.role
       FROM source_refs sr
       JOIN chain_nodes cn ON cn.block_id = sr.block_id
      WHERE cn.chain_id = ?
      ORDER BY cn.position, sr.path, sr.start_line, sr.id`,
  ).all(chainId);
}

function sourceRefsForTarget(service, targetType, targetId) {
  const { database } = service;
  const refs = [];
  const addBlock = (blockId) => refs.push(...sourceRefsForBlock(database, blockId));
  const addChain = (chainId) => refs.push(...sourceRefsForChain(database, chainId));

  if (targetType === "block") addBlock(targetId);
  else if (targetType === "chain") addChain(targetId);
  else if (targetType === "link") {
    const link = database.prepare(
      "SELECT source_type, source_id, target_type, target_id FROM links WHERE id = ?",
    ).get(targetId);
    if (link?.source_type === "block") addBlock(link.source_id);
    if (link?.target_type === "block") addBlock(link.target_id);
    if (link?.source_type === "chain") addChain(link.source_id);
    if (link?.target_type === "chain") addChain(link.target_id);
  } else if (targetType === "plan") {
    const changes = database.prepare(
      "SELECT entity_type, entity_id FROM plan_changes WHERE plan_id = ? ORDER BY position, id",
    ).all(targetId);
    for (const change of changes) {
      if (change.entity_type === "block") addBlock(change.entity_id);
      if (change.entity_type === "chain") addChain(change.entity_id);
    }
    const scopes = database.prepare(
      "SELECT chain_id FROM plan_chain_scopes WHERE plan_id = ? ORDER BY position, id",
    ).all(targetId);
    for (const scope of scopes) addChain(scope.chain_id);
  }
  return refs;
}

function evidencePaths(evidence) {
  const paths = [];
  for (const item of Array.isArray(evidence) ? evidence : []) {
    if (!item || typeof item !== "object") continue;
    for (const key of ["path", "file", "filePath", "sourcePath"]) {
      if (typeof item[key] === "string") paths.push(item[key]);
    }
    if (Array.isArray(item.files)) paths.push(...item.files.filter((value) => typeof value === "string"));
  }
  return paths;
}

function checkpointFiles(service, targetType, targetId, evidence) {
  const root = projectRootFor(service);
  const files = new Map();
  for (const ref of [...sourceRefsForTarget(service, targetType, targetId), ...evidencePaths(evidence).map((pathValue) => ({ path: pathValue }))]) {
    const relative = relativeProjectPath(root, ref.path);
    const key = relative ?? `!${String(ref.path)}`;
    if (files.has(key)) continue;
    const absolute = relative ? path.join(root, relative) : null;
    files.set(key, {
      path: relative ?? String(ref.path),
      hash: absolute ? fileHash(absolute) : null,
    });
  }
  return [...files.values()];
}

function checkpointBindings(service, targetType, targetId) {
  if (typeof service.syncSourceBindings !== "function") return [];
  const refs = sourceRefsForTarget(service, targetType, targetId);
  if (!refs.length) return [];
  const state = service.syncSourceBindings({ includeUnchanged: true });
  const byId = new Map((state.bindings ?? []).map((binding) => [binding.id, binding]));
  const seen = new Set();
  const bindings = [];
  for (const ref of refs) {
    const binding = byId.get(ref.id);
    if (!binding || seen.has(binding.id)) continue;
    seen.add(binding.id);
    bindings.push(binding);
  }
  return bindings;
}

export function extractCheckpointIdentity(evidence) {
  return (Array.isArray(evidence) ? evidence : []).find(
    (item) => item && typeof item === "object" && item.kind === CHECKPOINT_IDENTITY_KIND,
  ) ?? null;
}

export function stripCheckpointIdentity(evidence) {
  return (Array.isArray(evidence) ? evidence : []).filter(
    (item) => !(item && typeof item === "object" && item.kind === CHECKPOINT_IDENTITY_KIND),
  );
}

export function withCheckpointIdentity(service, { targetType, targetId, evidence = [], gitHead: requestedGitHead = null } = {}) {
  const cleanEvidence = stripCheckpointIdentity(evidence);
  const bindings = checkpointBindings(service, targetType, targetId);
  const identity = {
    kind: CHECKPOINT_IDENTITY_KIND,
    version: 2,
    gitHead: requestedGitHead ?? gitHead(projectRootFor(service)),
    files: checkpointFiles(service, targetType, targetId, cleanEvidence),
    bindings: bindings.map(bindingIdentity),
  };
  return [...cleanEvidence, identity];
}

export function createCheckpointFreshnessContext(service) {
  const root = projectRootFor(service);
  return { root, gitHead: gitHead(root), fileHashes: new Map(), sourceBindings: null };
}

export function evaluateCheckpointFreshness(service, identity, context = null) {
  if (!identity || identity.kind !== CHECKPOINT_IDENTITY_KIND || ![1, 2].includes(identity.version)) {
    return { status: "unknown", reasons: ["checkpoint has no source identity"] };
  }
  const freshnessContext = context ?? createCheckpointFreshnessContext(service);
  const root = freshnessContext.root;
  const reasons = [];
  let unknown = false;
  if (identity.gitHead && !(identity.bindings?.length || identity.files?.length)) {
    const currentHead = freshnessContext.gitHead;
    if (!currentHead) unknown = true;
    else if (currentHead !== identity.gitHead) reasons.push("git HEAD changed");
  }
  if (identity.version >= 2 && Array.isArray(identity.bindings) && identity.bindings.length > 0) {
    if (!freshnessContext.sourceBindings) {
      freshnessContext.sourceBindings = typeof service.syncSourceBindings === "function"
        ? service.syncSourceBindings({ includeUnchanged: true })
        : { bindings: [] };
    }
    const current = freshnessContext.sourceBindings;
    const currentById = new Map((current.bindings ?? []).map((binding) => [binding.id, binding]));
    for (const expected of identity.bindings) {
      const actual = currentById.get(expected.id);
      if (!actual) {
        reasons.push(`source binding is missing: ${expected.path}${expected.symbol ? ` :: ${expected.symbol}` : ""}`);
        continue;
      }
      if (["missing", "unreadable", "outside_project", "stale", "ambiguous"].includes(actual.bindingStatus)) {
        reasons.push(`source binding is ${actual.bindingStatus}: ${actual.path}${actual.symbol ? ` :: ${actual.symbol}` : ""}`);
        continue;
      }
      if (expected.nodeHash && actual.nodeHash && expected.nodeHash !== actual.nodeHash) {
        reasons.push(`source symbol changed: ${actual.path}${actual.symbol ? ` :: ${actual.symbol}` : ""}`);
      } else if (!expected.nodeHash && expected.fileHash !== actual.fileHash) {
        reasons.push(`source changed: ${actual.path}`);
      }
    }
  }
  for (const file of Array.isArray(identity.files) ? identity.files : []) {
    const relative = relativeProjectPath(root, file.path);
    if (!relative) {
      reasons.push(`source path is outside project: ${file.path}`);
      continue;
    }
    if (!freshnessContext.fileHashes.has(relative)) {
      freshnessContext.fileHashes.set(relative, fileHash(path.join(root, relative)));
    }
    const currentHash = freshnessContext.fileHashes.get(relative);
    if (!currentHash) reasons.push(`source file is missing: ${relative}`);
    else if (currentHash !== file.hash) reasons.push(`source changed: ${relative}`);
  }
  if (reasons.length > 0) return { status: "stale", reasons };
  if (unknown) return { status: "unknown", reasons: ["git identity could not be read"] };
  return { status: "fresh", reasons: [] };
}

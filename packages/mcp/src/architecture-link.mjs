import fs from "node:fs";
import path from "node:path";
import { detectLanguage, extractSymbolSlice } from "./ast.mjs";

const LAYER_ORDER = [
  "client",
  "boundary",
  "application",
  "domain",
  "data",
  "external",
  "quality",
  "infrastructure",
  "unspecified",
];

function normalizedPath(value) {
  return String(value ?? "").replace(/\\/g, "/").replace(/^\.\//, "");
}

function comparablePath(value) {
  const normalized = normalizedPath(value).replace(/\.[^/.]+$/, "");
  return normalized.endsWith("/index") ? normalized.slice(0, -6) : normalized;
}

function importPath(filePath, importedPath) {
  if (!importedPath?.startsWith(".")) return null;
  return normalizedPath(path.normalize(path.join(path.dirname(normalizedPath(filePath)), importedPath)));
}

function importNames(clause = "") {
  const names = new Set();
  const localNames = new Set();
  const namespaces = new Set();
  const aliases = new Map();
  const named = clause.match(/\{([^}]*)\}/)?.[1] ?? "";
  for (const entry of named.split(",").map((item) => item.trim()).filter(Boolean)) {
    const [imported, local = imported] = entry.split(/\s+as\s+/i).map((item) => item.trim());
    if (imported) names.add(imported);
    if (local) localNames.add(local);
    if (imported && local) aliases.set(imported, local);
  }
  const namespace = clause.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
  if (namespace) namespaces.add(namespace[1]);
  const defaultPart = clause
    .replace(/\{[^}]*\}/, "")
    .replace(/\*\s+as\s+[A-Za-z_$][\w$]*/, "")
    .split(",")[0]
    .trim();
  if (defaultPart && /^[A-Za-z_$][\w$]*$/.test(defaultPart)) {
    names.add("default");
    localNames.add(defaultPart);
    aliases.set("default", defaultPart);
  }
  return { names, localNames, namespaces, aliases };
}

/**
 * Extract imported paths and the imported identifiers that belong to each
 * path. File-level imports are retained as weak evidence only; a high
 * confidence suggestion requires the imported symbol to be used by the
 * Block's own AST slice.
 */
function extractImportBindings(sourceCode, filePath = "") {
  const imports = [];
  const lines = sourceCode.split(/\r?\n/);
  const lang = detectLanguage(filePath);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("#") || trimmed.startsWith("/*")) {
      continue;
    }

    if (lang === "javascript" || lang === "typescript") {
      const fromMatch = trimmed.match(/^import\s+(.+?)\s+from\s+['"]([^'"]+)['"]/);
      if (fromMatch) {
        const resolved = importPath(filePath, fromMatch[2]);
        if (resolved) imports.push({ path: resolved, ...importNames(fromMatch[1]), line: trimmed });
        continue;
      }
      const sideEffectMatch = trimmed.match(/^import\s+['"]([^'"]+)['"]/);
      if (sideEffectMatch) {
        const resolved = importPath(filePath, sideEffectMatch[1]);
        if (resolved) imports.push({ path: resolved, ...importNames(""), line: trimmed });
        continue;
      }
      const destructured = trimmed.match(/^(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\(['"]([^'"]+)['"]\)/);
      if (destructured) {
        const resolved = importPath(filePath, destructured[2]);
        if (resolved) imports.push({ path: resolved, ...importNames(`{${destructured[1]}}`), line: trimmed });
        continue;
      }
      const required = trimmed.match(/^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(['"]([^'"]+)['"]\)/);
      if (required) {
        const resolved = importPath(filePath, required[2]);
        if (resolved) imports.push({ path: resolved, ...importNames(required[1]), namespaces: new Set([required[1]]), line: trimmed });
      }
    } else if (lang === "swift") {
      const swiftMatch = trimmed.match(/^import\s+([A-Za-z0-9_]+)/);
      if (swiftMatch) imports.push({ path: swiftMatch[1], ...importNames(""), line: trimmed });
    } else if (lang === "python") {
      const fromMatch = trimmed.match(/^from\s+([A-Za-z0-9_.]+)\s+import\s+(.+)/);
      if (fromMatch) imports.push({ path: fromMatch[1].replace(/\./g, "/"), ...importNames(`{${fromMatch[2]}}`), line: trimmed });
      const moduleMatch = trimmed.match(/^import\s+([A-Za-z0-9_.]+)(?:\s+as\s+([A-Za-z0-9_]+))?/);
      if (moduleMatch) imports.push({ path: moduleMatch[1].replace(/\./g, "/"), ...importNames(moduleMatch[2] || moduleMatch[1].split(".").at(-1)), line: trimmed });
    }
  }
  return imports;
}

function identifierUsed(code, name) {
  if (!name || name === "default") return false;
  const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`).test(code);
}

function namespaceUse(code, namespace, symbol) {
  if (!namespace) return false;
  const escapedNamespace = String(namespace).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (symbol) {
    const escapedSymbol = String(symbol).split(".").at(-1).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\b${escapedNamespace}\\s*\\.\\s*${escapedSymbol}\\b`).test(code);
  }
  return new RegExp(`\\b${escapedNamespace}\\b`).test(code);
}

function pathMatches(imported, target) {
  const left = comparablePath(imported);
  const right = comparablePath(target);
  return left === right || left.endsWith(`/${right}`) || right.endsWith(`/${left}`);
}

/**
 * Suggest architectural links for a specific Block
 */
export function suggestLinksForBlock(service, target) {
  const blockId = typeof target === "object" && target !== null ? target.blockId : target;
  const snapshot = service.snapshot();
  const block = snapshot.blocks.find((b) => b.id === blockId);
  if (!block) {
    throw new Error(`block:${blockId} not found`);
  }

  const existingLinks = snapshot.links.filter(
    (l) => (l.sourceType === "block" && l.sourceId === blockId) ||
           (l.targetType === "block" && l.targetId === blockId),
  );
  const connectedBlockIds = new Set(
    existingLinks.map((l) => (l.sourceId === blockId ? l.targetId : l.sourceId)),
  );

  const suggestions = [];
  const blockSources = snapshot.sourceRefs.filter((s) => s.blockId === blockId);
  const repoRoot = service.paths.repoRoot || service.paths.projectRoot;

  // 1. Symbol-aware AST import suggestions. We still read the cached source
  // file to resolve the current symbol, but only the symbol slice is used to
  // prove that the import belongs to this Block. This avoids turning every
  // Block in a shared service.mjs into a false dependency.
  const sourceImports = [];
  for (const ref of blockSources) {
    const refPath = ref.path || ref.filePath;
    if (!refPath) continue;
    const absolutePath = path.isAbsolute(refPath) ? refPath : path.join(repoRoot, refPath);
    const binding = service.sourceBindingState?.get(ref.id);
    let code = binding?.content;
    if (!code && fs.existsSync(absolutePath)) {
      try { code = fs.readFileSync(absolutePath, "utf8"); } catch { code = null; }
    }
    if (!code) continue;
    let scopeCode = code;
    if (ref.symbol) {
      const slice = extractSymbolSlice(code, {
        symbol: ref.symbol,
        language: detectLanguage(refPath),
        filePath: refPath,
        maxLines: 240,
      });
      if (!slice.found) continue;
      scopeCode = slice.code;
    }
    for (const imported of extractImportBindings(code, refPath)) {
      sourceImports.push({ ...imported, scopeCode, sourceRef: ref });
    }
  }

  if (sourceImports.length > 0) {
    for (const otherBlock of snapshot.blocks) {
      if (otherBlock.id === blockId || connectedBlockIds.has(otherBlock.id)) continue;
      const otherSources = snapshot.sourceRefs.filter((s) => s.blockId === otherBlock.id);
      for (const otherRef of otherSources) {
        const otherPath = otherRef.path || otherRef.filePath;
        if (!otherPath) continue;
        const normalizedOther = otherPath.replace(/\.[^/.]+$/, "");
        for (const imp of sourceImports) {
          if (pathMatches(imp.path, normalizedOther)) {
            const targetSymbol = otherRef.symbol?.split(".").at(-1) ?? null;
            const targetLocals = targetSymbol
              ? [...imp.aliases.entries()]
                .filter(([imported, local]) => imported === targetSymbol || local === targetSymbol || imported.split(".").at(-1) === targetSymbol)
                .map(([, local]) => local)
              : [];
            const importedNameMatch = targetLocals.length > 0;
            const namespaceMatch = [...imp.namespaces].some((namespace) => namespaceUse(imp.scopeCode, namespace, targetSymbol));
            const usedInSlice = targetLocals.some((name) => identifierUsed(imp.scopeCode, name)) || namespaceMatch;
            if (!usedInSlice) continue;
            const fileLevelOnly = !otherRef.symbol || (!importedNameMatch && !namespaceMatch);
            if (fileLevelOnly) continue;
            const confidence = importedNameMatch ? "high" : "medium";
            suggestions.push({
              sourceId: blockId,
              targetId: otherBlock.id,
              kind: ["data", "database"].includes(otherBlock.kind) ? "reads" : "calls",
              confidence,
              evidence: importedNameMatch ? "symbol-import" : "namespace-import",
              reason: importedNameMatch
                ? `AST slice ${imp.sourceRef.symbol || "file"} uses ${targetSymbol} imported from ${otherPath}`
                : `AST slice ${imp.sourceRef.symbol || "file"} uses a namespace import from ${otherPath}`,
            });
            connectedBlockIds.add(otherBlock.id);
            break;
          }
        }
      }
    }
  }

  // 2. Layer & Scope based suggestions are intentionally weak evidence. They
  // are useful for discovering an omitted relationship, but they must never
  // outrank a symbol import or be silently persisted as a Link.
  const currentLayerIdx = LAYER_ORDER.indexOf(block.architectureLayer);
  for (const otherBlock of snapshot.blocks) {
    if (otherBlock.id === blockId || connectedBlockIds.has(otherBlock.id)) continue;
    if (["principle", "decision"].includes(otherBlock.kind)) continue;

    const otherLayerIdx = LAYER_ORDER.indexOf(otherBlock.architectureLayer);
    const sameScope = block.scope === otherBlock.scope && block.scope !== "general";

    if (currentLayerIdx >= 0 && otherLayerIdx >= 0) {
      if (currentLayerIdx < otherLayerIdx && (otherLayerIdx - currentLayerIdx <= 2 || sameScope)) {
        const kind = ["data", "database"].includes(otherBlock.kind) ? "reads" : "calls";
        suggestions.push({
          sourceId: blockId,
          targetId: otherBlock.id,
          kind,
          confidence: sameScope ? "medium" : "low",
          evidence: "layer-convention",
          reason: `Layer convention: ${block.architectureLayer} -> ${otherBlock.architectureLayer}${sameScope ? ` (shares scope ${block.scope})` : ""}`,
        });
      } else if (currentLayerIdx > otherLayerIdx && (currentLayerIdx - otherLayerIdx <= 2 || sameScope)) {
        const kind = ["data", "database"].includes(block.kind) ? "reads" : "calls";
        suggestions.push({
          sourceId: otherBlock.id,
          targetId: blockId,
          kind,
          confidence: sameScope ? "medium" : "low",
          evidence: "layer-convention",
          reason: `Layer convention: ${otherBlock.architectureLayer} -> ${block.architectureLayer}${sameScope ? ` (shares scope ${block.scope})` : ""}`,
        });
      }
    }
  }

  const rank = { high: 3, medium: 2, low: 1 };
  const semanticTargetIds = new Set(
    suggestions.filter((suggestion) => suggestion.evidence !== "layer-convention").map((suggestion) => suggestion.targetId),
  );
  const semanticTargetPaths = new Set(
    snapshot.sourceRefs
      .filter((ref) => semanticTargetIds.has(ref.blockId))
      .map((ref) => comparablePath(ref.path)),
  );
  const deduped = new Map();
  for (const suggestion of suggestions) {
    if (suggestion.evidence === "layer-convention") {
      const targetPaths = snapshot.sourceRefs
        .filter((ref) => ref.blockId === suggestion.targetId)
        .map((ref) => comparablePath(ref.path));
      if (targetPaths.some((targetPath) => semanticTargetPaths.has(targetPath))) continue;
    }
    const key = `${suggestion.sourceId}:${suggestion.targetId}:${suggestion.kind}`;
    const previous = deduped.get(key);
    if (!previous || rank[suggestion.confidence] > rank[previous.confidence]) deduped.set(key, suggestion);
  }
  return [...deduped.values()]
    .sort((left, right) => rank[right.confidence] - rank[left.confidence] || left.targetId.localeCompare(right.targetId))
    .slice(0, 10);
}

/**
 * Connect two architecture Blocks with a validated Link
 */
export function connectBlocks(service, {
  sourceId,
  targetId,
  kind = "calls",
  label = "",
  contract = "",
  actor = "agent",
  reason = "Connect architecture blocks",
}) {
  const snapshot = service.snapshot();
  const source = snapshot.blocks.find((b) => b.id === sourceId);
  const target = snapshot.blocks.find((b) => b.id === targetId);

  if (!source) throw new Error(`Source block:${sourceId} not found`);
  if (!target) throw new Error(`Target block:${targetId} not found`);

  const linkId = `link-${sourceId}-to-${targetId}`;
  const existing = snapshot.links.find((l) => l.id === linkId);

  const operation = existing
    ? {
        action: "update_link",
        id: linkId,
        expectedRevision: existing.currentRevision,
        fields: {
          kind,
          label: label || existing.label,
          contract: contract || existing.contract,
        },
      }
    : {
        action: "create_link",
        id: linkId,
        fields: {
          sourceType: "block",
          sourceId,
          targetType: "block",
          targetId,
          kind,
          label: label || `${source.title} -> ${target.title}`,
          contract: contract || `${source.title} ${kind} ${target.title}`,
        },
      };

  return service.mutate({
    operations: [operation],
    actor,
    reason,
    task: "architecture-connect",
  });
}

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { detectLanguage, extractSymbols, extractSymbolSlice } from "./ast.mjs";

const DISCOVERY_IGNORES = new Set([".git", ".contextos", "node_modules", ".build", "dist", "build", "coverage", ".next"]);
const SOURCE_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".swift", ".py", ".go", ".rs", ".java", ".kt", ".kts", ".c", ".cc", ".cpp", ".h", ".hpp"]);

function discoveryTerms(value) {
  return [...new Set(String(value ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((term) => term.length >= 3))];
}

function sourceFiles(projectRoot, maxFiles) {
  const files = [];
  const visit = (directory) => {
    if (files.length >= maxFiles) return;
    let entries = [];
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (files.length >= maxFiles) break;
      if (entry.name.startsWith(".") && entry.name !== ".github") continue;
      if (DISCOVERY_IGNORES.has(entry.name)) continue;
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(candidate);
      else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) files.push(candidate);
    }
  };
  visit(projectRoot);
  return files;
}

function candidateRole(relative, symbol) {
  const text = `${relative} ${symbol.kind} ${symbol.name}`.toLowerCase();
  if (/(^|\/)(test|tests|spec|specs)(\/|\.)|\.test\.|\.spec\./.test(text)) return "test";
  if (/database|storage|repository|persist|sqlite|schema/.test(text)) return "persistence";
  if (/server|router|controller|handler|api/.test(text)) return "controller";
  if (/config|setting|manifest/.test(text)) return "config";
  if (/render|view|screen|canvas|ui/.test(text)) return "renderer";
  if (/index|facade|client/.test(text)) return "facade";
  return "implementation";
}

export function suggestSourceBindings({ projectRoot, block, existingRefs = [], limit = 12, maxFiles = 600 } = {}) {
  if (!block?.id) throw new Error("block is required");
  const terms = discoveryTerms([block.id, block.title, block.summary, block.contract, ...(block.tags ?? [])].join(" "));
  const existing = new Set(existingRefs.map((ref) => `${ref.path}:${ref.symbol ?? ""}`));
  const candidates = [];
  const files = sourceFiles(projectRoot, maxFiles);
  for (const absolutePath of files) {
    const relative = path.relative(projectRoot, absolutePath).split(path.sep).join("/");
    let content;
    try { content = fs.readFileSync(absolutePath, "utf8"); } catch { continue; }
    for (const symbol of extractSymbols(content, { filePath: relative })) {
      if (existing.has(`${relative}:${symbol.qualifiedName ?? symbol.name}`) || existing.has(`${relative}:${symbol.name}`)) continue;
      const haystack = `${relative} ${symbol.qualifiedName ?? symbol.name} ${symbol.signature ?? ""}`.toLowerCase();
      const matchedTerms = terms.filter((term) => haystack.includes(term));
      const exactName = discoveryTerms(symbol.qualifiedName ?? symbol.name).some((term) => terms.includes(term));
      const pathMatches = terms.filter((term) => relative.toLowerCase().includes(term)).length;
      const score = matchedTerms.length * 12 + pathMatches * 5 + (exactName ? 18 : 0);
      if (score < 12) continue;
      candidates.push({
        path: relative,
        symbol: symbol.qualifiedName ?? symbol.name,
        role: candidateRole(relative, symbol),
        confidence: Math.min(0.98, Number((0.35 + score / 100).toFixed(2))),
        reasons: [
          ...(matchedTerms.length ? [`matched terms: ${matchedTerms.slice(0, 6).join(", ")}`] : []),
          ...(pathMatches ? ["source path matches Block semantics"] : []),
          ...(exactName ? ["symbol name matches Block semantics"] : []),
        ],
        signature: symbol.signature ?? null,
        startLine: symbol.startLine,
        endLine: symbol.endLine,
        score,
      });
    }
  }
  candidates.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path) || left.symbol.localeCompare(right.symbol));
  return { blockId: block.id, scannedFiles: files.length, candidates: candidates.slice(0, limit).map(({ score: _score, ...item }) => item) };
}

export function suggestBindingsForChangedFiles({ projectRoot, blocks = [], existingRefs = [], changedPaths = [], limit = 8 } = {}) {
  const existing = new Set(existingRefs.map((ref) => `${ref.path}:${ref.symbol ?? ""}`));
  const files = [...new Set(changedPaths.map((item) => String(item ?? "").split(path.sep).join("/")))]
    .filter((relative) => SOURCE_EXTENSIONS.has(path.extname(relative).toLowerCase()));
  const candidates = [];
  for (const relative of files) {
    const absolutePath = path.resolve(projectRoot, relative);
    let content;
    try { content = fs.readFileSync(absolutePath, "utf8"); } catch { continue; }
    const symbols = extractSymbols(content, { filePath: relative });
    for (const block of blocks) {
      const terms = discoveryTerms([block.id, block.title, block.summary, block.contract].join(" "));
      for (const symbol of symbols) {
        const name = symbol.qualifiedName ?? symbol.name;
        if (existing.has(`${relative}:${name}`) || existing.has(`${relative}:${symbol.name}`)) continue;
        const haystack = `${relative} ${name} ${symbol.signature ?? ""}`.toLowerCase();
        const matchedTerms = terms.filter((term) => haystack.includes(term));
        const exactName = discoveryTerms(name).some((term) => terms.includes(term));
        const score = matchedTerms.length * 12 + (exactName ? 20 : 0);
        if (score < 12) continue;
        candidates.push({
          blockId: block.id,
          path: relative,
          symbol: name,
          role: candidateRole(relative, symbol),
          confidence: Math.min(0.98, Number((0.4 + score / 90).toFixed(2))),
          reasons: [
            "changed after native/external edit",
            ...(exactName ? ["symbol name matches Block semantics"] : []),
            ...(matchedTerms.length ? [`matched terms: ${matchedTerms.slice(0, 6).join(", ")}`] : []),
          ],
        });
      }
    }
  }
  candidates.sort((left, right) => right.confidence - left.confidence || left.blockId.localeCompare(right.blockId) || left.symbol.localeCompare(right.symbol));
  const seen = new Set();
  return candidates.filter((item) => {
    const key = `${item.blockId}:${item.path}:${item.symbol}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, limit);
}

function hashText(value) {
  return crypto.createHash("sha256").update(String(value ?? "")).digest("hex");
}

function normalizeCode(value) {
  return String(value ?? "").replace(/\r\n/g, "\n").trim();
}

function relativePath(projectRoot, filePath) {
  const absolute = path.resolve(projectRoot, filePath);
  const relative = path.relative(projectRoot, absolute);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join("/");
}

function refKey(ref, index) {
  return ref.id || `${ref.blockId ?? "block"}:${ref.path}:${ref.symbol ?? "line"}:${index}`;
}

function readFileCached(projectRoot, ref, fileCache) {
  const rawPath = String(ref.path ?? "");
  const absolutePath = path.isAbsolute(rawPath) ? rawPath : path.resolve(projectRoot, rawPath);
  const relative = relativePath(projectRoot, absolutePath);
  if (!relative) {
    return { absolutePath, relativePath: null, status: "outside_project" };
  }

  let stat;
  try {
    stat = fs.statSync(absolutePath);
    if (!stat.isFile()) return { absolutePath, relativePath: relative, status: "missing" };
  } catch {
    return { absolutePath, relativePath: relative, status: "missing" };
  }

  const signature = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  const cached = fileCache.get(relative);
  if (cached?.signature === signature) return cached;

  try {
    const content = fs.readFileSync(absolutePath, "utf8");
    const next = {
      absolutePath,
      relativePath: relative,
      status: "readable",
      signature,
      content,
      fileHash: hashText(content),
      lineCount: content.split(/\r?\n/).length,
      language: detectLanguage(absolutePath),
    };
    fileCache.set(relative, next);
    return next;
  } catch {
    return { absolutePath, relativePath: relative, status: "unreadable", signature };
  }
}

function currentSlice(file, ref) {
  if (file.status !== "readable") return { found: false, reason: file.status, code: "" };
  if (!ref.symbol && (!ref.startLine || !ref.endLine)) {
    return { found: false, reason: "unbound", code: "" };
  }
  return extractSymbolSlice(file.content, {
    symbol: ref.symbol || null,
    startLine: ref.symbol ? null : ref.startLine,
    endLine: ref.symbol ? null : ref.endLine,
    maxLines: Math.max(file.lineCount + 1, 50),
    language: file.language,
    filePath: file.absolutePath,
  });
}

function sourceStatus({ file, slice, moved, implementationChanged }) {
  if (file.status !== "readable") return file.status;
  if (!slice.found) return slice.reason === "ambiguous" ? "ambiguous" : "stale";
  if (!slice.symbol) return "line_only";
  if (moved) return "moved";
  if (implementationChanged) return "changed";
  return "anchored";
}

function changeKinds(previous, current) {
  if (!previous) return [];
  const kinds = [];
  if (previous.path !== current.path || previous.symbol !== current.symbol) kinds.push("binding_definition_changed");
  if (previous.fileHash && current.fileHash && previous.fileHash !== current.fileHash) kinds.push("source_file_changed");
  if (previous.nodeHash && current.nodeHash && previous.nodeHash !== current.nodeHash) kinds.push("implementation_changed");
  if (previous.startLine && current.startLine && (previous.startLine !== current.startLine || previous.endLine !== current.endLine)) kinds.push("binding_moved");
  if (previous.bindingStatus !== current.bindingStatus) {
    if (["missing", "unreadable", "outside_project", "stale", "ambiguous"].includes(current.bindingStatus)) kinds.push("binding_invalid");
    else if (["missing", "unreadable", "outside_project", "stale", "ambiguous"].includes(previous.bindingStatus)) kinds.push("binding_restored");
  }
  return [...new Set(kinds)];
}

export function scanSourceBindings({
  projectRoot,
  sourceRefs = [],
  previous = new Map(),
  fileCache = new Map(),
  scannedAt = new Date().toISOString(),
} = {}) {
  const bindings = [];
  const changes = [];
  for (const [index, ref] of sourceRefs.entries()) {
    const key = refKey(ref, index);
    const previousBinding = previous.get(key) ?? null;
    const file = readFileCached(projectRoot, ref, fileCache);
    const slice = currentSlice(file, ref);
    const fileChanged = Boolean(previousBinding?.fileHash && file.fileHash && previousBinding.fileHash !== file.fileHash);
    const moved = Boolean(previousBinding?.startLine && slice.startLine && (
      previousBinding.startLine !== slice.startLine || previousBinding.endLine !== slice.endLine
    ));
    const nodeHash = slice.found ? hashText(normalizeCode(slice.code)) : null;
    const signatureHash = slice.signature ? hashText(normalizeCode(slice.signature)) : null;
    const implementationChanged = Boolean(previousBinding?.nodeHash && nodeHash && previousBinding.nodeHash !== nodeHash);
    const bindingStatus = file.status !== "readable"
      ? file.status
      : !slice.found
        ? (slice.reason === "ambiguous" ? "ambiguous" : "stale")
        : !ref.symbol && fileChanged
          ? "stale"
        : moved
          ? "moved"
          : "fresh";
    const binding = {
      id: ref.id ?? key,
      blockId: ref.blockId,
      path: ref.path,
      relativePath: file.relativePath,
      absolutePath: file.absolutePath,
      symbol: ref.symbol ?? null,
      role: ref.role ?? "implementation",
      language: file.language ?? detectLanguage(ref.path),
      startLine: slice.startLine ?? null,
      endLine: slice.endLine ?? null,
      signature: slice.signature ?? null,
      fileHash: file.fileHash ?? null,
      nodeHash,
      signatureHash,
      bindingStatus,
      implementationStatus: implementationChanged ? "changed" : "unchanged",
      sourceStatus: sourceStatus({ file, slice: !ref.symbol && fileChanged ? { ...slice, found: false, reason: "stale" } : slice, moved, implementationChanged }),
      reason: slice.reason ?? (file.status === "readable" ? null : file.status),
      candidates: slice.candidates ?? [],
      scannedAt,
      // Kept in the process-local index only; never returned by default.
      content: file.status === "readable" ? file.content : null,
    };
    bindings.push(binding);
    const kinds = changeKinds(previousBinding, binding);
    if (kinds.length) {
      changes.push({
        refId: binding.id,
        blockId: binding.blockId,
        path: binding.relativePath ?? binding.path,
        symbol: binding.symbol,
        kinds,
        previous: {
          bindingStatus: previousBinding.bindingStatus,
          implementationStatus: previousBinding.implementationStatus,
          startLine: previousBinding.startLine ?? null,
          endLine: previousBinding.endLine ?? null,
          fileHash: previousBinding.fileHash ?? null,
          nodeHash: previousBinding.nodeHash ?? null,
        },
        current: {
          bindingStatus: binding.bindingStatus,
          implementationStatus: binding.implementationStatus,
          startLine: binding.startLine,
          endLine: binding.endLine,
          fileHash: binding.fileHash,
          nodeHash: binding.nodeHash,
        },
      });
    }
  }
  const sourceRevision = hashText(bindings
    .map((item) => [item.id, item.bindingStatus, item.fileHash, item.nodeHash, item.startLine, item.endLine])
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map((item) => item.join("|"))
    .join("\n"));
  return {
    bindings,
    changes,
    changed: changes.length > 0,
    sourceRevision,
    scannedAt,
    fileCache,
  };
}

export function bindingIdentity(binding) {
  return {
    id: binding.id,
    blockId: binding.blockId,
    path: binding.relativePath ?? binding.path,
    symbol: binding.symbol,
    language: binding.language,
    signature: binding.signature,
    fileHash: binding.fileHash,
    nodeHash: binding.nodeHash,
    signatureHash: binding.signatureHash,
    startLine: binding.startLine,
    endLine: binding.endLine,
    bindingStatus: binding.bindingStatus,
  };
}

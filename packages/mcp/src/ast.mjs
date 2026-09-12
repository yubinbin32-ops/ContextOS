import path from "node:path";
import fs from "node:fs/promises";

/**
 * Supported language detection based on file extension
 */
export function detectLanguage(filePath = "") {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".ts":
    case ".tsx":
      return "typescript";
    case ".js":
    case ".jsx":
    case ".mjs":
    case ".cjs":
      return "javascript";
    case ".swift":
      return "swift";
    case ".py":
      return "python";
    case ".go":
      return "go";
    case ".rs":
      return "rust";
    case ".kt":
    case ".kts":
      return "kotlin";
    case ".java":
      return "java";
    case ".c":
    case ".h":
    case ".cpp":
    case ".cc":
    case ".cxx":
    case ".hpp":
      return "cpp";
    default:
      return "text";
  }
}

/**
 * Extract symbols (functions, classes, interfaces, types) from source code using resilient syntax patterns
 */
export function extractSymbols(sourceCode, { language = null, filePath = "" } = {}) {
  const lines = sourceCode.split(/\r?\n/);
  const symbols = [];

  // A file path is the least surprising language hint for callers that are
  // indexing a repository. Keep the old TypeScript default only when no path
  // is available, while still honoring an explicit language override.
  const lang = language && language !== "text"
    ? language
    : (filePath ? detectLanguage(filePath) : "typescript");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;
    const trimmed = line.trim();

    // Skip comments and empty lines
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("#") || trimmed.startsWith("/*")) {
      continue;
    }

    if (lang === "typescript" || lang === "javascript") {
      // Functions
      const fnMatch = trimmed.match(/^(?:export\s+)?(?:async\s+)?function(?:\s*\*|\s+)\s*([A-Za-z0-9_$]+)\s*\(/);
      if (fnMatch) {
        symbols.push({
          name: fnMatch[1],
          kind: "function",
          signature: trimmed.replace(/\{$/, "").trim(),
          startLine: lineNum,
          endLine: findBlockEnd(lines, i),
        });
        continue;
      }

      // Large template constants such as a database schema are not function
      // bodies, but they are still useful file-local anchors for freshness.
      const templateConstMatch = trimmed.match(/^(?:export\s+)?const\s+([A-Za-z0-9_$]+)\s*=\s*`/);
      if (templateConstMatch) {
        let endLine = lineNum;
        for (let j = i; j < lines.length; j++) {
          if (lines[j].includes("`") && (j !== i || lines[j].lastIndexOf("`") > lines[j].indexOf("`"))) {
            endLine = j + 1;
            break;
          }
        }
        symbols.push({
          name: templateConstMatch[1],
          kind: "constant",
          signature: `const ${templateConstMatch[1]} = \`...\``,
          startLine: lineNum,
          endLine,
        });
        continue;
      }

      // Class/object methods. Keeping method symbols explicit is important for
      // AST-bound edits: a source reference such as `Service.process` must not
      // fall back to the containing class or to the first source reference.
      const methodMatch = trimmed.match(/^(?:(?:public|private|protected|static|async|override|abstract|get|set)\s+)*([A-Za-z_$][A-Za-z0-9_$]*)\s*\(([^)]*)\)(?:\s*:\s*[^\{]+)?\s*\{/);
      if (methodMatch && !new Set(["if", "for", "while", "switch", "catch", "function"]).has(methodMatch[1])) {
        symbols.push({
          name: methodMatch[1],
          kind: "method",
          signature: trimmed.replace(/\{$/, "").trim(),
          startLine: lineNum,
          endLine: findBlockEnd(lines, i),
        });
        continue;
      }

      // Const arrow functions
      const arrowMatch = trimmed.match(/^(?:export\s+)?const\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s+)?(?:\((?:[\s\S]*?)\)|[A-Za-z0-9_$]+)\s*(?::\s*[^=]+)?\s*=>/);
      if (arrowMatch) {
        symbols.push({
          name: arrowMatch[1],
          kind: "function",
          signature: `${arrowMatch[1]} = ${arrowMatch[0].replace(/^(?:export\s+)?const\s+[A-Za-z0-9_$]+\s*=\s*/, "")}`,
          startLine: lineNum,
          endLine: findBlockEnd(lines, i),
        });
        continue;
      }

      // Classes
      const classMatch = trimmed.match(/^(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z0-9_$]+)(?:\s+extends\s+[^{]+)?(?:\s+implements\s+[^{]+)?/);
      if (classMatch) {
        symbols.push({
          name: classMatch[1],
          kind: "class",
          signature: classMatch[0].replace(/^export\s+/, "").trim(),
          startLine: lineNum,
          endLine: findBlockEnd(lines, i),
        });
        continue;
      }

      // Interfaces
      const ifaceMatch = trimmed.match(/^(?:export\s+)?interface\s+([A-Za-z0-9_$]+)/);
      if (ifaceMatch) {
        symbols.push({
          name: ifaceMatch[1],
          kind: "interface",
          signature: ifaceMatch[0].replace(/^export\s+/, "").trim(),
          startLine: lineNum,
          endLine: findBlockEnd(lines, i),
        });
        continue;
      }

      // Type aliases
      const typeMatch = trimmed.match(/^(?:export\s+)?type\s+([A-Za-z0-9_$]+)\s*=/);
      if (typeMatch) {
        symbols.push({
          name: typeMatch[1],
          kind: "type",
          signature: trimmed.replace(/;$/, ""),
          startLine: lineNum,
          endLine: lineNum,
        });
        continue;
      }
    } else if (lang === "swift") {
      // Swift func
      const swiftFuncMatch = trimmed.match(
        /^(?:(?:public|private|fileprivate|internal|open|nonisolated|static|class|mutating|override|final|async|throws|rethrows)\s+)*func\s+([A-Za-z0-9_]+)\s*\(/,
      );
      if (swiftFuncMatch) {
        // Swift permits long signatures to place the closing parenthesis and
        // opening brace on later lines. The name is the stable identity; the
        // compact signature is assembled only for display.
        let signature = trimmed;
        if (!trimmed.includes(")")) {
          for (let j = i + 1; j < Math.min(lines.length, i + 12); j++) {
            signature += ` ${lines[j].trim()}`;
            if (lines[j].includes("{")) break;
          }
        }
        symbols.push({
          name: swiftFuncMatch[1],
          kind: "function",
          signature: signature.replace(/\{$/, "").trim(),
          startLine: lineNum,
          endLine: findBlockEnd(lines, i),
        });
        continue;
      }

      // Computed properties (notably SwiftUI `body` and view sections) are
      // source identities too. Treat only properties with a brace body as
      // AST-addressable; stored properties remain data, not mutation slices.
      const swiftPropertyMatch = trimmed.match(
        /^(?:(?:public|private|fileprivate|internal|open)\s+)?(?:private\(set\)\s+)?(?:static\s+|class\s+)?var\s+([A-Za-z0-9_]+)(?:\s*:\s*[^={]+)?\s*\{/,
      );
      if (swiftPropertyMatch) {
        symbols.push({
          name: swiftPropertyMatch[1],
          kind: "property",
          signature: trimmed.replace(/\{$/, "").trim(),
          startLine: lineNum,
          endLine: findBlockEnd(lines, i),
        });
        continue;
      }

      // Swift struct / class / enum / protocol
      const swiftTypeMatch = trimmed.match(/^(?:public\s+|private\s+|fileprivate\s+|internal\s+|open\s+)?(?:final\s+)?(struct|class|enum|protocol)\s+([A-Za-z0-9_]+)/);
      if (swiftTypeMatch) {
        symbols.push({
          name: swiftTypeMatch[2],
          kind: swiftTypeMatch[1],
          signature: trimmed.replace(/\{$/, "").trim(),
          startLine: lineNum,
          endLine: findBlockEnd(lines, i),
        });
        continue;
      }
    } else if (lang === "python") {
      // Python def / async def
      const pyFuncMatch = trimmed.match(/^(?:async\s+)?def\s+([A-Za-z0-9_]+)\s*(\([^)]*\)(?:\s*->\s*[^:]+)?:)/);
      if (pyFuncMatch) {
        symbols.push({
          name: pyFuncMatch[1],
          kind: "function",
          signature: `def ${pyFuncMatch[1]}${pyFuncMatch[2]}`,
          startLine: lineNum,
          endLine: findPythonBlockEnd(lines, i),
        });
        continue;
      }

      // Python class
      const pyClassMatch = trimmed.match(/^class\s+([A-Za-z0-9_]+)(?:\([^)]*\))?:/);
      if (pyClassMatch) {
        symbols.push({
          name: pyClassMatch[1],
          kind: "class",
          signature: pyClassMatch[0],
          startLine: lineNum,
          endLine: findPythonBlockEnd(lines, i),
        });
        continue;
      }
    } else if (lang === "go") {
      // Go func / method
      const goFuncMatch = trimmed.match(/^func\s+(?:\((?:[^)]+)\)\s+)?([A-Za-z0-9_]+)\s*\(/);
      if (goFuncMatch) {
        symbols.push({
          name: goFuncMatch[1],
          kind: trimmed.startsWith("func (") ? "method" : "function",
          signature: trimmed.replace(/\{$/, "").trim(),
          startLine: lineNum,
          endLine: findBlockEnd(lines, i),
        });
        continue;
      }

      // Go struct
      const goStructMatch = trimmed.match(/^type\s+([A-Za-z0-9_]+)\s+struct\b/);
      if (goStructMatch) {
        symbols.push({
          name: goStructMatch[1],
          kind: "struct",
          signature: `type ${goStructMatch[1]} struct`,
          startLine: lineNum,
          endLine: findBlockEnd(lines, i),
        });
        continue;
      }

      // Go interface
      const goIfaceMatch = trimmed.match(/^type\s+([A-Za-z0-9_]+)\s+interface\b/);
      if (goIfaceMatch) {
        symbols.push({
          name: goIfaceMatch[1],
          kind: "interface",
          signature: `type ${goIfaceMatch[1]} interface`,
          startLine: lineNum,
          endLine: findBlockEnd(lines, i),
        });
        continue;
      }
    } else if (lang === "rust") {
      // Rust fn / async fn
      const rustFnMatch = trimmed.match(/^(?:pub(?:\([^)]+\))?\s+)?(?:async\s+)?(?:unsafe\s+)?(?:const\s+)?fn\s+([A-Za-z0-9_]+)/);
      if (rustFnMatch) {
        symbols.push({
          name: rustFnMatch[1],
          kind: "function",
          signature: trimmed.replace(/\{$/, "").trim(),
          startLine: lineNum,
          endLine: findBlockEnd(lines, i),
        });
        continue;
      }

      // Rust struct / enum / trait / union
      const rustTypeMatch = trimmed.match(/^(?:pub(?:\([^)]+\))?\s+)?(struct|enum|trait|union)\s+([A-Za-z0-9_]+)/);
      if (rustTypeMatch) {
        symbols.push({
          name: rustTypeMatch[2],
          kind: rustTypeMatch[1],
          signature: trimmed.replace(/\{$/, "").trim(),
          startLine: lineNum,
          endLine: trimmed.includes(";") ? lineNum : findBlockEnd(lines, i),
        });
        continue;
      }

      // Rust impl
      const rustImplMatch = trimmed.match(/^impl(?:<[^>]+>)?\s+(?:[A-Za-z0-9_:]+\s+for\s+)?([A-Za-z0-9_]+)/);
      if (rustImplMatch) {
        symbols.push({
          name: rustImplMatch[1],
          kind: "impl",
          signature: trimmed.replace(/\{$/, "").trim(),
          startLine: lineNum,
          endLine: findBlockEnd(lines, i),
        });
        continue;
      }
    } else if (lang === "java" || lang === "kotlin") {
      // Java/Kotlin class / interface / enum / record
      const javaTypeMatch = trimmed.match(/^(?:public\s+|private\s+|protected\s+)?(?:abstract\s+|final\s+|static\s+)?(class|interface|enum|record)\s+([A-Za-z0-9_$]+)/);
      if (javaTypeMatch) {
        symbols.push({
          name: javaTypeMatch[2],
          kind: javaTypeMatch[1],
          signature: trimmed.replace(/\{$/, "").trim(),
          startLine: lineNum,
          endLine: findBlockEnd(lines, i),
        });
        continue;
      }

      // Java/Kotlin method
      const javaMethodMatch = trimmed.match(/^(?:(?:public|private|protected|static|final|abstract|synchronized|native|default|fun)\s+)+([A-Za-z0-9_$<>\[\],\s]+)\s+([A-Za-z0-9_$]+)\s*\([^)]*\)\s*(?:throws\s+[\w,\s]+)?\s*\{/);
      if (javaMethodMatch && !new Set(["if", "for", "while", "switch", "catch"]).has(javaMethodMatch[2])) {
        symbols.push({
          name: javaMethodMatch[2],
          kind: "method",
          signature: trimmed.replace(/\{$/, "").trim(),
          startLine: lineNum,
          endLine: findBlockEnd(lines, i),
        });
        continue;
      }
    }
  }

  // Attach a qualified name after the first pass so methods/properties inside
  // types remain addressable even when a file contains repeated names such as
  // SwiftUI's `body`. The original short `name` is preserved for editor
  // search and backwards-compatible callers.
  const typeSymbols = symbols.filter((item) => ["class", "struct", "enum", "protocol", "interface", "trait", "impl"].includes(item.kind));
  return symbols.map((item) => {
    if (["class", "struct", "enum", "protocol", "interface", "trait", "impl"].includes(item.kind)) return item;
    const owner = typeSymbols
      .filter((type) => type.startLine < item.startLine && type.endLine >= item.endLine)
      .sort((left, right) => (left.endLine - left.startLine) - (right.endLine - right.startLine))[0];
    return owner ? { ...item, qualifiedName: `${owner.name}.${item.name}` } : item;
  });
}

/**
 * Locate matching braces to find the end line of a block
 */
function findBlockEnd(lines, startIdx) {
  let openBraces = 0;
  let started = false;

  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i];
    for (const char of line) {
      if (char === "{") {
        openBraces++;
        started = true;
      } else if (char === "}") {
        openBraces--;
      }
    }
    if (started && openBraces <= 0) {
      return i + 1;
    }
  }
  return Math.min(lines.length, startIdx + 30);
}

/**
 * Locate python block indentation end
 */
function findPythonBlockEnd(lines, startIdx) {
  const startIndent = lines[startIdx].search(/\S|$/);
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const currentIndent = line.search(/\S|$/);
    if (currentIndent <= startIndent) {
      return i;
    }
  }
  return lines.length;
}

/**
 * Extract a concise code slice for a specific symbol or line range
 */
export function extractSymbolSlice(sourceCode, {
  symbol = null,
  startLine = null,
  endLine = null,
  maxLines = 50,
  language = null,
  filePath = "",
} = {}) {
  const lines = sourceCode.split(/\r?\n/);

  let targetStart = startLine;
  let targetEnd = endLine;
  let matched = null;
  let resolutionReason = null;
  let resolutionCandidates = [];

  if (symbol) {
    const resolution = resolveSymbolMatch(sourceCode, {
      symbol,
      language: language || (filePath ? detectLanguage(filePath) : "typescript"),
      filePath,
    });
    matched = resolution.matched;
    resolutionReason = resolution.reason;
    resolutionCandidates = resolution.candidates;
    if (matched) {
      targetStart = matched.startLine;
      targetEnd = matched.endLine;
    }
  }

  // A stale symbol reference must be visible to the caller, not silently
  // converted into an unrelated line-range slice.
  if (symbol && !matched) {
    return {
      found: false,
      symbol,
      signature: null,
      startLine: null,
      endLine: null,
      totalLines: 0,
      code: "",
      reason: resolutionReason || "missing",
      candidates: resolutionCandidates,
    };
  }

  if (!targetStart) targetStart = 1;
  if (!targetEnd) targetEnd = Math.min(lines.length, targetStart + maxLines - 1);

  const totalLines = targetEnd - targetStart + 1;
  const sliceLines = lines.slice(targetStart - 1, Math.min(targetEnd, targetStart + maxLines - 1));

  let result = sliceLines.join("\n");
  if (totalLines > maxLines) {
    result += `\n... [${totalLines - maxLines} lines collapsed; use entity_open or editor for full body]`;
  }

  return {
    found: Boolean(matched || startLine || endLine),
    symbol: matched?.qualifiedName ?? matched?.name ?? symbol,
    signature: matched?.signature ?? null,
    startLine: targetStart,
    endLine: targetEnd,
    totalLines,
    code: result,
    reason: null,
  };
}

/**
 * Resolve one symbol without trusting a previously stored line range.
 * A short method name is useful inside a file, but duplicate methods are not
 * safe to mutate or stream implicitly. Qualified names therefore match their
 * leaf only when that leaf is unique in the current file.
 */
export function resolveSymbolMatch(sourceCode, { symbol, language = null, filePath = "" } = {}) {
  if (!symbol?.trim()) return { matched: null, reason: "missing", candidates: [] };
  const symbols = extractSymbols(sourceCode, {
    language: language || (filePath ? detectLanguage(filePath) : "typescript"),
    filePath,
  });
  const requested = symbol.trim();
  const signatureName = requested.includes("(") ? requested.slice(0, requested.indexOf("(")).trim() : requested;
  const leaf = signatureName.split(".").at(-1);
  const rawCandidates = signatureName.includes(".")
    ? symbols.filter((item) => item.name === signatureName || item.qualifiedName === signatureName)
    : symbols.filter((item) =>
      item.name === signatureName ||
      item.qualifiedName === signatureName ||
      item.name === leaf ||
      item.qualifiedName === leaf ||
      item.qualifiedName?.endsWith(`.${signatureName}`),
    );
  const callableCandidates = rawCandidates.filter((item) => ["function", "method"].includes(item.kind));
  const candidates = requested.includes("(") && callableCandidates.length > 0 ? callableCandidates : rawCandidates;
  const candidateNames = candidates.map((item) => item.qualifiedName ?? item.name);
  if (candidates.length === 1) return { matched: candidates[0], reason: null, candidates: candidateNames };
  if (candidates.length > 1) return { matched: null, reason: "ambiguous", candidates: candidateNames };
  return { matched: null, reason: "missing", candidates: [] };
}

/**
 * Generate a clean, unified Code Stream across a Chain of nodes
 */
export function buildChainCodeStream(chainNodes = [], { maxTotalChars = 4000, mode = "contract" } = {}) {
  const sections = [];
  let currentChars = 0;

  for (const node of chainNodes) {
    const { blockId, title, filePath, symbol, contract, signature, sourceStatus, startLine, endLine } = node;
    const fallbackLocator = filePath || symbol || startLine
      ? [{ path: filePath, symbol, signature, sourceStatus, startLine, endLine, role: "implementation" }]
      : [];
    const locators = Array.isArray(node.locators) && node.locators.length ? node.locators : fallbackLocator;
    const header = `// -------------------------------------------------------------
// [Node: ${blockId}] ${title} · ${locators.length} locator(s)
// -------------------------------------------------------------`;

    const bodyLines = [
      `// Contract: ${contract || "(not declared)"}`,
      `// Source status: ${sourceStatus || locators[0]?.sourceStatus || locators[0]?.bindingStatus || (locators.length ? "mapped" : "virtual")}`,
      ...(locators.length
        ? locators.flatMap((locator, index) => [
          `// Locator ${index + 1}: ${locator.path || "—"}${locator.symbol ? ` :: ${locator.symbol}` : ""}`,
          `//   Role: ${locator.role || "implementation"} · Status: ${locator.sourceStatus || locator.bindingStatus || "unknown"}`,
          `//   Lines: ${locator.startLine && locator.endLine ? `${locator.startLine}-${locator.endLine}` : "—"}${locator.signature ? ` · ${locator.signature}` : ""}`,
          ...(locator.sourceStatus === "line_only" ? ["//   This is a line-only binding; resolve a symbol before implementation work"] : []),
          ...(["missing", "unreadable", "outside_project", "stale", "ambiguous"].includes(locator.sourceStatus)
            ? [`//   Locator is ${locator.sourceStatus}; refresh or rebind before opening implementation`]
            : []),
        ])
        : [`// Source: virtual/no SourceRef`]),
    ];

    const section = `${header}\n${bodyLines.join("\n")}\n`;
    if (currentChars + section.length > maxTotalChars && sections.length > 0) {
      sections.push(`// ... [Remaining nodes truncated for context budget]`);
      break;
    }

    sections.push(section);
    currentChars += section.length;
  }

  return sections.join("\n");
}

/**
 * Replace a specific symbol's implementation in source code using AST boundary detection
 */
export function replaceSymbolSlice(sourceCode, { symbol, newCode, language = null }) {
  const resolution = resolveSymbolMatch(sourceCode, { symbol, language: language || "typescript" });
  if (!resolution.matched) {
    const suffix = resolution.reason === "ambiguous"
      ? `; candidates: ${resolution.candidates.join(", ")}`
      : "";
    throw new Error(`Symbol "${symbol}" ${resolution.reason === "ambiguous" ? "is ambiguous" : "not found in source code"}${suffix}`);
  }
  const matched = resolution.matched;

  const lines = sourceCode.split(/\r?\n/);
  const before = lines.slice(0, matched.startLine - 1);
  const after = lines.slice(matched.endLine);
  const newLines = newCode.split(/\r?\n/);

  return {
    updatedCode: [...before, ...newLines, ...after].join("\n"),
    replacedLines: {
      startLine: matched.startLine,
      oldEndLine: matched.endLine,
      newEndLine: matched.startLine + newLines.length - 1,
    },
    symbol: matched.qualifiedName ?? matched.name,
  };
}

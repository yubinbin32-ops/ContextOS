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
    default:
      return "text";
  }
}

/**
 * Extract symbols (functions, classes, interfaces, types) from source code using resilient syntax patterns
 */
export function extractSymbols(sourceCode, { language = "typescript", filePath = "" } = {}) {
  const lines = sourceCode.split(/\r?\n/);
  const symbols = [];

  const lang = language === "text" && filePath ? detectLanguage(filePath) : language;

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
      const fnMatch = trimmed.match(/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*(\([^{]*\))/);
      if (fnMatch) {
        symbols.push({
          name: fnMatch[1],
          kind: "function",
          signature: `${fnMatch[1]}${fnMatch[2]}`,
          startLine: lineNum,
          endLine: findBlockEnd(lines, i),
        });
        continue;
      }

      // Const arrow functions
      const arrowMatch = trimmed.match(/^(?:export\s+)?const\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s+)?(\([^{=]*\)\s*(?::\s*[^=]+)?)\s*=>/);
      if (arrowMatch) {
        symbols.push({
          name: arrowMatch[1],
          kind: "function",
          signature: `${arrowMatch[1]} = ${arrowMatch[2]} =>`,
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
      const swiftFuncMatch = trimmed.match(/^(?:public\s+|private\s+|fileprivate\s+|internal\s+|open\s+)?(?:static\s+|class\s+)?(?:mutating\s+)?func\s+([A-Za-z0-9_]+)\s*(\([^{]*\))/);
      if (swiftFuncMatch) {
        symbols.push({
          name: swiftFuncMatch[1],
          kind: "function",
          signature: `${swiftFuncMatch[1]}${swiftFuncMatch[2]}`,
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
    }
  }

  return symbols;
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
export function extractSymbolSlice(sourceCode, { symbol = null, startLine = null, endLine = null, maxLines = 50 } = {}) {
  const lines = sourceCode.split(/\r?\n/);

  let targetStart = startLine;
  let targetEnd = endLine;

  if (symbol && (!targetStart || !targetEnd)) {
    const symbols = extractSymbols(sourceCode);
    const matched = symbols.find((s) => s.name === symbol || s.name.endsWith(`.${symbol}`));
    if (matched) {
      targetStart = matched.startLine;
      targetEnd = matched.endLine;
    }
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
    startLine: targetStart,
    endLine: targetEnd,
    totalLines,
    code: result,
  };
}

/**
 * Generate a clean, unified Code Stream across a Chain of nodes
 */
export function buildChainCodeStream(chainNodes = [], { maxTotalChars = 4000 } = {}) {
  const sections = [];
  let currentChars = 0;

  for (const node of chainNodes) {
    const { blockId, title, filePath, symbol, code, contract } = node;
    const header = `// -------------------------------------------------------------
// [Node: ${blockId}] ${title} ${filePath ? `(${filePath}${symbol ? ` :: ${symbol}` : ""})` : ""}
// -------------------------------------------------------------`;

    let body = "";
    if (code) {
      body = code;
    } else if (contract) {
      body = `// Planned Contract (Unmaterialized Facade):\n// ${contract}`;
    } else {
      body = `// Planned Block (No code facade yet)`;
    }

    const section = `${header}\n${body}\n`;
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
  const symbols = extractSymbols(sourceCode, { language: language || "typescript" });
  const matched = symbols.find((s) => s.name === symbol || s.name.endsWith(`.${symbol}`));
  if (!matched) {
    throw new Error(`Symbol "${symbol}" not found in source code`);
  }

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
    symbol: matched.name,
  };
}

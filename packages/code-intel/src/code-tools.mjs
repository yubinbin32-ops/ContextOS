import fs from 'node:fs';
import path from 'node:path';
import { LanguageRegistry, calculateHash } from './language-registry.mjs';

export class CodeTools {
  /**
   * 1. Outline: Progressive L1 structure view
   */
  static outline(filePath, content, options = {}) {
    const structure = LanguageRegistry.parseStructure(filePath, content, options);

    const lines = [];
    lines.push(`# Outline: \`${filePath}\` (${structure.language}, capability: ${structure.capability}, ${structure.totalLines} lines)`);

    if (structure.imports.length > 0) {
      lines.push('\n### Imports:');
      for (const imp of structure.imports) {
        lines.push(`- \`${imp.source}\` (L${imp.line})`);
      }
    }

    if (structure.symbols.length > 0) {
      lines.push('\n### Symbols:');
      const renderedMethodKeys = new Set();
      for (const sym of structure.symbols) {
        if (Array.isArray(sym.methods)) {
          for (const m of sym.methods) {
            renderedMethodKeys.add(`${m.name}:${m.startLine}:${m.endLine}`);
          }
        }
      }
      const CONTAINER_KINDS = new Set(['class', 'struct', 'trait', 'interface', 'extension', 'impl', 'record', 'object', 'enum']);

      for (const sym of structure.symbols) {
        const isContainer = CONTAINER_KINDS.has(sym.kind) || (Array.isArray(sym.methods) && sym.methods.length > 0);
        if (isContainer) {
          lines.push(`- **${sym.kind}** \`${sym.name}\` [L${sym.startLine}-L${sym.endLine}] (hash: \`${sym.hash}\`)`);
          if (sym.methods && sym.methods.length > 0) {
            for (const m of sym.methods) {
              const displaySig = m.signature ? m.signature : m.name;
              const callsSuffix = m.calls && m.calls.length > 0 ? ` -> calls: [${m.calls.join(', ')}]` : '';
              lines.push(`  - **method** \`${displaySig}\` [L${m.startLine}-L${m.endLine}] (hash: \`${m.hash}\`)${callsSuffix}`);
            }
          }
        } else if (renderedMethodKeys.has(`${sym.name}:${sym.startLine}:${sym.endLine}`)) {
          // Skip methods or constructors that are rendered under their container
          continue;
        } else if (sym.kind === 'function') {
          const displaySig = sym.signature ? sym.signature : sym.name;
          const callsSuffix = sym.calls && sym.calls.length > 0 ? ` -> calls: [${sym.calls.join(', ')}]` : '';
          lines.push(`- **func** \`${displaySig}\` [L${sym.startLine}-L${sym.endLine}] (hash: \`${sym.hash}\`)${callsSuffix}`);
        } else if (sym.kind === 'method' || sym.kind === 'constructor') {
          const displaySig = sym.signature ? sym.signature : sym.name;
          const callsSuffix = sym.calls && sym.calls.length > 0 ? ` -> calls: [${sym.calls.join(', ')}]` : '';
          lines.push(`- **method** \`${displaySig}\` [L${sym.startLine}-L${sym.endLine}] (hash: \`${sym.hash}\`)${callsSuffix}`);
        } else {
          lines.push(`- **${sym.kind}** \`${sym.name}\` [L${sym.startLine}-L${sym.endLine}] (hash: \`${sym.hash}\`)`);
        }
      }
    }

    return {
      filePath,
      structure,
      markdown: lines.join('\n'),
    };
  }

  /**
   * 1.5 Create: Create new file and initialize AST anchors
   */
  static create(filePath, content = '') {
    const structure = LanguageRegistry.parseStructure(filePath, content);
    const newHash = calculateHash(content);
    return {
      filePath,
      content,
      newHash,
      locators: structure.symbols.map((s) => ({
        path: filePath,
        symbol: s.name,
        startLine: s.startLine,
        endLine: s.endLine,
        hash: s.hash,
        role: 'implementation',
      })),
    };
  }

  /**
   * 2. Read: Surgical code reader by symbol or line range
   */
  static read(filePath, content, selector = {}) {
    const lines = content.split(/\r?\n/);
    let startLine = null;
    let endLine = null;
    let targetSymbol = null;

    // String selector parsing: 'file-symbolName' or 'file-L10-L25'
    if (typeof selector === 'string') {
      const rangeMatch = selector.match(/^(?:.*-)?L(\d+)-L(\d+)$/);
      if (rangeMatch) {
        startLine = parseInt(rangeMatch[1], 10);
        endLine = parseInt(rangeMatch[2], 10);
      } else {
        const symMatch = selector.match(/^(?:.*-)?([A-Za-z0-9_.]+)$/);
        if (symMatch) {
          targetSymbol = symMatch[1];
        }
      }
    } else if (selector.symbol) {
      targetSymbol = selector.symbol;
    } else if (selector.method) {
      targetSymbol = selector.method;
    } else if (selector.startLine !== undefined || selector.endLine !== undefined) {
      startLine = selector.startLine !== undefined && selector.startLine !== null ? Number(selector.startLine) : 1;
      endLine = selector.endLine !== undefined && selector.endLine !== null ? Number(selector.endLine) : Math.min(lines.length, startLine + 100);
    } else if (selector.fullFile === true) {
      startLine = 1;
      endLine = lines.length;
    } else {
      throw new Error(
        'CodeTools.read: Selector must specify symbol or line range (startLine, endLine). Full file reads require fullFile: true.'
      );
    }

    if (targetSymbol) {
      const structure = LanguageRegistry.parseStructure(filePath, content);
      const matched =
        structure.symbols.find((s) => s.name === targetSymbol) ||
        structure.symbols.find((s) => s.shortName === targetSymbol) ||
        structure.symbols.find((s) => s.name.endsWith(`.${targetSymbol}`));

      if (!matched) {
        throw new Error(`Symbol '${targetSymbol}' not found in ${filePath}`);
      }
      startLine = matched.startLine;
      endLine = matched.endLine;
    }

    startLine = Math.max(1, Math.min(startLine, lines.length));
    endLine = Math.max(startLine, Math.min(endLine, lines.length));

    const selectedLines = lines.slice(startLine - 1, endLine);
    const codeSnippet = selectedLines.join('\n');
    const hash = calculateHash(codeSnippet);

    return {
      filePath,
      startLine,
      endLine,
      totalLines: lines.length,
      symbol: targetSymbol,
      code: codeSnippet,
      hash,
    };
  }

  /**
   * 3. Edit: Surgical code edit with automatic relocalization (re-anchoring)
   */
  static edit(filePath, content, { targetContent = null, replacementContent, startLine = null, endLine = null, symbol = null } = {}) {
    if (replacementContent === undefined || typeof replacementContent !== 'string') {
      throw new Error('CodeTools.edit requires replacementContent');
    }

    const lines = content.split(/\r?\n/);
    let effectiveStart = startLine !== null && startLine !== undefined ? Number(startLine) : null;
    let effectiveEnd = endLine !== null && endLine !== undefined ? Number(endLine) : null;

    if (symbol) {
      const structure = LanguageRegistry.parseStructure(filePath, content);
      const matched = structure.symbols.find((s) => s.name === symbol)
        || structure.symbols.find((s) => s.shortName === symbol)
        || structure.symbols.find((s) => s.name.endsWith(`.${symbol}`));
      if (!matched) throw new Error(`Symbol '${symbol}' not found in ${filePath}`);
      if (effectiveStart === null) effectiveStart = matched.startLine;
      if (effectiveEnd === null) effectiveEnd = matched.endLine;
    }

    const hasRange = effectiveStart !== null || effectiveEnd !== null;
    let newContent = '';

    if (!targetContent) {
      if (!hasRange || effectiveStart === null || effectiveEnd === null) {
        throw new Error('CodeTools.edit requires targetContent or a complete startLine/endLine (or symbol) range');
      }
      if (!Number.isInteger(effectiveStart) || !Number.isInteger(effectiveEnd)) {
        throw new Error('CodeTools.edit startLine and endLine must be integers');
      }
      if (effectiveStart < 1 || effectiveEnd < effectiveStart || effectiveEnd > lines.length) {
        throw new Error(`CodeTools.edit range [L${effectiveStart}-L${effectiveEnd}] is outside ${filePath} (1-${lines.length})`);
      }
      newContent = [
        ...lines.slice(0, effectiveStart - 1),
        ...replacementContent.split(/\r?\n/),
        ...lines.slice(effectiveEnd),
      ].join('\n');
    } else {
      if (typeof targetContent !== 'string') {
        throw new Error('CodeTools.edit targetContent must be a string');
      }
      if (hasRange) {
        const chunkStart = Math.max(0, (effectiveStart ?? 1) - 1);
        const chunkEnd = Math.min(lines.length, effectiveEnd ?? lines.length);
        const chunk = lines.slice(chunkStart, chunkEnd).join('\n');
        const occurrences = chunk.split(targetContent).length - 1;
        if (occurrences === 0) {
          throw new Error(
            `TargetContent not found in specified range [L${effectiveStart ?? 1}-L${effectiveEnd ?? lines.length}] of ${filePath}`
          );
        }
        if (occurrences > 1) {
          throw new Error(
            `TargetContent found ${occurrences} times in specified range [L${effectiveStart ?? 1}-L${effectiveEnd ?? lines.length}] of ${filePath}`
          );
        }
        const replacedChunk = chunk.replace(targetContent, () => replacementContent);
        newContent = [
          ...lines.slice(0, chunkStart),
          replacedChunk,
          ...lines.slice(chunkEnd),
        ].join('\n');
      } else {
        const occurrences = content.split(targetContent).length - 1;
        if (occurrences === 0) {
          throw new Error(`TargetContent not found in ${filePath}`);
        }
        if (occurrences > 1) {
          throw new Error(
            `TargetContent found ${occurrences} times in ${filePath}. Provide startLine and endLine (top-level or in selector) to disambiguate.`
          );
        }
        newContent = content.replace(targetContent, () => replacementContent);
      }
    }

    // Re-anchor: re-parse the new content to get updated locators
    const updatedStructure = LanguageRegistry.parseStructure(filePath, newContent);
    const newHash = calculateHash(newContent);

    return {
      filePath,
      newContent,
      newHash,
      updatedLocators: updatedStructure.symbols.map((s) => ({
        path: filePath,
        symbol: s.name,
        startLine: s.startLine,
        endLine: s.endLine,
        hash: s.hash,
        role: 'implementation',
      })),
    };
  }

  /**
   * 4. Search: Find symbol or pattern (VS Code Document Symbol search)
   */
  static search(filePath, content, query) {
    const structure = LanguageRegistry.parseStructure(filePath, content);
    const queryLower = query.toLowerCase();

    const matchingSymbols = structure.symbols
      .filter((s) => {
        const nameMatch = s.name.toLowerCase().includes(queryLower);
        const shortMatch = s.shortName && s.shortName.toLowerCase().includes(queryLower);
        return nameMatch || shortMatch;
      })
      .map((s) => ({
        symbol: s.name,
        shortName: s.shortName || s.name,
        kind: s.kind,
        container: s.containerName || null,
        signature: s.signature || null,
        startLine: s.startLine,
        endLine: s.endLine,
        hash: s.hash,
      }));

    const lines = content.split(/\r?\n/);
    const matchingLines = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(queryLower)) {
        matchingLines.push({
          line: i + 1,
          content: lines[i].trim(),
        });
      }
    }

    return {
      filePath,
      query,
      matchingSymbols,
      matchingLines: matchingLines.slice(0, 20),
    };
  }

  /**
   * Bounded textual grep. Symbol search only matches declarations, which forces
   * agents to reach for a native `rg`; this covers "where is X mentioned".
   */
  static searchText(repoRoot, query, { limit = 8, maxFiles = 1500, root = null, contextChars = 120, perFileLimit = 3 } = {}) {
    const needle = String(query || '').trim().toLowerCase();
    if (!needle) return { hits: [], scanned: 0, truncated: false };

    const skipDirs = new Set([
      'node_modules', '.git', 'dist', 'build', '.next', '.nuxt', 'coverage', '.contextos',
      '.cache', '.wrangler', 'DerivedData', '.build', 'vendor', 'Pods', 'target', '.venv',
    ]);
    const allowHiddenDirs = new Set(['.github']);
    const files = [];
    const walk = (dir) => {
      if (files.length >= maxFiles) return;
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch (_) {
        return;
      }
      for (const entry of entries) {
        if (files.length >= maxFiles) return;
        if (entry.isDirectory()) {
          if (skipDirs.has(entry.name)) continue;
          if (entry.name.startsWith('.') && !allowHiddenDirs.has(entry.name)) continue;
          walk(path.join(dir, entry.name));
          continue;
        }
        if (!entry.isFile()) continue;
        const relative = path.relative(repoRoot, path.join(dir, entry.name)).split(path.sep).join('/');
        files.push(relative);
      }
    };
    walk(repoRoot);

    const rootPath = root ? path.resolve(repoRoot, String(root)) : null;
    const rootRelative = rootPath
      ? path.relative(repoRoot, rootPath).split(path.sep).join('/').replace(/^\.\//, '').replace(/\/+$/, '')
      : '';
    const rootOutsideProject = rootPath
      ? rootRelative.startsWith('..') || path.isAbsolute(rootRelative)
      : false;
    const rootIsFile = Boolean(rootPath && !rootOutsideProject && fs.existsSync(rootPath) && fs.statSync(rootPath).isFile());
    const hits = [];
    const perFile = new Map();
    let scanned = 0;
    for (const relative of files) {
      if (hits.length >= limit) break;
      if (rootOutsideProject) break;
      if (rootPath) {
        const inRoot = rootIsFile
          ? relative === rootRelative
          : (!rootRelative || relative === rootRelative || relative.startsWith(`${rootRelative}/`));
        if (!inRoot) continue;
      }
      const fullPath = path.join(repoRoot, relative);
      let content;
      try {
        if (fs.statSync(fullPath).size > 200_000) continue;
        content = fs.readFileSync(fullPath, 'utf8');
      } catch (_) {
        continue;
      }
      if (content.includes('\0')) continue; // binary
      scanned += 1;
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        if (hits.length >= limit) break;
        if (!lines[i].toLowerCase().includes(needle)) continue;
        const used = perFile.get(relative) || 0;
        if (used >= perFileLimit) break;
        perFile.set(relative, used + 1);
        hits.push({ path: relative, line: i + 1, content: lines[i].trim().slice(0, contextChars) });
      }
    }
    return { hits, scanned, truncated: files.length >= maxFiles };
  }

  /**
   * 5. Workspace Search: find symbols/methods across project files (VS Code Cmd+T).
   */
  static searchWorkspace(repoRoot, query, candidateFiles = []) {
    const queryLower = query.toLowerCase();
    const results = [];
    for (const relPath of candidateFiles) {
      const fullPath = path.resolve(repoRoot, relPath);
      if (!fs.existsSync(fullPath)) continue;
      try {
        const content = fs.readFileSync(fullPath, 'utf8');
        const structure = LanguageRegistry.parseStructure(relPath, content);
        for (const s of structure.symbols) {
          const nameMatch = s.name.toLowerCase().includes(queryLower);
          const shortMatch = s.shortName && s.shortName.toLowerCase().includes(queryLower);
          if (nameMatch || shortMatch) {
            results.push({
              path: relPath,
              symbol: s.name,
              shortName: s.shortName || s.name,
              kind: s.kind,
              container: s.containerName || null,
              signature: s.signature || null,
              startLine: s.startLine,
              endLine: s.endLine,
              hash: s.hash,
            });
          }
        }
      } catch (_) {}
    }
    return results;
  }
}

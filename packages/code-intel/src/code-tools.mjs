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
      for (const sym of structure.symbols) {
        if (sym.kind === 'class') {
          lines.push(`- **class** \`${sym.name}\` [L${sym.startLine}-L${sym.endLine}] (hash: \`${sym.hash}\`)`);
          if (sym.methods && sym.methods.length > 0) {
            for (const m of sym.methods) {
              const displaySig = m.signature ? m.signature : m.name;
              lines.push(`  - **method** \`${displaySig}\` [L${m.startLine}-L${m.endLine}] (hash: \`${m.hash}\`)`);
            }
          }
        } else if (sym.kind === 'function') {
          const displaySig = sym.signature ? sym.signature : sym.name;
          lines.push(`- **func** \`${displaySig}\` [L${sym.startLine}-L${sym.endLine}] (hash: \`${sym.hash}\`)`);
        } else if (sym.kind !== 'method') {
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
    } else if (selector.startLine && selector.endLine) {
      startLine = Number(selector.startLine);
      endLine = Number(selector.endLine);
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
  static edit(filePath, content, { targetContent, replacementContent, startLine = null, endLine = null, symbol = null }) {
    if (!targetContent || typeof targetContent !== 'string') {
      throw new Error('CodeTools.edit requires targetContent');
    }
    if (replacementContent === undefined || typeof replacementContent !== 'string') {
      throw new Error('CodeTools.edit requires replacementContent');
    }

    let newContent = '';
    const lines = content.split(/\r?\n/);

    if (startLine !== null && endLine !== null) {
      // Range constrained replacement
      const chunkStart = Math.max(0, startLine - 1);
      const chunkEnd = Math.min(lines.length, endLine);
      const chunk = lines.slice(chunkStart, chunkEnd).join('\n');

      if (!chunk.includes(targetContent)) {
        throw new Error(
          `TargetContent not found in specified range [L${startLine}-L${endLine}] of ${filePath}`
        );
      }

      const replacedChunk = chunk.replace(targetContent, replacementContent);
      newContent = [
        ...lines.slice(0, chunkStart),
        replacedChunk,
        ...lines.slice(chunkEnd),
      ].join('\n');
    } else {
      // Global unique occurrence check
      const occurrences = content.split(targetContent).length - 1;
      if (occurrences === 0) {
        throw new Error(`TargetContent not found in ${filePath}`);
      }
      if (occurrences > 1) {
        throw new Error(
          `TargetContent found ${occurrences} times in ${filePath}. Provide startLine and endLine to disambiguate.`
        );
      }
      newContent = content.replace(targetContent, replacementContent);
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
   * 5. Workspace Search: Find symbols/methods across all project files (like VS Code Cmd+T)
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

import crypto from 'node:crypto';
import path from 'node:path';

export function calculateHash(code) {
  return crypto.createHash('sha256').update(code, 'utf8').digest('hex').slice(0, 16);
}

export class LanguageRegistry {
  static getLanguage(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    switch (ext) {
      case '.js':
      case '.mjs':
      case '.cjs':
        return { name: 'javascript', capability: 'L3' };
      case '.ts':
      case '.tsx':
      case '.jsx':
        return { name: 'typescript', capability: 'L3' };
      case '.py':
        return { name: 'python', capability: 'L3' };
      case '.go':
        return { name: 'go', capability: 'L2' };
      case '.rs':
        return { name: 'rust', capability: 'L2' };
      case '.swift':
        return { name: 'swift', capability: 'L2' };
      default:
        return { name: 'text', capability: 'L1' };
    }
  }

  /**
   * Parse symbols, imports, classes and functions from content.
   */
  static parseStructure(filePath, content, options = {}) {
    const { name: lang, capability } = this.getLanguage(filePath);
    const lines = content.split(/\r?\n/);
    const symbols = [];
    const imports = [];

    if (lang === 'javascript' || lang === 'typescript') {
      this._parseJsTs(lines, symbols, imports, content);
    } else if (lang === 'python') {
      this._parsePython(lines, symbols, imports, content);
    } else if (lang === 'go') {
      this._parseGo(lines, symbols, imports, content);
    } else if (lang === 'rust') {
      this._parseRust(lines, symbols, imports, content);
    } else if (lang === 'swift') {
      this._parseSwift(lines, symbols, imports, content);
    } else {
      // Fallback L1
      symbols.push({
        name: path.basename(filePath),
        kind: 'file',
        startLine: 1,
        endLine: Math.max(1, lines.length),
        hash: calculateHash(content),
      });
    }

    return {
      language: lang,
      capability,
      imports: options.imports !== false ? imports : [],
      symbols: symbols.filter((s) => {
        if (options.classes === false && (s.kind === 'class' || s.kind === 'interface' || s.kind === 'struct')) return false;
        if (options.functions === false && (s.kind === 'function' || s.kind === 'method')) return false;
        return true;
      }),
      totalLines: lines.length,
    };
  }

  static _parseJsTs(lines, symbols, imports, fullText) {
    let currentClass = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      const lineNum = i + 1;

      // Imports
      const importMatch = line.match(/^\s*import\s+(?:(?:{[^}]+}|\*\s+as\s+\w+|\w+)\s+from\s+)?['"]([^'"]+)['"]/);
      if (importMatch) {
        imports.push({ source: importMatch[1], line: lineNum });
        continue;
      }

      // TypeScript Interface / Type / Enum
      const typeMatch = line.match(/^\s*(?:export\s+)?(?:default\s+)?(?:interface|type|enum)\s+([A-Za-z0-9_$]+)/);
      if (typeMatch) {
        const typeName = typeMatch[1];
        const endLine = line.includes('{') ? this._findClosingBrace(lines, i) : lineNum;
        const snippet = lines.slice(i, endLine).join('\n');
        symbols.push({
          name: typeName,
          kind: 'interface',
          startLine: lineNum,
          endLine,
          hash: calculateHash(snippet),
        });
        continue;
      }

      // Class
      const classMatch = line.match(/^\s*(?:export\s+)?(?:default\s+)?class\s+([A-Za-z0-9_$]+)/);
      if (classMatch) {
        const className = classMatch[1];
        const endLine = this._findClosingBrace(lines, i);
        const classSnippet = lines.slice(i, endLine).join('\n');
        currentClass = {
          name: className,
          kind: 'class',
          startLine: lineNum,
          endLine,
          hash: calculateHash(classSnippet),
          methods: [],
        };
        symbols.push(currentClass);
        continue;
      }

      // Method inside class (supports async, static, getters, setters)
      if (currentClass && lineNum <= currentClass.endLine) {
        const methodMatch = line.match(/^\s*(?:async\s+)?(?:static\s+)?(?:get\s+|set\s+)?([A-Za-z0-9_$]+)\s*\([^)]*\)\s*\{/);
        if (methodMatch && !['if', 'for', 'while', 'switch', 'catch'].includes(methodMatch[1])) {
          const methodName = methodMatch[1];
          const endLine = this._findClosingBrace(lines, i);
          const methodSnippet = lines.slice(i, endLine).join('\n');
          const methodSymbol = {
            name: `${currentClass.name}.${methodName}`,
            kind: 'method',
            startLine: lineNum,
            endLine,
            hash: calculateHash(methodSnippet),
          };
          symbols.push(methodSymbol);
          currentClass.methods.push(methodSymbol);
          continue;
        }
      } else if (currentClass && lineNum > currentClass.endLine) {
        currentClass = null;
      }

      // Standalone function or async arrow function
      const fnMatch =
        line.match(/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/) ||
        line.match(/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z0-9_$]+)\s*=>\s*\{?/);
      if (fnMatch) {
        const fnName = fnMatch[1];
        const endLine = line.includes('{') ? this._findClosingBrace(lines, i) : lineNum;
        const fnSnippet = lines.slice(i, endLine).join('\n');
        symbols.push({
          name: fnName,
          kind: 'function',
          startLine: lineNum,
          endLine,
          hash: calculateHash(fnSnippet),
        });
      }
    }
  }

  static _parsePython(lines, symbols, imports, fullText) {
    let currentClass = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      // Imports
      const importMatch = line.match(/^(?:from\s+([a-zA-Z0-9_.]+)\s+import|import\s+([a-zA-Z0-9_.]+))/);
      if (importMatch) {
        imports.push({ source: importMatch[1] || importMatch[2], line: lineNum });
        continue;
      }

      // Class
      const classMatch = line.match(/^class\s+([A-Za-z0-9_]+)(?:\([^)]*\))?:/);
      if (classMatch) {
        const className = classMatch[1];
        const endLine = this._findPythonBlockEnd(lines, i);
        const classSnippet = lines.slice(i, endLine).join('\n');
        currentClass = {
          name: className,
          kind: 'class',
          startLine: lineNum,
          endLine,
          hash: calculateHash(classSnippet),
          methods: [],
        };
        symbols.push(currentClass);
        continue;
      }

      // Function or method (supports def, async def)
      const defMatch = line.match(/^(\s*)(?:async\s+)?def\s+([A-Za-z0-9_]+)\s*\(/);
      if (defMatch) {
        const indent = defMatch[1].length;
        const name = defMatch[2];
        const endLine = this._findPythonBlockEnd(lines, i);
        const snippet = lines.slice(i, endLine).join('\n');

        if (indent > 0 && currentClass && lineNum <= currentClass.endLine) {
          const methodSymbol = {
            name: `${currentClass.name}.${name}`,
            kind: 'method',
            startLine: lineNum,
            endLine,
            hash: calculateHash(snippet),
          };
          symbols.push(methodSymbol);
          currentClass.methods.push(methodSymbol);
        } else {
          symbols.push({
            name,
            kind: 'function',
            startLine: lineNum,
            endLine,
            hash: calculateHash(snippet),
          });
        }
      }
    }
  }

  static _parseGo(lines, symbols, imports, fullText) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      // Struct/Interface type
      const typeMatch = line.match(/^type\s+([A-Za-z0-9_]+)\s+(?:struct|interface)/);
      if (typeMatch) {
        const endLine = this._findClosingBrace(lines, i);
        symbols.push({
          name: typeMatch[1],
          kind: 'struct',
          startLine: lineNum,
          endLine,
          hash: calculateHash(lines.slice(i, endLine).join('\n')),
        });
        continue;
      }

      // Method: func (r *Receiver) MethodName(...)
      const methodMatch = line.match(/^func\s+\(\s*[^)]+\s+\*?([A-Za-z0-9_]+)\s*\)\s*([A-Za-z0-9_]+)\s*\(/);
      if (methodMatch) {
        const receiver = methodMatch[1];
        const methodName = methodMatch[2];
        const endLine = this._findClosingBrace(lines, i);
        symbols.push({
          name: `${receiver}.${methodName}`,
          kind: 'method',
          startLine: lineNum,
          endLine,
          hash: calculateHash(lines.slice(i, endLine).join('\n')),
        });
        continue;
      }

      // Standalone function: func FuncName(...)
      const fnMatch = line.match(/^func\s+([A-Za-z0-9_]+)\s*\(/);
      if (fnMatch) {
        const endLine = this._findClosingBrace(lines, i);
        symbols.push({
          name: fnMatch[1],
          kind: 'function',
          startLine: lineNum,
          endLine,
          hash: calculateHash(lines.slice(i, endLine).join('\n')),
        });
      }
    }
  }

  static _parseRust(lines, symbols, imports, fullText) {
    let currentImpl = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      // struct, enum, trait
      const typeMatch = line.match(/^(?:pub\s+)?(?:struct|enum|trait)\s+([A-Za-z0-9_]+)/);
      if (typeMatch) {
        const endLine = this._findClosingBrace(lines, i);
        symbols.push({
          name: typeMatch[1],
          kind: 'struct',
          startLine: lineNum,
          endLine,
          hash: calculateHash(lines.slice(i, endLine).join('\n')),
        });
        continue;
      }

      // impl MyStruct
      const implMatch = line.match(/^impl(?:\s+<[^>]+>)?\s+(?:[A-Za-z0-9_]+\s+for\s+)?([A-Za-z0-9_]+)/);
      if (implMatch) {
        currentImpl = {
          name: implMatch[1],
          startLine: lineNum,
          endLine: this._findClosingBrace(lines, i),
        };
      }

      // fn inside impl or standalone fn
      const fnMatch = line.match(/^(?:\s*)(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z0-9_]+)\s*\(/);
      if (fnMatch) {
        const fnName = fnMatch[1];
        const endLine = this._findClosingBrace(lines, i);
        const snippet = lines.slice(i, endLine).join('\n');
        if (currentImpl && lineNum <= currentImpl.endLine) {
          symbols.push({
            name: `${currentImpl.name}.${fnName}`,
            kind: 'method',
            startLine: lineNum,
            endLine,
            hash: calculateHash(snippet),
          });
        } else {
          symbols.push({
            name: fnName,
            kind: 'function',
            startLine: lineNum,
            endLine,
            hash: calculateHash(snippet),
          });
        }
      }
    }
  }

  static _parseSwift(lines, symbols, imports, fullText) {
    let currentType = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      // Imports
      const importMatch = line.match(/^import\s+([A-Za-z0-9_]+)/);
      if (importMatch) {
        imports.push({ source: importMatch[1], line: lineNum });
        continue;
      }

      // class / struct / enum / protocol / extension
      const typeMatch = line.match(
        /^(?:@\w+\s+)?(?:public\s+|private\s+|open\s+|internal\s+)?(?:final\s+)?(class|struct|enum|protocol|extension)\s+([A-Za-z0-9_]+)/
      );
      if (typeMatch) {
        const typeName = typeMatch[2];
        const endLine = this._findClosingBrace(lines, i);
        currentType = {
          name: typeName,
          kind: typeMatch[1] === 'class' ? 'class' : 'struct',
          startLine: lineNum,
          endLine,
          hash: calculateHash(lines.slice(i, endLine).join('\n')),
        };
        symbols.push(currentType);
        continue;
      }

      // func
      const funcMatch = line.match(/^(?:\s*)(?:public\s+|private\s+|static\s+)?func\s+([A-Za-z0-9_]+)\s*(?:<[^>]+>)?\s*\(/);
      if (funcMatch) {
        const funcName = funcMatch[1];
        const endLine = this._findClosingBrace(lines, i);
        const snippet = lines.slice(i, endLine).join('\n');
        if (currentType && lineNum <= currentType.endLine) {
          symbols.push({
            name: `${currentType.name}.${funcName}`,
            kind: 'method',
            startLine: lineNum,
            endLine,
            hash: calculateHash(snippet),
          });
        } else {
          symbols.push({
            name: funcName,
            kind: 'function',
            startLine: lineNum,
            endLine,
            hash: calculateHash(snippet),
          });
        }
        continue;
      }

      // Swift View body: var body: some View {
      const bodyMatch = line.match(/^(?:\s*)var\s+(body)\s*:\s*some\s+View\s*\{/);
      if (bodyMatch && currentType) {
        const endLine = this._findClosingBrace(lines, i);
        const snippet = lines.slice(i, endLine).join('\n');
        symbols.push({
          name: `${currentType.name}.body`,
          kind: 'method',
          startLine: lineNum,
          endLine,
          hash: calculateHash(snippet),
        });
      }
    }
  }

  /**
   * String- and Comment-Aware Brace Matcher.
   * Completely immune to braces inside strings (single/double/backtick) and comments (//, /*).
   */
  static _findClosingBrace(lines, startIndex) {
    let depth = 0;
    let foundOpen = false;
    let inString = null;
    let inLineComment = false;
    let inBlockComment = false;

    for (let i = startIndex; i < lines.length; i++) {
      const line = lines[i];
      inLineComment = false; // Reset line comment on newline

      for (let j = 0; j < line.length; j++) {
        const ch = line[j];
        const next = j + 1 < line.length ? line[j + 1] : '';

        // Line comment
        if (inLineComment) break;

        // Block comment
        if (inBlockComment) {
          if (ch === '*' && next === '/') {
            inBlockComment = false;
            j++;
          }
          continue;
        }

        // String literal
        if (inString !== null) {
          if (ch === '\\') {
            j++; // Skip escaped char
            continue;
          }
          if (ch === inString) {
            inString = null;
          }
          continue;
        }

        // Check for comment start
        if (ch === '/' && next === '/') {
          inLineComment = true;
          j++;
          continue;
        }
        if (ch === '/' && next === '*') {
          inBlockComment = true;
          j++;
          continue;
        }

        // Check for string start
        if (ch === '"' || ch === "'" || ch === '`') {
          inString = ch;
          continue;
        }

        // Check for brace
        if (ch === '{') {
          depth++;
          foundOpen = true;
        } else if (ch === '}') {
          depth--;
          if (foundOpen && depth === 0) {
            return i + 1; // 1-indexed line
          }
        }
      }
    }

    return lines.length;
  }

  static _findPythonBlockEnd(lines, startIndex) {
    const baseIndent = lines[startIndex].match(/^(\s*)/)[1].length;
    for (let i = startIndex + 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim() || line.trim().startsWith('#')) continue;
      const indent = line.match(/^(\s*)/)[1].length;
      if (indent <= baseIndent) {
        return i; // line before i (1-indexed)
      }
    }
    return lines.length;
  }
}

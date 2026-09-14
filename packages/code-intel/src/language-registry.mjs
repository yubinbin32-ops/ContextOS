import crypto from 'node:crypto';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as babelParser from '@babel/parser';

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
    try {
      this._parseJsTsWithBabel(lines, symbols, imports, fullText);
    } catch (err) {
      this._parseJsTsFallback(lines, symbols, imports, fullText);
    }
  }

  static _parseJsTsWithBabel(lines, symbols, imports, fullText) {
    const ast = babelParser.parse(fullText, {
      sourceType: 'unambiguous',
      errorRecovery: true,
      plugins: [
        'typescript',
        'jsx',
        'classProperties',
        'classPrivateProperties',
        'classPrivateMethods',
        'decorators-legacy',
        'asyncGenerators',
        'dynamicImport',
        'exportDefaultFrom',
        'exportNamespaceFrom',
        'topLevelAwait',
      ],
    });

    const getSliceHash = (startLine, endLine) => {
      const slice = lines.slice(Math.max(0, startLine - 1), endLine).join('\n');
      return calculateHash(slice);
    };

    const extractFunctionSignature = (node, name) => {
      const params = (node.params || [])
        .map((p) => {
          if (p.type === 'Identifier') return p.name;
          if (p.type === 'AssignmentPattern' && p.left?.name) return `${p.left.name}=...`;
          if (p.type === 'RestElement' && p.argument?.name) return `...${p.argument.name}`;
          if (p.type === 'ObjectPattern') return '{...}';
          if (p.type === 'ArrayPattern') return '[...]';
          return 'arg';
        })
        .join(', ');
      return `${name}(${params})`;
    };

    for (const stmt of ast.program.body) {
      if (stmt.type === 'ImportDeclaration') {
        imports.push({
          source: stmt.source.value,
          line: stmt.loc.start.line,
        });
        continue;
      }

      let target = stmt;
      if (stmt.type === 'ExportNamedDeclaration' || stmt.type === 'ExportDefaultDeclaration') {
        target = stmt.declaration || stmt;
      }

      if (!target || !target.loc) continue;

      if (target.type === 'ClassDeclaration' || target.type === 'ClassExpression') {
        const className = target.id?.name || 'AnonymousClass';
        const startLine = target.loc.start.line;
        const endLine = target.loc.end.line;
        const classSymbol = {
          name: className,
          shortName: className,
          kind: 'class',
          startLine,
          endLine,
          hash: getSliceHash(startLine, endLine),
          methods: [],
        };
        symbols.push(classSymbol);

        for (const member of target.body.body || []) {
          if (!member.loc) continue;
          const mStart = member.loc.start.line;
          const mEnd = member.loc.end.line;

          if (member.type === 'ClassMethod' || member.type === 'ClassPrivateMethod') {
            const methodName = member.key?.name || member.key?.id?.name || (member.kind === 'constructor' ? 'constructor' : 'method');
            const qualifiedName = `${className}.${methodName}`;
            const sig = extractFunctionSignature(member, methodName);
            const methodSymbol = {
              name: qualifiedName,
              shortName: methodName,
              containerName: className,
              kind: member.kind === 'constructor' ? 'constructor' : 'method',
              signature: sig,
              startLine: mStart,
              endLine: mEnd,
              hash: getSliceHash(mStart, mEnd),
            };
            symbols.push(methodSymbol);
            classSymbol.methods.push(methodSymbol);
          } else if (member.type === 'ClassProperty' && member.value && (member.value.type === 'ArrowFunctionExpression' || member.value.type === 'FunctionExpression')) {
            const propName = member.key?.name || 'prop';
            const qualifiedName = `${className}.${propName}`;
            const sig = extractFunctionSignature(member.value, propName);
            const methodSymbol = {
              name: qualifiedName,
              shortName: propName,
              containerName: className,
              kind: 'method',
              signature: sig,
              startLine: mStart,
              endLine: mEnd,
              hash: getSliceHash(mStart, mEnd),
            };
            symbols.push(methodSymbol);
            classSymbol.methods.push(methodSymbol);
          }
        }
      } else if (target.type === 'FunctionDeclaration') {
        const fnName = target.id?.name || 'anonymous';
        const startLine = target.loc.start.line;
        const endLine = target.loc.end.line;
        symbols.push({
          name: fnName,
          shortName: fnName,
          kind: 'function',
          signature: extractFunctionSignature(target, fnName),
          startLine,
          endLine,
          hash: getSliceHash(startLine, endLine),
        });
      } else if (target.type === 'VariableDeclaration') {
        for (const decl of target.declarations || []) {
          const varName = decl.id?.name;
          if (!varName) continue;
          const startLine = target.loc.start.line;
          const endLine = target.loc.end.line;
          if (decl.init && (decl.init.type === 'ArrowFunctionExpression' || decl.init.type === 'FunctionExpression')) {
            symbols.push({
              name: varName,
              shortName: varName,
              kind: 'function',
              signature: extractFunctionSignature(decl.init, varName),
              startLine,
              endLine,
              hash: getSliceHash(startLine, endLine),
            });
          }
        }
      } else if (target.type === 'TSInterfaceDeclaration') {
        const ifaceName = target.id?.name;
        const startLine = target.loc.start.line;
        const endLine = target.loc.end.line;
        symbols.push({
          name: ifaceName,
          shortName: ifaceName,
          kind: 'interface',
          startLine,
          endLine,
          hash: getSliceHash(startLine, endLine),
        });
      } else if (target.type === 'TSTypeAliasDeclaration') {
        const typeName = target.id?.name;
        const startLine = target.loc.start.line;
        const endLine = target.loc.end.line;
        symbols.push({
          name: typeName,
          shortName: typeName,
          kind: 'type',
          startLine,
          endLine,
          hash: getSliceHash(startLine, endLine),
        });
      } else if (target.type === 'TSEnumDeclaration') {
        const enumName = target.id?.name;
        const startLine = target.loc.start.line;
        const endLine = target.loc.end.line;
        symbols.push({
          name: enumName,
          shortName: enumName,
          kind: 'enum',
          startLine,
          endLine,
          hash: getSliceHash(startLine, endLine),
        });
      }
    }
  }

  static _parseJsTsFallback(lines, symbols, imports, fullText) {
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
          shortName: typeName,
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
          shortName: className,
          kind: 'class',
          startLine: lineNum,
          endLine,
          hash: calculateHash(classSnippet),
          methods: [],
        };
        symbols.push(currentClass);
        continue;
      }

      // Method inside class
      if (currentClass && lineNum <= currentClass.endLine) {
        const methodMatch = line.match(/^\s*(?:async\s+)?(?:static\s+)?(?:get\s+|set\s+)?([A-Za-z0-9_$]+)\s*\([^)]*\)\s*\{/);
        if (methodMatch && !['if', 'for', 'while', 'switch', 'catch'].includes(methodMatch[1])) {
          const methodName = methodMatch[1];
          const endLine = this._findClosingBrace(lines, i);
          const methodSnippet = lines.slice(i, endLine).join('\n');
          const methodSymbol = {
            name: `${currentClass.name}.${methodName}`,
            shortName: methodName,
            containerName: currentClass.name,
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
          shortName: fnName,
          kind: 'function',
          startLine: lineNum,
          endLine,
          hash: calculateHash(fnSnippet),
        });
      }
    }
  }

  static _parsePython(lines, symbols, imports, fullText) {
    try {
      const script = `
import ast, json, sys
tree = ast.parse(sys.stdin.read())
imports, symbols = [], []
for node in ast.iter_child_nodes(tree):
    if isinstance(node, (ast.Import, ast.ImportFrom)):
        if isinstance(node, ast.Import):
            for n in node.names: imports.append({"source": n.name, "line": node.lineno})
        else:
            imports.append({"source": node.module or "", "line": node.lineno})
    elif isinstance(node, ast.ClassDef):
        methods = []
        for m in node.body:
            if isinstance(m, (ast.FunctionDef, ast.AsyncFunctionDef)):
                methods.append({
                    "name": f"{node.name}.{m.name}",
                    "shortName": m.name,
                    "kind": "method",
                    "containerName": node.name,
                    "startLine": m.lineno,
                    "endLine": getattr(m, "end_lineno", m.lineno)
                })
        symbols.append({
            "name": node.name,
            "shortName": node.name,
            "kind": "class",
            "startLine": node.lineno,
            "endLine": getattr(node, "end_lineno", node.lineno),
            "methods": methods
        })
        symbols.extend(methods)
    elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
        symbols.append({
            "name": node.name,
            "shortName": node.name,
            "kind": "function",
            "startLine": node.lineno,
            "endLine": getattr(node, "end_lineno", node.lineno)
        })
print(json.dumps({"imports": imports, "symbols": symbols}))
`;
      const out = execFileSync('python3', ['-c', script], { input: fullText, encoding: 'utf8', timeout: 3000 });
      const data = JSON.parse(out);
      for (const imp of data.imports) imports.push(imp);
      for (const s of data.symbols) {
        const slice = lines.slice(s.startLine - 1, s.endLine).join('\n');
        s.hash = calculateHash(slice);
        symbols.push(s);
      }
      return;
    } catch (_) {
      this._parsePythonFallback(lines, symbols, imports);
    }
  }

  static _parsePythonFallback(lines, symbols, imports) {
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

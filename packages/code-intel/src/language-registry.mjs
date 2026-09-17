import crypto from 'node:crypto';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as babelParser from '@babel/parser';
import { TreeSitterParser } from './tree-sitter-parser.mjs';

export function calculateHash(code) {
  return crypto.createHash('sha256').update(code, 'utf8').digest('hex').slice(0, 16);
}

export class LanguageRegistry {
  static getLanguage(filePath, content = '') {
    const basename = path.basename(filePath);
    // 1. Exact filename matching (matching Zed / Cursor filename mapping)
    switch (basename) {
      case 'Gemfile':
      case 'Podfile':
      case 'Rakefile':
        return { name: 'ruby', capability: 'L3' };
      case 'CMakeLists.txt':
        return { name: 'cpp', capability: 'L3' };
    }

    // 2. Extension matching (standard primary mechanism in Zed, Cursor, VS Code)
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
        return { name: 'go', capability: 'L3' };
      case '.rs':
        return { name: 'rust', capability: 'L3' };
      case '.swift':
        return { name: 'swift', capability: 'L3' };
      case '.java':
        return { name: 'java', capability: 'L3' };
      case '.kt':
      case '.kts':
        return { name: 'kotlin', capability: 'L3' };
      case '.c':
      case '.h':
      case '.cpp':
      case '.hpp':
      case '.cc':
      case '.cxx':
        return { name: 'cpp', capability: 'L3' };
      case '.cs':
        return { name: 'csharp', capability: 'L3' };
      case '.php':
        return { name: 'php', capability: 'L3' };
      case '.rb':
        return { name: 'ruby', capability: 'L3' };
    }

    // 3. Fallback: Shebang and content sniffing (for extensionless scripts)
    if (content) {
      const firstLine = content.slice(0, 150).split(/\r?\n/)[0].trim();
      if (firstLine.startsWith('#!')) {
        if (/python[0-9.]*(\s|$)/.test(firstLine)) return { name: 'python', capability: 'L3' };
        if (/(node|bun|deno)(\s|$)/.test(firstLine)) return { name: 'javascript', capability: 'L3' };
        if (/ruby(\s|$)/.test(firstLine)) return { name: 'ruby', capability: 'L3' };
        if (/php(\s|$)/.test(firstLine)) return { name: 'php', capability: 'L3' };
      } else if (firstLine.startsWith('<?php')) {
        return { name: 'php', capability: 'L3' };
      }
    }

    return { name: 'text', capability: 'L1' };
  }

  /**
   * Parse symbols, imports, classes and functions from content.
   */
  static parseStructure(filePath, content, options = {}) {
    const { name: lang, capability } = this.getLanguage(filePath, content);
    const lines = content.split(/\r?\n/);
    let symbols = [];
    let imports = [];

    // 1. Primary: True multi-language AST parsing via Web-Tree-Sitter
    let parsedWithTreeSitter = false;
    if (TreeSitterParser.isLanguageSupported(lang)) {
      const tsResult = TreeSitterParser.parse(lang, content, lines);
      if (tsResult && Array.isArray(tsResult.symbols)) {
        symbols = tsResult.symbols;
        imports = tsResult.imports || [];
        parsedWithTreeSitter = true;
      }
    }

    // 2. Secondary: Fallback to specialized syntactic / regex parsers if Tree-sitter wasm is not present or failed
    if (!parsedWithTreeSitter) {
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
      } else if (lang === 'java') {
        this._parseJava(lines, symbols, imports, content);
      } else if (lang === 'kotlin') {
        this._parseKotlin(lines, symbols, imports, content);
      } else if (lang === 'cpp') {
        this._parseCpp(lines, symbols, imports, content);
      } else if (lang === 'csharp') {
        this._parseCSharp(lines, symbols, imports, content);
      } else if (lang === 'php') {
        this._parsePhp(lines, symbols, imports, content);
      } else if (lang === 'ruby') {
        this._parseRuby(lines, symbols, imports, content);
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
    }

    return {
      language: lang,
      capability,
      imports: options.imports !== false ? imports : [],
      symbols: symbols.filter((s) => {
        if (options.classes === false && (s.kind === 'class' || s.kind === 'interface' || s.kind === 'struct' || s.kind === 'trait')) return false;
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
      const typeMatch = line.match(/^\s*(?:pub(?:\([^)]+\))?\s+)?(struct|enum|trait)\s+([A-Za-z0-9_]+)/);
      if (typeMatch) {
        const typeKind = typeMatch[1];
        const endLine = this._findDeclarationOrBraceEnd(lines, i);
        symbols.push({
          name: typeMatch[2],
          kind: typeKind === 'trait' ? 'trait' : typeKind === 'enum' ? 'enum' : 'struct',
          startLine: lineNum,
          endLine,
          hash: calculateHash(lines.slice(i, endLine).join('\n')),
        });
        continue;
      }

      // impl MyStruct
      if (/^\s*impl\b/.test(line)) {
        let implTarget = null;
        const forMatch = line.match(/\bfor\s+([A-Za-z0-9_]+)/);
        if (forMatch) {
          implTarget = forMatch[1];
        } else {
          const directMatch = line.match(/^\s*impl(?:\s*<.*?>)?\s+([A-Za-z0-9_]+)/);
          if (directMatch) {
            implTarget = directMatch[1];
          }
        }
        if (implTarget) {
          currentImpl = {
            name: implTarget,
            startLine: lineNum,
            endLine: this._findClosingBrace(lines, i),
          };
        }
      }

      // fn inside impl or standalone fn
      const fnMatch = line.match(/^\s*(?:(?:pub(?:\([^)]*\))?|const|async|unsafe|extern(?:\s+"[^"]*")?)\s+)*fn\s+([A-Za-z0-9_]+)\s*(?:<|\()/);
      if (fnMatch) {
        const fnName = fnMatch[1];
        const endLine = this._findDeclarationOrBraceEnd(lines, i);
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

  static _parseJava(lines, symbols, imports, fullText) {
    let currentClass = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      const importMatch = line.match(/^import\s+(?:static\s+)?([A-Za-z0-9_.*]+);/);
      if (importMatch) {
        imports.push({ source: importMatch[1], line: lineNum });
        continue;
      }

      const typeMatch = line.match(
        /^(?:@\w+(?:\([^)]*\))?\s+)*(?:public\s+|protected\s+|private\s+)?(?:static\s+)?(?:final\s+|abstract\s+)?(class|interface|enum|record)\s+([A-Za-z0-9_]+)/
      );
      if (typeMatch) {
        const typeName = typeMatch[2];
        const endLine = this._findClosingBrace(lines, i);
        currentClass = {
          name: typeName,
          kind: typeMatch[1] === 'interface' ? 'interface' : 'class',
          startLine: lineNum,
          endLine,
          hash: calculateHash(lines.slice(i, endLine).join('\n')),
        };
        symbols.push(currentClass);
        continue;
      }

      const methodMatch = line.match(
        /^(?:\s*)(?:@\w+(?:\([^)]*\))?\s+)*(?:public\s+|protected\s+|private\s+)?(?:static\s+)?(?:final\s+|synchronized\s+)?(?:<[^>]+>\s+)?(?:[A-Za-z0-9_<>[\]?]+\s+)+([A-Za-z0-9_]+)\s*\([^)]*\)\s*(?:throws\s+[^{]+)?\{/
      );
      if (methodMatch) {
        const methodName = methodMatch[1];
        if (['if', 'for', 'while', 'switch', 'catch', 'synchronized'].includes(methodName)) continue;
        const endLine = this._findClosingBrace(lines, i);
        const snippet = lines.slice(i, endLine).join('\n');
        if (currentClass && lineNum <= currentClass.endLine) {
          symbols.push({
            name: `${currentClass.name}.${methodName}`,
            kind: 'method',
            startLine: lineNum,
            endLine,
            hash: calculateHash(snippet),
          });
        } else {
          symbols.push({
            name: methodName,
            kind: 'function',
            startLine: lineNum,
            endLine,
            hash: calculateHash(snippet),
          });
        }
      }
    }
  }

  static _parseKotlin(lines, symbols, imports, fullText) {
    let currentType = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      const importMatch = line.match(/^\s*import\s+([A-Za-z0-9_.*]+)/);
      if (importMatch) {
        imports.push({ source: importMatch[1], line: lineNum });
        continue;
      }

      const typeMatch = line.match(
        /^\s*(?:open\s+|data\s+|sealed\s+|abstract\s+|inner\s+)*(class|interface|object)\s+([A-Za-z0-9_]+)/
      );
      if (typeMatch) {
        const typeName = typeMatch[2];
        const endLine = this._findClosingBrace(lines, i);
        currentType = {
          name: typeName,
          kind: typeMatch[1] === 'interface' ? 'interface' : 'class',
          startLine: lineNum,
          endLine,
          hash: calculateHash(lines.slice(i, endLine).join('\n')),
        };
        symbols.push(currentType);
        continue;
      }

      const funMatch = line.match(
        /^(?:\s*)(?:override\s+|suspend\s+|private\s+|public\s+|protected\s+|internal\s+)?fun\s+(?:<[^>]+>\s+)?(?:([A-Za-z0-9_]+)\.)?([A-Za-z0-9_]+)\s*\(/
      );
      if (funMatch) {
        const receiver = funMatch[1];
        const funName = funMatch[2];
        const endLine = this._findClosingBrace(lines, i);
        const snippet = lines.slice(i, endLine).join('\n');
        const inType = currentType && lineNum <= currentType.endLine;
        const fullName = receiver ? `${receiver}.${funName}` : inType ? `${currentType.name}.${funName}` : funName;
        symbols.push({
          name: fullName,
          kind: inType || receiver ? 'method' : 'function',
          startLine: lineNum,
          endLine,
          hash: calculateHash(snippet),
        });
      }
    }
  }

  static _parseCpp(lines, symbols, imports, fullText) {
    let currentClass = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      const includeMatch = line.match(/^\s*#include\s+([<"][^>"]+[>"])/);
      if (includeMatch) {
        imports.push({ source: includeMatch[1], line: lineNum });
        continue;
      }

      const classMatch = line.match(/^\s*(?:template\s*<[^>]*>\s*)?(class|struct)\s+([A-Za-z0-9_]+)(?:\s*:[^{]*)?\s*\{/);
      if (classMatch) {
        const className = classMatch[2];
        const endLine = this._findClosingBrace(lines, i);
        currentClass = {
          name: className,
          kind: classMatch[1] === 'class' ? 'class' : 'struct',
          startLine: lineNum,
          endLine,
          hash: calculateHash(lines.slice(i, endLine).join('\n')),
        };
        symbols.push(currentClass);
        continue;
      }

      const outOfLineMatch = line.match(/^\s*(?:[A-Za-z0-9_:*&<>]+\s+)+([A-Za-z0-9_]+)::([A-Za-z0-9_~]+)\s*\([^)]*\)\s*(?:const)?\s*\{/);
      if (outOfLineMatch) {
        const scope = outOfLineMatch[1];
        const fnName = outOfLineMatch[2];
        const endLine = this._findClosingBrace(lines, i);
        symbols.push({
          name: `${scope}::${fnName}`,
          kind: 'method',
          startLine: lineNum,
          endLine,
          hash: calculateHash(lines.slice(i, endLine).join('\n')),
        });
        continue;
      }

      const fnMatch = line.match(/^(?:\s*)(?:virtual\s+|static\s+|inline\s+)?(?:[A-Za-z0-9_:*&<>]+\s+)+([A-Za-z0-9_]+)\s*\([^)]*\)\s*(?:const)?\s*\{/);
      if (fnMatch) {
        const fnName = fnMatch[1];
        if (['if', 'for', 'while', 'switch', 'catch'].includes(fnName)) continue;
        const endLine = this._findClosingBrace(lines, i);
        const snippet = lines.slice(i, endLine).join('\n');
        if (currentClass && lineNum <= currentClass.endLine) {
          symbols.push({
            name: `${currentClass.name}::${fnName}`,
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

  static _parseCSharp(lines, symbols, imports, fullText) {
    let currentClass = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      const usingMatch = line.match(/^\s*using\s+([A-Za-z0-9_.]+);/);
      if (usingMatch) {
        imports.push({ source: usingMatch[1], line: lineNum });
        continue;
      }

      const typeMatch = line.match(
        /^\s*(?:public\s+|internal\s+|private\s+|protected\s+)?(?:static\s+|abstract\s+|sealed\s+|partial\s+)*(class|interface|struct|record)\s+([A-Za-z0-9_]+)/
      );
      if (typeMatch) {
        const typeName = typeMatch[2];
        const endLine = this._findClosingBrace(lines, i);
        currentClass = {
          name: typeName,
          kind: typeMatch[1] === 'interface' ? 'interface' : 'class',
          startLine: lineNum,
          endLine,
          hash: calculateHash(lines.slice(i, endLine).join('\n')),
        };
        symbols.push(currentClass);
        continue;
      }

      const methodMatch = line.match(
        /^(?:\s*)(?:public\s+|private\s+|protected\s+|internal\s+)?(?:static\s+|async\s+|virtual\s+|override\s+)*(?:[A-Za-z0-9_<>[\]?]+\s+)+([A-Za-z0-9_]+)\s*\([^)]*\)\s*\{/
      );
      if (methodMatch) {
        const methodName = methodMatch[1];
        if (['if', 'for', 'foreach', 'while', 'switch', 'catch', 'using', 'lock'].includes(methodName)) continue;
        const endLine = this._findClosingBrace(lines, i);
        const snippet = lines.slice(i, endLine).join('\n');
        if (currentClass && lineNum <= currentClass.endLine) {
          symbols.push({
            name: `${currentClass.name}.${methodName}`,
            kind: 'method',
            startLine: lineNum,
            endLine,
            hash: calculateHash(snippet),
          });
        } else {
          symbols.push({
            name: methodName,
            kind: 'function',
            startLine: lineNum,
            endLine,
            hash: calculateHash(snippet),
          });
        }
      }
    }
  }

  static _parsePhp(lines, symbols, imports, fullText) {
    let currentClass = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      const useMatch = line.match(/^\s*use\s+([A-Za-z0-9_\\]+);/);
      if (useMatch) {
        imports.push({ source: useMatch[1], line: lineNum });
        continue;
      }

      const typeMatch = line.match(/^\s*(?:abstract\s+|final\s+)?(class|interface|trait)\s+([A-Za-z0-9_]+)/);
      if (typeMatch) {
        const typeName = typeMatch[2];
        const endLine = this._findClosingBrace(lines, i);
        currentClass = {
          name: typeName,
          kind: typeMatch[1] === 'interface' ? 'interface' : 'class',
          startLine: lineNum,
          endLine,
          hash: calculateHash(lines.slice(i, endLine).join('\n')),
        };
        symbols.push(currentClass);
        continue;
      }

      const fnMatch = line.match(/^(?:\s*)(?:public\s+|protected\s+|private\s+)?(?:static\s+)?function\s+([A-Za-z0-9_]+)\s*\(/);
      if (fnMatch) {
        const fnName = fnMatch[1];
        const endLine = this._findClosingBrace(lines, i);
        const snippet = lines.slice(i, endLine).join('\n');
        if (currentClass && lineNum <= currentClass.endLine) {
          symbols.push({
            name: `${currentClass.name}::${fnName}`,
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

  static _parseRuby(lines, symbols, imports, fullText) {
    let currentClass = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      const requireMatch = line.match(/^\s*(?:require|require_relative)\s+['"]([^'"]+)['"]/);
      if (requireMatch) {
        imports.push({ source: requireMatch[1], line: lineNum });
        continue;
      }

      const typeMatch = line.match(/^\s*(?:class|module)\s+([A-Za-z0-9_:]+)/);
      if (typeMatch) {
        const typeName = typeMatch[1];
        const endLine = this._findRubyBlockEnd(lines, i);
        currentClass = {
          name: typeName,
          kind: 'class',
          startLine: lineNum,
          endLine,
          hash: calculateHash(lines.slice(i, endLine).join('\n')),
        };
        symbols.push(currentClass);
        continue;
      }

      const defMatch = line.match(/^(\s*)def\s+([A-Za-z0-9_!?.]+)/);
      if (defMatch) {
        const fnName = defMatch[2];
        const endLine = this._findRubyBlockEnd(lines, i);
        const snippet = lines.slice(i, endLine).join('\n');
        if (currentClass && lineNum <= currentClass.endLine) {
          symbols.push({
            name: `${currentClass.name}#${fnName}`,
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

  static _findRubyBlockEnd(lines, startIndex) {
    let depth = 0;
    const startKeywords = /^\s*(?:class|module|def|if|unless|while|until|for|case)\b/;
    const endKeyword = /^\s*end\b/;

    for (let i = startIndex; i < lines.length; i++) {
      const line = lines[i];
      if (startKeywords.test(line)) depth++;
      if (endKeyword.test(line)) {
        depth--;
        if (depth === 0) return i + 1;
      }
    }
    return lines.length;
  }

  /**
   * String- and Comment-Aware Brace Matcher.
   * Completely immune to braces inside strings (single/double/backtick) and comments (//, /*).
   */
  static _findClosingBrace(lines, startIndex) {
    let depth = 0;
    let foundOpen = false;
    let inString = null;
    let inRawString = false;
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

        // C++ raw string literal R"(...)"
        if (inRawString) {
          if (ch === ')' && next === '"') {
            inRawString = false;
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
          if (inString.length === 3) {
            if (ch === inString[0] && next === inString[0] && line[j + 2] === inString[0]) {
              inString = null;
              j += 2;
            }
          } else if (ch === inString) {
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

        // Check for C++ raw string start R"(
        if (ch === 'R' && next === '"' && line[j + 2] === '(') {
          inRawString = true;
          j += 2;
          continue;
        }

        // Check for triple-quote string (Swift / Python: """ or ''')
        if ((ch === '"' || ch === "'") && next === ch && line[j + 2] === ch) {
          inString = ch.repeat(3);
          j += 2;
          continue;
        }

        // Check for Rust lifetime identifier (e.g. 'a, 'static, '_)
        if (ch === "'") {
          const rest = line.slice(j);
          const lifetimeMatch = rest.match(/^'([a-zA-Z_][a-zA-Z0-9_]*)/);
          if (lifetimeMatch) {
            if (rest[lifetimeMatch[0].length] !== "'") {
              j += lifetimeMatch[0].length - 1;
              continue;
            }
          }
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
          if (!foundOpen) {
            return i + 1; // 1-indexed line
          }
          depth--;
          if (foundOpen && depth === 0) {
            return i + 1; // 1-indexed line
          }
        }
      }
    }

    return lines.length;
  }

  /**
   * Declaration- or Brace-Aware End Finder.
   * If a declaration terminates with a semicolon ';' before any opening brace '{' is found
   * (e.g. Rust trait methods 'fn work(&self);', tuple structs 'struct Point(f64, f64);', or externs),
   * it returns the line number of the semicolon.
   * If an opening brace '{' is found first, it tracks balanced braces to the closing '}'.
   */
  static _findDeclarationOrBraceEnd(lines, startIndex) {
    let depth = 0;
    let foundOpen = false;
    let inString = null;
    let inRawString = false;
    let inLineComment = false;
    let inBlockComment = false;

    for (let i = startIndex; i < lines.length; i++) {
      const line = lines[i];
      inLineComment = false;

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

        // C++ raw string literal R"(...)"
        if (inRawString) {
          if (ch === ')' && next === '"') {
            inRawString = false;
            j++;
          }
          continue;
        }

        // String literal
        if (inString !== null) {
          if (ch === '\\') {
            j++;
            continue;
          }
          if (inString.length === 3) {
            if (ch === inString[0] && next === inString[0] && line[j + 2] === inString[0]) {
              inString = null;
              j += 2;
            }
          } else if (ch === inString) {
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

        // Check for C++ raw string start R"(
        if (ch === 'R' && next === '"' && line[j + 2] === '(') {
          inRawString = true;
          j += 2;
          continue;
        }

        // Check for triple-quote string (Swift / Python: """ or ''')
        if ((ch === '"' || ch === "'") && next === ch && line[j + 2] === ch) {
          inString = ch.repeat(3);
          j += 2;
          continue;
        }

        // Check for Rust lifetime identifier (e.g. 'a, 'static, '_)
        if (ch === "'") {
          const rest = line.slice(j);
          const lifetimeMatch = rest.match(/^'([a-zA-Z_][a-zA-Z0-9_]*)/);
          if (lifetimeMatch) {
            if (rest[lifetimeMatch[0].length] !== "'") {
              j += lifetimeMatch[0].length - 1;
              continue;
            }
          }
        }

        // Check for string start
        if (ch === '"' || ch === "'" || ch === '`') {
          inString = ch;
          continue;
        }

        // Semicolon before any opening brace: declaration without body terminates here
        if (!foundOpen && ch === ';') {
          return i + 1;
        }

        // Enclosing block closed before opening brace
        if (!foundOpen && ch === '}') {
          return i + 1;
        }

        // Check for brace
        if (ch === '{') {
          depth++;
          foundOpen = true;
        } else if (ch === '}') {
          depth--;
          if (foundOpen && depth === 0) {
            return i + 1;
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

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { Parser, Language } from 'web-tree-sitter';

function calculateHash(code) {
  return crypto.createHash('sha256').update(code, 'utf8').digest('hex').slice(0, 16);
}

function getLines(node) {
  const startLine = node.startPosition.row + 1;
  const endLine = Math.max(
    startLine,
    node.endPosition.column > 0 ? node.endPosition.row + 1 : node.endPosition.row
  );
  return { startLine, endLine };
}

function getSliceHash(lines, startLine, endLine) {
  const slice = lines.slice(Math.max(0, startLine - 1), endLine).join('\n');
  return calculateHash(slice);
}

function findIdentifier(node) {
  if (!node) return null;
  if (node.type === 'identifier' || node.type === 'field_identifier' || node.type === 'type_identifier') {
    return node.text;
  }
  for (const child of node.namedChildren) {
    const found = findIdentifier(child);
    if (found) return found;
  }
  return null;
}

function findTypeIdentifier(node) {
  if (!node) return null;
  if (node.type === 'type_identifier') return node.text;
  for (const child of node.namedChildren) {
    const found = findTypeIdentifier(child);
    if (found) return found;
  }
  return null;
}

const loadedLanguages = new Map();
let initPromise = null;
let sharedParser = null;

async function initTreeSitter() {
  if (!initPromise) {
    initPromise = (async () => {
      try {
        const currentDir = path.dirname(fileURLToPath(import.meta.url));
        const bundledCandidates = [
          process.env.CONTEXTOS_TREE_SITTER_WASM,
          path.join(currentDir, 'web-tree-sitter.wasm'),
          path.join(currentDir, '..', 'web-tree-sitter.wasm'),
        ].filter(Boolean);
        let wasmPath = bundledCandidates.find((candidate) => fs.existsSync(candidate)) || null;
        if (!wasmPath) {
          try {
            const require = createRequire(import.meta.url);
            wasmPath = require.resolve('web-tree-sitter/web-tree-sitter.wasm');
          } catch (_) {}
        }
        await Parser.init({
          locateFile(scriptName) {
            if (scriptName.endsWith('.wasm') && wasmPath) return wasmPath;
            return scriptName;
          },
        });
        sharedParser = new Parser();
      } catch (_) {
        sharedParser = null;
      }
    })();
  }
  return initPromise;
}

// Eagerly initialize Tree-Sitter safely
try {
  await initTreeSitter();
} catch (_) {}

const GRAMMAR_MAPPING = {
  javascript: 'javascript',
  typescript: 'typescript',
  tsx: 'tsx',
  python: 'python',
  go: 'go',
  rust: 'rust',
  swift: 'swift',
  java: 'java',
  kotlin: 'kotlin',
  cpp: 'cpp',
  c: 'c',
  csharp: 'csharp',
  php: 'php',
  ruby: 'ruby',
};

function resolveLanguage(langName) {
  const normalized = GRAMMAR_MAPPING[langName] || langName;
  if (loadedLanguages.has(normalized)) {
    return loadedLanguages.get(normalized);
  }

  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const candidatePaths = [
    path.join(currentDir, '..', 'grammars', `tree-sitter-${normalized}.wasm`),
    path.join(currentDir, '..', '..', '..', 'packages', 'code-intel', 'grammars', `tree-sitter-${normalized}.wasm`),
    path.join(process.cwd(), 'packages', 'code-intel', 'grammars', `tree-sitter-${normalized}.wasm`),
    path.join(currentDir, '..', '..', '..', 'node_modules', 'tree-sitter-wasm', 'out', normalized, `tree-sitter-${normalized}.wasm`),
    path.join(currentDir, '..', '..', '..', 'node_modules', 'tree-sitter-wasm', 'out', normalized === 'csharp' ? 'c_sharp' : normalized, `tree-sitter-${normalized === 'csharp' ? 'c_sharp' : normalized}.wasm`),
    path.join(process.cwd(), 'node_modules', 'tree-sitter-wasm', 'out', normalized, `tree-sitter-${normalized}.wasm`),
  ];

  for (const p of candidatePaths) {
    if (fs.existsSync(p)) {
      try {
        const buf = fs.readFileSync(p);
        const lang = Language.loadSync(new WebAssembly.Module(buf));
        loadedLanguages.set(normalized, lang);
        return lang;
      } catch (_) {}
    }
  }

  return null;
}

export function normalizeCallee(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let s = raw.trim();

  // If it contains newlines or braces, it's an anonymous function/closure literal, not a symbol
  if (/[\r\n{}]/.test(s)) return null;

  // Strip generic type parameters: parse<T>, parse::<T>, foo<A, B> -> parse, foo
  while (/(::)?<[^<>]+>/.test(s)) {
    s = s.replace(/(::)?<[^<>]+>/g, '');
  }

  // Normalize instance receivers: this., self., $this., $this->, this->
  s = s.replace(/^(\$this->|\$this\.|\$this|this\.|self\.|this->)/, '');

  // Normalize arrow notation to dot (e.g. PHP/C++: db->save -> db.save)
  s = s.replace(/->/g, '.');

  // Strip any leftover call parentheses if present from chaining: foo().bar -> bar
  if (s.includes('(')) {
    const parts = s.split('.');
    s = parts[parts.length - 1].replace(/\(.*$/, '');
  }

  // Strip whitespace
  s = s.replace(/\s+/g, '');

  // Reject anonymous keywords, empty strings, bare receivers, or strings not starting with valid identifier chars
  if (!s || s === 'function' || s === 'func' || s === 'lambda' || s === 'self' || s === 'this' || s === '$this' || /^[^a-zA-Z0-9_$:]/.test(s)) {
    return null;
  }

  return s || null;
}

export class TreeSitterParser {
  static normalizeCallee(raw) {
    return normalizeCallee(raw);
  }

  static extractCalls(bodyNode) {
    if (!bodyNode) return [];
    const calls = [];
    const seen = new Set();

    const NESTED_SCOPES = new Set([
      'arrow_function',
      'function_expression',
      'function_declaration',
      'generator_function_declaration',
      'function_definition',
      'function_item',
      'method_declaration',
      'method_definition',
      'method',
      'class_declaration',
      'class_definition',
      'class_specifier',
      'struct_specifier',
      'lambda',
      'lambda_expression',
      'lambda_literal',
      'func_literal',
      'closure_expression',
      'do_block',
      'anonymous_function',
      'anonymous_function_expression',
      'anonymous_method_expression',
      'anonymous_class_body',
      'local_function_statement',
    ]);

    const CALL_TYPES = new Set([
      'call_expression',
      'call',
      'method_invocation',
      'invocation_expression',
      'function_call_expression',
      'member_call_expression',
      'scoped_call_expression',
      'method_call',
    ]);

    function walk(node, isRoot = false) {
      if (!node) return;

      if (!isRoot && NESTED_SCOPES.has(node.type)) {
        // Isolate nested function scopes: do not descend into inner function bodies
        return;
      }

      if (CALL_TYPES.has(node.type)) {
        let rawCallee = null;
        if (node.type === 'method_invocation' || node.type === 'member_call_expression') {
          const obj = node.childForFieldName('object');
          const name = node.childForFieldName('name');
          rawCallee = obj && name ? `${obj.text}.${name.text}` : (name ? name.text : node.text);
        } else if (node.type === 'call' && (node.childForFieldName('receiver') || node.childForFieldName('method'))) {
          const receiver = node.childForFieldName('receiver');
          const method = node.childForFieldName('method');
          rawCallee = receiver && method ? `${receiver.text}.${method.text}` : (method ? method.text : (receiver ? receiver.text : node.text));
        } else {
          const fnNode =
            node.childForFieldName('function') ||
            node.childForFieldName('callee') ||
            node.childForFieldName('called_expression') ||
            node.childForFieldName('name');
          if (fnNode && !NESTED_SCOPES.has(fnNode.type)) {
            rawCallee = fnNode.text;
          } else if (node.namedChildren.length > 0) {
            const first = node.namedChild(0);
            if (first && !first.type.includes('argument') && !first.type.includes('param') && !NESTED_SCOPES.has(first.type)) {
              rawCallee = first.text;
            }
          }
        }

        if (rawCallee) {
          const normalized = normalizeCallee(rawCallee);
          if (normalized && !seen.has(normalized)) {
            seen.add(normalized);
            calls.push(normalized);
          }
        }
      }

      for (const child of node.namedChildren) {
        walk(child, false);
      }
    }

    walk(bodyNode, true);
    return calls;
  }

  static isLanguageSupported(lang) {
    return Boolean(resolveLanguage(lang));
  }

  static parse(langName, content, lines) {
    const lang = resolveLanguage(langName);
    if (!lang || !sharedParser) return null;

    try {
      sharedParser.setLanguage(lang);
      const tree = sharedParser.parse(content);
      const symbols = [];
      const imports = [];

      switch (langName) {
        case 'javascript':
        case 'typescript':
        case 'tsx':
          this._extractJsTs(tree.rootNode, lines, symbols, imports);
          break;
        case 'python':
          this._extractPython(tree.rootNode, lines, symbols, imports);
          break;
        case 'go':
          this._extractGo(tree.rootNode, lines, symbols, imports);
          break;
        case 'rust':
          this._extractRust(tree.rootNode, lines, symbols, imports);
          break;
        case 'swift':
          this._extractSwift(tree.rootNode, lines, symbols, imports);
          break;
        case 'java':
          this._extractJava(tree.rootNode, lines, symbols, imports);
          break;
        case 'kotlin':
          this._extractKotlin(tree.rootNode, lines, symbols, imports);
          break;
        case 'cpp':
        case 'c':
          this._extractCpp(tree.rootNode, lines, symbols, imports);
          break;
        case 'csharp':
          this._extractCSharp(tree.rootNode, lines, symbols, imports);
          break;
        case 'php':
          this._extractPhp(tree.rootNode, lines, symbols, imports);
          break;
        case 'ruby':
          this._extractRuby(tree.rootNode, lines, symbols, imports);
          break;
        default:
          return null;
      }

      // Link any container methods to container symbols regardless of declaration order.
      const containers = new Map();
      for (const symbol of symbols) {
        if (
          !containers.has(symbol.name) &&
          (symbol.kind === 'struct' || symbol.kind === 'class' || symbol.kind === 'trait' || symbol.kind === 'interface')
        ) {
          containers.set(symbol.name, symbol);
        }
      }
      for (const sym of symbols) {
        if (!sym.containerName || (sym.kind !== 'method' && sym.kind !== 'constructor' && sym.kind !== 'function')) continue;
        const container = containers.get(sym.containerName);
        if (!container || !Array.isArray(container.methods)) continue;
        if (!container.methods.some((m) => m.name === sym.name && m.startLine === sym.startLine)) {
          container.methods.push(sym);
        }
      }

      return { symbols, imports };
    } catch (_) {
      return null;
    }
  }

  // --- 1. JS / TS / TSX ---
  static _extractJsTs(rootNode, lines, symbols, imports) {
    const walk = (node) => {
      for (const child of node.namedChildren) {
        let target = child;
        if (target.type === 'export_statement') {
          const decl = target.childForFieldName('declaration') || target.namedChild(0);
          if (decl && decl.type !== 'export_clause') target = decl;
        }

        if (target.type === 'expression_statement') {
          const inner = target.namedChild(0);
          if (inner && (inner.type === 'internal_module' || inner.type === 'module')) {
            target = inner;
          }
        }

        if (target.type === 'internal_module' || target.type === 'module') {
          const name = target.childForFieldName('name')?.text;
          const { startLine, endLine } = getLines(target);
          if (name) {
            symbols.push({
              name,
              shortName: name,
              kind: 'namespace',
              startLine,
              endLine,
              hash: getSliceHash(lines, startLine, endLine),
            });
          }
          const body = target.childForFieldName('body');
          if (body) walk(body);
          continue;
        }

        if (target.type === 'import_statement') {
          const srcNode = target.childForFieldName('source');
          const source = srcNode?.text?.replace(/^['"]|['"]$/g, '');
          const { startLine } = getLines(target);
          if (source) imports.push({ source, line: startLine });
          continue;
        }

        if (target.type === 'interface_declaration') {
          const name = target.childForFieldName('name')?.text;
          const { startLine, endLine } = getLines(target);
          if (name) {
            symbols.push({
              name,
              shortName: name,
              kind: 'interface',
              startLine,
              endLine,
              hash: getSliceHash(lines, startLine, endLine),
            });
          }
          continue;
        }

        if (target.type === 'type_alias_declaration') {
          const name = target.childForFieldName('name')?.text;
          const { startLine, endLine } = getLines(target);
          if (name) {
            symbols.push({
              name,
              shortName: name,
              kind: 'type',
              startLine,
              endLine,
              hash: getSliceHash(lines, startLine, endLine),
            });
          }
          continue;
        }

        if (target.type === 'enum_declaration') {
          const name = target.childForFieldName('name')?.text;
          const { startLine, endLine } = getLines(target);
          if (name) {
            symbols.push({
              name,
              shortName: name,
              kind: 'enum',
              startLine,
              endLine,
              hash: getSliceHash(lines, startLine, endLine),
            });
          }
          continue;
        }

        if (target.type === 'class_declaration' || target.type === 'class_expression') {
          const className = target.childForFieldName('name')?.text || 'AnonymousClass';
          const { startLine, endLine } = getLines(target);
          const classSym = {
            name: className,
            shortName: className,
            kind: 'class',
            startLine,
            endLine,
            hash: getSliceHash(lines, startLine, endLine),
            methods: [],
          };
          symbols.push(classSym);

          const body = target.childForFieldName('body');
          if (body) {
            for (const m of body.namedChildren) {
              if (m.type === 'method_definition') {
                const mName = m.childForFieldName('name')?.text;
                if (!mName) continue;
                const isConstructor = mName === 'constructor';
                const { startLine: ms, endLine: me } = getLines(m);
                const rawParams = m.childForFieldName('parameters')?.text || '()';
                const sigParams = rawParams.replace(/\s+/g, ' ');
                const mBody = m.childForFieldName('body') || m;
                const calls = TreeSitterParser.extractCalls(mBody);
                const mSym = {
                  name: `${className}.${mName}`,
                  shortName: mName,
                  containerName: className,
                  kind: isConstructor ? 'constructor' : 'method',
                  signature: `${mName}${sigParams}`,
                  startLine: ms,
                  endLine: me,
                  hash: getSliceHash(lines, ms, me),
                  calls,
                };
                symbols.push(mSym);
                classSym.methods.push(mSym);
              } else if (
                m.type === 'public_field_definition' ||
                m.type === 'field_definition' ||
                m.type === 'property_definition'
              ) {
                const val = m.childForFieldName('value');
                if (val && (val.type === 'arrow_function' || val.type === 'function_expression')) {
                  const mName = m.childForFieldName('name')?.text;
                  if (!mName) continue;
                  const { startLine: ms, endLine: me } = getLines(m);
                  const rawParams = val.childForFieldName('parameters')?.text || '()';
                  const sigParams = rawParams.replace(/\s+/g, ' ');
                  const fBody = val.childForFieldName('body') || val;
                  const calls = TreeSitterParser.extractCalls(fBody);
                  const mSym = {
                    name: `${className}.${mName}`,
                    shortName: mName,
                    containerName: className,
                    kind: 'method',
                    signature: `${mName}${sigParams}`,
                    startLine: ms,
                    endLine: me,
                    hash: getSliceHash(lines, ms, me),
                    calls,
                  };
                  symbols.push(mSym);
                  classSym.methods.push(mSym);
                }
              }
            }
          }
          continue;
        }

        if (target.type === 'function_declaration' || target.type === 'generator_function_declaration') {
          const fnName = target.childForFieldName('name')?.text;
          if (fnName) {
            const { startLine, endLine } = getLines(target);
            const rawParams = target.childForFieldName('parameters')?.text || '()';
            const sigParams = rawParams.replace(/\s+/g, ' ');
            const body = target.childForFieldName('body') || target;
            const calls = TreeSitterParser.extractCalls(body);
            symbols.push({
              name: fnName,
              shortName: fnName,
              kind: 'function',
              signature: `${fnName}${sigParams}`,
              startLine,
              endLine,
              hash: getSliceHash(lines, startLine, endLine),
              calls,
            });
          }
          continue;
        }

        if (target.type === 'lexical_declaration' || target.type === 'variable_declaration') {
          for (const decl of target.namedChildren) {
            if (decl.type === 'variable_declarator') {
              const varName = decl.childForFieldName('name')?.text;
              const val = decl.childForFieldName('value');
              if (val && (val.type === 'arrow_function' || val.type === 'function_expression')) {
                const { startLine, endLine } = getLines(target);
                const rawParams = val.childForFieldName('parameters')?.text || '()';
                const sigParams = rawParams.replace(/\s+/g, ' ');
                const fBody = val.childForFieldName('body') || val;
                const calls = TreeSitterParser.extractCalls(fBody);
                symbols.push({
                  name: varName,
                  shortName: varName,
                  kind: 'function',
                  signature: `${varName}${sigParams}`,
                  startLine,
                  endLine,
                  hash: getSliceHash(lines, startLine, endLine),
                  calls,
                });
              }
            }
          }
        }
      }
    };
    walk(rootNode);
  }

  // --- 2. Python ---
  static _extractPython(rootNode, lines, symbols, imports) {
    const processItem = (node) => {
      let target = node;
      let outerNode = node;

      if (target.type === 'decorated_definition') {
        outerNode = target;
        target =
          target.childForFieldName('definition') ||
          target.namedChildren.find((c) => c.type === 'function_definition' || c.type === 'class_definition');
        if (!target) return;
      }

      if (target.type === 'import_statement') {
        const { startLine } = getLines(target);
        for (const nameNode of target.namedChildren) {
          if (nameNode.type === 'dotted_name' || nameNode.type === 'aliased_import') {
            const src = nameNode.childForFieldName('name')?.text || nameNode.text;
            imports.push({ source: src, line: startLine });
          }
        }
      } else if (target.type === 'import_from_statement') {
        const { startLine } = getLines(target);
        const moduleNameNode = target.childForFieldName('module_name');
        const src = moduleNameNode ? moduleNameNode.text : target.text;
        imports.push({ source: src, line: startLine });
      } else if (target.type === 'class_definition') {
        const className = target.childForFieldName('name')?.text;
        if (!className) return;
        const { startLine } = getLines(outerNode);
        const { endLine } = getLines(target);
        const classSym = {
          name: className,
          shortName: className,
          kind: 'class',
          startLine,
          endLine,
          hash: getSliceHash(lines, startLine, endLine),
          methods: [],
        };
        symbols.push(classSym);

        const body = target.childForFieldName('body');
        if (body) {
          for (const m of body.namedChildren) {
            let mTarget = m;
            let mOuter = m;
            if (mTarget.type === 'decorated_definition') {
              mOuter = mTarget;
              mTarget =
                mTarget.childForFieldName('definition') ||
                mTarget.namedChildren.find((c) => c.type === 'function_definition');
            }
            if (mTarget && mTarget.type === 'function_definition') {
              const mName = mTarget.childForFieldName('name')?.text;
              if (mName) {
                const { startLine: ms } = getLines(mOuter);
                const { endLine: me } = getLines(mTarget);
                const mBody = mTarget.childForFieldName('body') || mTarget;
                const calls = TreeSitterParser.extractCalls(mBody);
                const mSym = {
                  name: `${className}.${mName}`,
                  shortName: mName,
                  containerName: className,
                  kind: 'method',
                  startLine: ms,
                  endLine: me,
                  hash: getSliceHash(lines, ms, me),
                  calls,
                };
                symbols.push(mSym);
                classSym.methods.push(mSym);
              }
            }
          }
        }
      } else if (target.type === 'function_definition') {
        const fnName = target.childForFieldName('name')?.text;
        if (fnName) {
          const { startLine } = getLines(outerNode);
          const { endLine } = getLines(target);
          const body = target.childForFieldName('body') || target;
          const calls = TreeSitterParser.extractCalls(body);
          symbols.push({
            name: fnName,
            shortName: fnName,
            kind: 'function',
            startLine,
            endLine,
            hash: getSliceHash(lines, startLine, endLine),
            calls,
          });
        }
      }
    };

    for (const child of rootNode.namedChildren) {
      processItem(child);
    }
  }

  // --- 3. Go ---
  static _extractGo(rootNode, lines, symbols, imports) {
    for (const child of rootNode.namedChildren) {
      if (child.type === 'import_declaration') {
        for (const spec of child.namedChildren) {
          if (spec.type === 'import_spec') {
            const pathNode = spec.childForFieldName('path');
            const src = pathNode?.text?.replace(/^["']|["']$/g, '');
            const { startLine } = getLines(spec);
            if (src) imports.push({ source: src, line: startLine });
          }
        }
      } else if (child.type === 'type_declaration') {
        for (const spec of child.namedChildren) {
          if (spec.type === 'type_spec') {
            const name = spec.childForFieldName('name')?.text;
            if (!name) continue;
            const typeNode = spec.childForFieldName('type');
            const kind = typeNode?.type === 'interface_type' ? 'interface' : 'struct';
            const { startLine, endLine } = getLines(child);
            const typeSym = {
              name,
              shortName: name,
              kind,
              startLine,
              endLine,
              hash: getSliceHash(lines, startLine, endLine),
              methods: [],
            };
            symbols.push(typeSym);

            if (typeNode && typeNode.type === 'interface_type') {
              for (const elem of typeNode.namedChildren) {
                if (elem.type === 'method_elem' || elem.type === 'method_spec') {
                  const mName = elem.childForFieldName('name')?.text;
                  if (mName) {
                    const { startLine: ms, endLine: me } = getLines(elem);
                    const mSym = {
                      name: `${name}.${mName}`,
                      shortName: mName,
                      containerName: name,
                      kind: 'method',
                      startLine: ms,
                      endLine: me,
                      hash: getSliceHash(lines, ms, me),
                    };
                    symbols.push(mSym);
                    typeSym.methods.push(mSym);
                  }
                }
              }
            }
          }
        }
      } else if (child.type === 'method_declaration') {
        const name = child.childForFieldName('name')?.text;
        const rcvrNode = child.childForFieldName('receiver');
        const rcvrName = findTypeIdentifier(rcvrNode) || 'Receiver';
        const { startLine, endLine } = getLines(child);
        const body = child.childForFieldName('body') || child;
        const calls = TreeSitterParser.extractCalls(body);
        const mSym = {
          name: `${rcvrName}.${name}`,
          shortName: name,
          containerName: rcvrName,
          kind: 'method',
          startLine,
          endLine,
          hash: getSliceHash(lines, startLine, endLine),
          calls,
        };
        symbols.push(mSym);
        const parentType = symbols.find((s) => s.name === rcvrName && (s.kind === 'struct' || s.kind === 'interface'));
        if (parentType && Array.isArray(parentType.methods)) {
          parentType.methods.push(mSym);
        }
      } else if (child.type === 'function_declaration') {
        const name = child.childForFieldName('name')?.text;
        const { startLine, endLine } = getLines(child);
        const body = child.childForFieldName('body') || child;
        const calls = TreeSitterParser.extractCalls(body);
        symbols.push({
          name,
          shortName: name,
          kind: 'function',
          startLine,
          endLine,
          hash: getSliceHash(lines, startLine, endLine),
          calls,
        });
      }
    }
  }

  // --- 4. Rust ---
  static _extractRust(rootNode, lines, symbols, imports) {
    const walk = (node) => {
      for (const child of node.namedChildren) {
        if (child.type === 'use_declaration') {
          const arg = child.childForFieldName('argument')?.text || child.text;
          const { startLine } = getLines(child);
          imports.push({ source: arg, line: startLine });
        } else if (child.type === 'mod_item') {
          const name = child.childForFieldName('name')?.text;
          const { startLine, endLine } = getLines(child);
          if (name) {
            symbols.push({
              name,
              shortName: name,
              kind: 'module',
              startLine,
              endLine,
              hash: getSliceHash(lines, startLine, endLine),
            });
          }
          const body = child.childForFieldName('body');
          if (body) walk(body);
        } else if (child.type === 'trait_item') {
          const name = child.childForFieldName('name')?.text;
          const { startLine, endLine } = getLines(child);
          const traitSym = {
            name,
            shortName: name,
            kind: 'trait',
            startLine,
            endLine,
            hash: getSliceHash(lines, startLine, endLine),
            methods: [],
          };
          symbols.push(traitSym);
          const body = child.childForFieldName('body');
          if (body) {
            for (const m of body.namedChildren) {
              if (m.type === 'function_signature_item' || m.type === 'function_item') {
                const fnName = m.childForFieldName('name')?.text;
                const { startLine: ms, endLine: me } = getLines(m);
                const mBody = m.childForFieldName('body') || m;
                const calls = TreeSitterParser.extractCalls(mBody);
                const mSym = {
                  name: fnName,
                  shortName: fnName,
                  containerName: name,
                  kind: 'function',
                  startLine: ms,
                  endLine: me,
                  hash: getSliceHash(lines, ms, me),
                  calls,
                };
                symbols.push(mSym);
                traitSym.methods.push(mSym);
              }
            }
          }
        } else if (child.type === 'struct_item') {
          const name = child.childForFieldName('name')?.text;
          const { startLine, endLine } = getLines(child);
          symbols.push({
            name,
            shortName: name,
            kind: 'struct',
            startLine,
            endLine,
            hash: getSliceHash(lines, startLine, endLine),
            methods: [],
          });
        } else if (child.type === 'enum_item') {
          const name = child.childForFieldName('name')?.text;
          const { startLine, endLine } = getLines(child);
          symbols.push({
            name,
            shortName: name,
            kind: 'enum',
            startLine,
            endLine,
            hash: getSliceHash(lines, startLine, endLine),
          });
        } else if (child.type === 'impl_item') {
          const typeNode = child.childForFieldName('type');
          const rawType = typeNode?.text || 'Impl';
          const targetName = rawType.replace(/<.*>$/, '').trim();
          const body = child.childForFieldName('body');
          if (body) {
            for (const m of body.namedChildren) {
              if (m.type === 'function_item') {
                const fnName = m.childForFieldName('name')?.text;
                const { startLine: ms, endLine: me } = getLines(m);
                const mBody = m.childForFieldName('body') || m;
                const calls = TreeSitterParser.extractCalls(mBody);
                const mSym = {
                  name: `${targetName}.${fnName}`,
                  shortName: fnName,
                  containerName: targetName,
                  kind: 'method',
                  startLine: ms,
                  endLine: me,
                  hash: getSliceHash(lines, ms, me),
                  calls,
                };
                symbols.push(mSym);
                const parentStruct = symbols.find((s) => s.name === targetName && (s.kind === 'struct' || s.kind === 'trait'));
                if (parentStruct && Array.isArray(parentStruct.methods)) {
                  parentStruct.methods.push(mSym);
                }
              }
            }
          }
        } else if (child.type === 'function_item') {
          const fnName = child.childForFieldName('name')?.text;
          const { startLine, endLine } = getLines(child);
          const body = child.childForFieldName('body') || child;
          const calls = TreeSitterParser.extractCalls(body);
          symbols.push({
            name: fnName,
            shortName: fnName,
            kind: 'function',
            startLine,
            endLine,
            hash: getSliceHash(lines, startLine, endLine),
            calls,
          });
        }
      }
    };
    walk(rootNode);
  }

  // --- 5. Swift ---
  static _extractSwift(rootNode, lines, symbols, imports) {
    for (const child of rootNode.namedChildren) {
      if (child.type === 'import_declaration') {
        const pathNode = child.namedChildren.find((c) => c.type === 'identifier');
        const src = pathNode?.text || child.text.replace(/^import\s+/, '').trim();
        const { startLine } = getLines(child);
        imports.push({ source: src, line: startLine });
      } else if (
        child.type === 'class_declaration' ||
        child.type === 'struct_declaration' ||
        child.type === 'protocol_declaration' ||
        child.type === 'enum_declaration' ||
        child.type === 'extension_declaration'
      ) {
        const typeId = child.namedChildren.find((c) => c.type === 'type_identifier' || c.type === 'user_type');
        const typeName = typeId?.text || child.childForFieldName('name')?.text || 'Type';
        let kind = 'class';
        const hasStructToken = child.children?.some((c) => c.type === 'struct');
        const hasEnumToken = child.children?.some((c) => c.type === 'enum');
        const hasExtToken = child.children?.some((c) => c.type === 'extension');
        if (child.type === 'struct_declaration' || hasStructToken) kind = 'struct';
        else if (child.type === 'protocol_declaration') kind = 'interface';
        else if (child.type === 'enum_declaration' || hasEnumToken) kind = 'enum';
        else if (child.type === 'extension_declaration' || hasExtToken) kind = 'extension';

        const { startLine, endLine } = getLines(child);
        const classSym = {
          name: typeName,
          shortName: typeName,
          kind,
          startLine,
          endLine,
          hash: getSliceHash(lines, startLine, endLine),
          methods: [],
        };
        symbols.push(classSym);

        const body = child.namedChildren.find((c) => c.type === 'class_body' || c.type === 'protocol_body');
        if (body) {
          for (const m of body.namedChildren) {
            if (m.type === 'function_declaration' || m.type === 'protocol_function_declaration') {
              const fnId = m.namedChildren.find((c) => c.type === 'simple_identifier');
              const fnName = fnId?.text;
              if (fnName) {
                const { startLine: ms, endLine: me } = getLines(m);
                const mBody = m.childForFieldName('body') || m.namedChildren.find((c) => c.type.includes('body') || c.type.includes('block')) || m;
                const calls = TreeSitterParser.extractCalls(mBody);
                const mSym = {
                  name: `${typeName}.${fnName}`,
                  shortName: fnName,
                  containerName: typeName,
                  kind: 'method',
                  startLine: ms,
                  endLine: me,
                  hash: getSliceHash(lines, ms, me),
                  calls,
                };
                symbols.push(mSym);
                classSym.methods.push(mSym);
              }
            } else if (m.type === 'property_declaration') {
              const varMatch = m.text.match(/var\s+([A-Za-z0-9_]+)/);
              if (varMatch && varMatch[1] === 'body') {
                const { startLine: ms, endLine: me } = getLines(m);
                const mBody = m.namedChildren.find((c) => c.type.includes('body') || c.type.includes('block')) || m;
                const calls = TreeSitterParser.extractCalls(mBody);
                const mSym = {
                  name: `${typeName}.body`,
                  shortName: 'body',
                  containerName: typeName,
                  kind: 'method',
                  startLine: ms,
                  endLine: me,
                  hash: getSliceHash(lines, ms, me),
                  calls,
                };
                symbols.push(mSym);
                classSym.methods.push(mSym);
              }
            }
          }
        }
      } else if (child.type === 'function_declaration') {
        const fnId = child.namedChildren.find((c) => c.type === 'simple_identifier');
        const fnName = fnId?.text;
        if (fnName) {
          const { startLine, endLine } = getLines(child);
          const body = child.childForFieldName('body') || child.namedChildren.find((c) => c.type.includes('body') || c.type.includes('block')) || child;
          const calls = TreeSitterParser.extractCalls(body);
          symbols.push({
            name: fnName,
            shortName: fnName,
            kind: 'function',
            startLine,
            endLine,
            hash: getSliceHash(lines, startLine, endLine),
            calls,
          });
        }
      }
    }
  }

  // --- 6. Java ---
  static _extractJava(rootNode, lines, symbols, imports) {
    const walk = (node, parentName = '') => {
      for (const child of node.namedChildren) {
        if (child.type === 'import_declaration') {
          const srcNode = child.namedChildren.find((c) => c.type === 'scoped_identifier' || c.type === 'identifier');
          const src = srcNode?.text || child.text;
          const { startLine } = getLines(child);
          imports.push({ source: src, line: startLine });
        } else if (
          child.type === 'class_declaration' ||
          child.type === 'interface_declaration' ||
          child.type === 'record_declaration' ||
          child.type === 'enum_declaration'
        ) {
          const rawName = child.childForFieldName('name')?.text;
          if (!rawName) continue;
          const name = parentName ? `${parentName}.${rawName}` : rawName;
          let kind = 'class';
          if (child.type === 'interface_declaration') kind = 'interface';
          else if (child.type === 'enum_declaration') kind = 'enum';
          else if (child.type === 'record_declaration') kind = 'record';

          const { startLine, endLine } = getLines(child);
          const classSym = {
            name,
            shortName: rawName,
            kind,
            startLine,
            endLine,
            hash: getSliceHash(lines, startLine, endLine),
            methods: [],
          };
          symbols.push(classSym);

          const body = child.childForFieldName('body');
          if (body) {
            for (const m of body.namedChildren) {
              if (m.type === 'method_declaration' || m.type === 'constructor_declaration') {
                const mName = m.childForFieldName('name')?.text;
                if (!mName) continue;
                const { startLine: ms, endLine: me } = getLines(m);
                const bodyNode = m.childForFieldName('body') || m;
                const calls = TreeSitterParser.extractCalls(bodyNode);
                const mSym = {
                  name: `${name}.${mName}`,
                  shortName: mName,
                  containerName: name,
                  kind: m.type === 'constructor_declaration' ? 'constructor' : 'method',
                  startLine: ms,
                  endLine: me,
                  hash: getSliceHash(lines, ms, me),
                  calls,
                };
                symbols.push(mSym);
                classSym.methods.push(mSym);
              } else if (
                m.type === 'class_declaration' ||
                m.type === 'interface_declaration' ||
                m.type === 'record_declaration' ||
                m.type === 'enum_declaration'
              ) {
                walk({ namedChildren: [m] }, name);
              }
            }
          }
        }
      }
    };
    walk(rootNode);
  }

  // --- 7. Kotlin ---
  static _extractKotlin(rootNode, lines, symbols, imports) {
    const walk = (node, parentName = '') => {
      for (const child of node.namedChildren) {
        if (child.type === 'import_header') {
          const pathNode = child.namedChildren.find((c) => c.type === 'identifier' || c.type === 'scoped_identifier');
          const src = pathNode?.text || child.text.replace(/^import\s+/, '').trim();
          const { startLine } = getLines(child);
          imports.push({ source: src, line: startLine });
        } else if (child.type === 'class_declaration' || child.type === 'object_declaration') {
          const typeId = child.namedChildren.find((c) => c.type === 'type_identifier');
          const rawName =
            typeId?.text ||
            child.childForFieldName('name')?.text ||
            (child.type === 'object_declaration' ? 'Companion' : 'Class');
          const name = parentName ? `${parentName}.${rawName}` : rawName;
          let kind = 'class';
          if (child.text.includes('interface ')) kind = 'interface';
          else if (child.text.includes('enum class ')) kind = 'enum';

          const { startLine, endLine } = getLines(child);
          const classSym = {
            name,
            shortName: rawName,
            kind,
            startLine,
            endLine,
            hash: getSliceHash(lines, startLine, endLine),
            methods: [],
          };
          symbols.push(classSym);

          const body = child.namedChildren.find((c) => c.type === 'class_body');
          if (body) {
            for (const m of body.namedChildren) {
              if (m.type === 'function_declaration') {
                const fnId = m.namedChildren.find((c) => c.type === 'simple_identifier');
                const fnName = fnId?.text;
                if (fnName) {
                  const { startLine: ms, endLine: me } = getLines(m);
                  const mBody = m.childForFieldName('body') || m.namedChildren.find((c) => c.type.includes('body') || c.type.includes('block')) || m;
                  const calls = TreeSitterParser.extractCalls(mBody);
                  const mSym = {
                    name: `${name}.${fnName}`,
                    shortName: fnName,
                    containerName: name,
                    kind: 'method',
                    startLine: ms,
                    endLine: me,
                    hash: getSliceHash(lines, ms, me),
                    calls,
                  };
                  symbols.push(mSym);
                  classSym.methods.push(mSym);
                }
              } else if (m.type === 'class_declaration' || m.type === 'object_declaration') {
                walk({ namedChildren: [m] }, name);
              }
            }
          }
        } else if (child.type === 'function_declaration') {
          const fnId = child.namedChildren.find((c) => c.type === 'simple_identifier');
          const fnName = fnId?.text;
          if (fnName) {
            const { startLine, endLine } = getLines(child);
            const body = child.childForFieldName('body') || child.namedChildren.find((c) => c.type.includes('body') || c.type.includes('block')) || child;
            const calls = TreeSitterParser.extractCalls(body);
            symbols.push({
              name: fnName,
              shortName: fnName,
              kind: 'function',
              startLine,
              endLine,
              hash: getSliceHash(lines, startLine, endLine),
              calls,
            });
          }
        }
      }
    };
    walk(rootNode);
  }

  // --- 8. C / C++ ---
  static _extractCpp(rootNode, lines, symbols, imports) {
    const walk = (node, prefix = '') => {
      for (const child of node.namedChildren) {
        if (child.type === 'preproc_include') {
          const pathNode = child.namedChildren[0];
          const src = pathNode?.text || child.text;
          const { startLine } = getLines(child);
          imports.push({ source: src, line: startLine });
        } else if (child.type === 'namespace_definition') {
          const body = child.childForFieldName('body');
          if (body) walk(body, prefix);
        } else if (child.type === 'template_declaration') {
          for (const inner of child.namedChildren) {
            if (
              inner.type === 'class_specifier' ||
              inner.type === 'struct_specifier' ||
              inner.type === 'function_definition'
            ) {
              walk({ namedChildren: [inner] }, prefix);
            }
          }
        } else if (child.type === 'type_definition') {
          const structSpec = child.namedChildren.find((c) => c.type === 'struct_specifier');
          const typeId = child.namedChildren.find((c) => c.type === 'type_identifier');
          if (structSpec) {
            const rawName = typeId?.text || structSpec.childForFieldName('name')?.text;
            if (rawName) {
              const { startLine, endLine } = getLines(child);
              symbols.push({
                name: rawName,
                shortName: rawName,
                kind: 'struct',
                startLine,
                endLine,
                hash: getSliceHash(lines, startLine, endLine),
              });
            }
          }
        } else if (child.type === 'class_specifier' || child.type === 'struct_specifier') {
          const name = child.childForFieldName('name')?.text;
          if (!name) continue;
          const kind = child.type === 'struct_specifier' ? 'struct' : 'class';
          const { startLine, endLine } = getLines(child);
          const classSym = {
            name,
            shortName: name,
            kind,
            startLine,
            endLine,
            hash: getSliceHash(lines, startLine, endLine),
            methods: [],
          };
          symbols.push(classSym);

          const body = child.childForFieldName('body');
          if (body) {
            for (const m of body.namedChildren) {
              if (m.type === 'field_declaration' || m.type === 'function_definition') {
                const declarator = m.childForFieldName('declarator');
                const cleanName = findIdentifier(declarator);
                if (cleanName) {
                  const { startLine: ms, endLine: me } = getLines(m);
                  const bodyNode = m.childForFieldName('body') || m;
                  const calls = TreeSitterParser.extractCalls(bodyNode);
                  const mSym = {
                    name: `${name}::${cleanName}`,
                    shortName: cleanName,
                    containerName: name,
                    kind: 'method',
                    startLine: ms,
                    endLine: me,
                    hash: getSliceHash(lines, ms, me),
                    calls,
                  };
                  symbols.push(mSym);
                  classSym.methods.push(mSym);
                }
              }
            }
          }
        } else if (child.type === 'function_definition') {
          const declarator = child.childForFieldName('declarator');
          const fnName = findIdentifier(declarator);
          if (fnName) {
            const { startLine, endLine } = getLines(child);
            const bodyNode = child.childForFieldName('body') || child;
            const calls = TreeSitterParser.extractCalls(bodyNode);
            symbols.push({
              name: fnName,
              shortName: fnName,
              kind: 'function',
              startLine,
              endLine,
              hash: getSliceHash(lines, startLine, endLine),
              calls,
            });
          }
        }
      }
    };
    walk(rootNode);
  }

  // --- 9. C# ---
  static _extractCSharp(rootNode, lines, symbols, imports) {
    const walk = (node) => {
      for (const child of node.namedChildren) {
        if (child.type === 'using_directive') {
          const nameNode = child.namedChildren.find((c) => c.type === 'qualified_name' || c.type === 'identifier');
          const src = nameNode?.text || child.text;
          const { startLine } = getLines(child);
          imports.push({ source: src, line: startLine });
        } else if (child.type === 'enum_declaration') {
          const name = child.childForFieldName('name')?.text;
          if (name) {
            const { startLine, endLine } = getLines(child);
            symbols.push({
              name,
              shortName: name,
              kind: 'enum',
              startLine,
              endLine,
              hash: getSliceHash(lines, startLine, endLine),
            });
          }
        } else if (
          child.type === 'class_declaration' ||
          child.type === 'interface_declaration' ||
          child.type === 'struct_declaration' ||
          child.type === 'record_declaration'
        ) {
          const name = child.childForFieldName('name')?.text;
          if (!name) continue;
          let kind = 'class';
          if (child.type === 'interface_declaration') kind = 'interface';
          else if (child.type === 'struct_declaration') kind = 'struct';
          else if (child.type === 'record_declaration') kind = 'record';

          const { startLine, endLine } = getLines(child);
          const classSym = {
            name,
            shortName: name,
            kind,
            startLine,
            endLine,
            hash: getSliceHash(lines, startLine, endLine),
            methods: [],
          };
          symbols.push(classSym);

          const body = child.childForFieldName('body');
          if (body) {
            for (const m of body.namedChildren) {
              if (m.type === 'method_declaration' || m.type === 'constructor_declaration') {
                const mName = m.childForFieldName('name')?.text;
                if (mName) {
                  const { startLine: ms, endLine: me } = getLines(m);
                  const bodyNode = m.childForFieldName('body') || m;
                  const calls = TreeSitterParser.extractCalls(bodyNode);
                  const mSym = {
                    name: `${name}.${mName}`,
                    shortName: mName,
                    containerName: name,
                    kind: m.type === 'constructor_declaration' ? 'constructor' : 'method',
                    startLine: ms,
                    endLine: me,
                    hash: getSliceHash(lines, ms, me),
                    calls,
                  };
                  symbols.push(mSym);
                  classSym.methods.push(mSym);
                }
              }
            }
          }
        } else {
          walk(child);
        }
      }
    };
    walk(rootNode);
  }

  // --- 10. PHP ---
  static _extractPhp(rootNode, lines, symbols, imports) {
    const walk = (node) => {
      for (const child of node.namedChildren) {
        if (child.type === 'namespace_use_declaration') {
          const clause = child.namedChildren.find((c) => c.type === 'namespace_use_clause');
          const src = clause?.text || child.text;
          const { startLine } = getLines(child);
          imports.push({ source: src, line: startLine });
        } else if (
          child.type === 'class_declaration' ||
          child.type === 'interface_declaration' ||
          child.type === 'trait_declaration' ||
          child.type === 'enum_declaration'
        ) {
          const name = child.childForFieldName('name')?.text;
          if (!name) continue;
          let kind = 'class';
          if (child.type === 'interface_declaration') kind = 'interface';
          else if (child.type === 'trait_declaration') kind = 'trait';
          else if (child.type === 'enum_declaration') kind = 'enum';

          const { startLine, endLine } = getLines(child);
          const classSym = {
            name,
            shortName: name,
            kind,
            startLine,
            endLine,
            hash: getSliceHash(lines, startLine, endLine),
            methods: [],
          };
          symbols.push(classSym);

          const body = child.childForFieldName('body');
          if (body) {
            for (const m of body.namedChildren) {
              if (m.type === 'method_declaration') {
                const mName = m.childForFieldName('name')?.text;
                if (mName) {
                  const { startLine: ms, endLine: me } = getLines(m);
                  const bodyNode = m.childForFieldName('body') || m;
                  const calls = TreeSitterParser.extractCalls(bodyNode);
                  const mSym = {
                    name: `${name}::${mName}`,
                    shortName: mName,
                    containerName: name,
                    kind: 'method',
                    startLine: ms,
                    endLine: me,
                    hash: getSliceHash(lines, ms, me),
                    calls,
                  };
                  symbols.push(mSym);
                  classSym.methods.push(mSym);
                }
              }
            }
          }
        } else if (child.type === 'function_definition') {
          const name = child.childForFieldName('name')?.text;
          if (name) {
            const { startLine, endLine } = getLines(child);
            const bodyNode = child.childForFieldName('body') || child;
            const calls = TreeSitterParser.extractCalls(bodyNode);
            symbols.push({
              name,
              shortName: name,
              kind: 'function',
              startLine,
              endLine,
              hash: getSliceHash(lines, startLine, endLine),
              calls,
            });
          }
        } else {
          walk(child);
        }
      }
    };
    walk(rootNode);
  }

  // --- 11. Ruby ---
  static _extractRuby(rootNode, lines, symbols, imports) {
    const walk = (node, prefix = '') => {
      for (const child of node.namedChildren) {
        if (child.type === 'call') {
          const method = child.childForFieldName('method')?.text;
          if (method === 'require' || method === 'require_relative') {
            const argNode = child.childForFieldName('arguments')?.namedChild(0);
            const src = argNode?.text?.replace(/^['"]|['"]$/g, '');
            const { startLine } = getLines(child);
            if (src) imports.push({ source: src, line: startLine });
          }
        } else if (child.type === 'class' || child.type === 'module') {
          const rawName = child.childForFieldName('name')?.text;
          if (!rawName) continue;
          const name = prefix ? `${prefix}::${rawName}` : rawName;
          const kind = child.type === 'module' ? 'module' : 'class';
          const { startLine, endLine } = getLines(child);
          const classSym = {
            name,
            shortName: rawName,
            kind,
            startLine,
            endLine,
            hash: getSliceHash(lines, startLine, endLine),
            methods: [],
          };
          symbols.push(classSym);

          const body = child.childForFieldName('body');
          if (body) {
            for (const m of body.namedChildren) {
              if (m.type === 'method' || m.type === 'singleton_method') {
                const mName = m.childForFieldName('name')?.text;
                if (mName) {
                  const { startLine: ms, endLine: me } = getLines(m);
                  const sep = m.type === 'singleton_method' ? '.' : '#';
                  const bodyNode = m.childForFieldName('body') || m;
                  const calls = TreeSitterParser.extractCalls(bodyNode);
                  const mSym = {
                    name: `${name}${sep}${mName}`,
                    shortName: mName,
                    containerName: name,
                    kind: 'method',
                    startLine: ms,
                    endLine: me,
                    hash: getSliceHash(lines, ms, me),
                    calls,
                  };
                  symbols.push(mSym);
                  classSym.methods.push(mSym);
                }
              } else if (m.type === 'class' || m.type === 'module') {
                walk({ namedChildren: [m] }, name);
              }
            }
          }
        } else if (child.type === 'method') {
          const name = child.childForFieldName('name')?.text;
          if (name) {
            const { startLine, endLine } = getLines(child);
            const bodyNode = child.childForFieldName('body') || child;
            const calls = TreeSitterParser.extractCalls(bodyNode);
            symbols.push({
              name,
              shortName: name,
              kind: 'function',
              startLine,
              endLine,
              hash: getSliceHash(lines, startLine, endLine),
              calls,
            });
          }
        }
      }
    };
    walk(rootNode);
  }
}

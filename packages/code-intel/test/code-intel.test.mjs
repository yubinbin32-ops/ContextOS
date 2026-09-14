import test from 'node:test';
import assert from 'node:assert/strict';
import { LanguageRegistry, CodeTools, CoverageChecker } from '../src/index.mjs';

const JS_CODE = `import fs from 'node:fs';
import path from 'node:path';

export class ServiceEngine {
  constructor(name) {
    this.name = name;
  }

  start() {
    console.log('Starting ' + this.name);
    return true;
  }

  stop() {
    console.log('Stopping ' + this.name);
    return false;
  }
}

export function helperFunction(val) {
  return val * 2;
}
`;

const PYTHON_CODE = `import sys
from os import path

class DataProcessor:
    def __init__(self, data):
        self.data = data

    def process(self):
        return [x.strip() for x in self.data]

def clean_record(rec):
    return rec.lower()
`;

test('LanguageRegistry parses JS/TS symbols and imports', () => {
  const structure = LanguageRegistry.parseStructure('src/engine.js', JS_CODE);
  assert.equal(structure.language, 'javascript');
  assert.equal(structure.capability, 'L3');
  assert.equal(structure.imports.length, 2);

  const symbols = structure.symbols;
  assert.ok(symbols.some((s) => s.name === 'ServiceEngine' && s.kind === 'class'));
  assert.ok(symbols.some((s) => s.name === 'ServiceEngine.start' && s.kind === 'method'));
  assert.ok(symbols.some((s) => s.name === 'ServiceEngine.stop' && s.kind === 'method'));
  assert.ok(symbols.some((s) => s.name === 'helperFunction' && s.kind === 'function'));
});

test('LanguageRegistry parses Python symbols and imports', () => {
  const structure = LanguageRegistry.parseStructure('app/proc.py', PYTHON_CODE);
  assert.equal(structure.language, 'python');
  assert.equal(structure.capability, 'L3');
  assert.equal(structure.imports.length, 2);

  const symbols = structure.symbols;
  assert.ok(symbols.some((s) => s.name === 'DataProcessor' && s.kind === 'class'));
  assert.ok(symbols.some((s) => s.name === 'DataProcessor.process' && s.kind === 'method'));
  assert.ok(symbols.some((s) => s.name === 'clean_record' && s.kind === 'function'));
});

test('LanguageRegistry handles complex JS/TS with strings containing braces and comments', () => {
  const codeWithEdgeCases = `
export interface UserConfig {
  apiKey: string;
  timeout: number;
}

export class RobustParser {
  constructor() {
    this.rawJson = '{"nested": {"brace": true}}';
    // Comment with { and } braces
    /* Block comment with {
       nested braces
    } */
    this.regex = /\\{\\d+\\}/;
  }

  calculate() {
    return 42;
  }
}

export const arrowHandler = async (evt) => {
  return evt.data;
};
`;
  const structure = LanguageRegistry.parseStructure('src/robust.ts', codeWithEdgeCases);
  assert.equal(structure.language, 'typescript');
  assert.ok(structure.symbols.some((s) => s.name === 'UserConfig' && s.kind === 'interface'));
  const parserClass = structure.symbols.find((s) => s.name === 'RobustParser');
  assert.ok(parserClass);
  // Ensure the class did NOT get truncated prematurely due to strings or comments with braces!
  const calcMethod = structure.symbols.find((s) => s.name === 'RobustParser.calculate');
  assert.ok(calcMethod, 'RobustParser.calculate must be recognized inside RobustParser despite string braces');
  assert.ok(structure.symbols.some((s) => s.name === 'arrowHandler' && s.kind === 'function'));
});

test('LanguageRegistry parses Swift structs, classes, and view body', () => {
  const swiftCode = `import SwiftUI
import Foundation

struct MyView: View {
    @State private var count = 0

    var body: some View {
        Text("Count: \\(count)")
    }

    func increment() {
        count += 1
    }
}
`;
  const structure = LanguageRegistry.parseStructure('App/MyView.swift', swiftCode);
  assert.equal(structure.language, 'swift');
  assert.ok(structure.symbols.some((s) => s.name === 'MyView' && s.kind === 'struct'));
  assert.ok(structure.symbols.some((s) => s.name === 'MyView.body' && s.kind === 'method'));
  assert.ok(structure.symbols.some((s) => s.name === 'MyView.increment' && s.kind === 'method'));
});

test('CodeTools.outline produces clean Markdown', () => {
  const outline = CodeTools.outline('src/engine.js', JS_CODE);
  assert.ok(outline.markdown.includes('# Outline: `src/engine.js`'));
  assert.ok(outline.markdown.includes('ServiceEngine'));
  assert.ok(outline.markdown.includes('helperFunction'));
});

test('CodeTools.read surgical extraction', () => {
  // 1. Read by symbol
  const methodRead = CodeTools.read('src/engine.js', JS_CODE, { symbol: 'ServiceEngine.start' });
  assert.equal(methodRead.symbol, 'ServiceEngine.start');
  assert.ok(methodRead.code.includes('console.log(\'Starting \' + this.name);'));

  // 2. Read by line range
  const rangeRead = CodeTools.read('src/engine.js', JS_CODE, { startLine: 1, endLine: 3 });
  assert.ok(rangeRead.code.includes('import fs from \'node:fs\';'));

  // 3. String selector
  const strRead = CodeTools.read('src/engine.js', JS_CODE, 'file-helperFunction');
  assert.ok(strRead.code.includes('return val * 2;'));

  // 4. Default rejection of full file read without flag
  assert.throws(
    () => CodeTools.read('src/engine.js', JS_CODE, {}),
    /Selector must specify symbol or line range/
  );
});

test('CodeTools.edit surgical modification and re-anchoring', () => {
  const target = 'return val * 2;';
  const replacement = 'return val * 10;';

  const editResult = CodeTools.edit('src/engine.js', JS_CODE, {
    targetContent: target,
    replacementContent: replacement,
  });

  assert.ok(editResult.newContent.includes('return val * 10;'));
  assert.ok(!editResult.newContent.includes('return val * 2;'));
  assert.ok(editResult.updatedLocators.length > 0);

  // Symbol re-anchoring verified
  const fnLocator = editResult.updatedLocators.find((l) => l.symbol === 'helperFunction');
  assert.ok(fnLocator);
});

test('CoverageChecker identifies gaps and covered files', () => {
  const files = ['src/a.js', 'src/b.js', 'src/c.js'];
  const blocks = [
    {
      id: 'block-1',
      artifactRefs: [{ path: 'src/a.js' }, { path: 'src/b.js' }],
    },
  ];

  const report = CoverageChecker.checkCoverage(files, blocks);
  assert.equal(report.totalFiles, 3);
  assert.equal(report.coveredFiles, 2);
  assert.equal(report.uncoveredFiles, 1);
  assert.equal(report.isFullyCovered, false);
  assert.deepEqual(report.uncoveredList, ['src/c.js']);
  assert.equal(report.gaps.length, 1);
});

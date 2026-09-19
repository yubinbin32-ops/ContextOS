import test from 'node:test';
import assert from 'node:assert/strict';
import { LanguageRegistry, CodeTools, CoverageChecker, TreeSitterParser, normalizeCallee } from '../src/index.mjs';

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

test('LanguageRegistry parses Go structs and methods', () => {
  const goCode = `package main

import (
  "fmt"
  "strings"
)

type Server struct {
  Host string
  Port int
}

func (s *Server) Start() error {
  fmt.Println("starting")
  return nil
}

func CalculateSum(a, b int) int {
  return a + b
}
`;
  const structure = LanguageRegistry.parseStructure('main.go', goCode);
  assert.equal(structure.language, 'go');
  assert.ok(structure.symbols.some((s) => s.name === 'Server' && s.kind === 'struct'));
  assert.ok(structure.symbols.some((s) => s.name === 'Server.Start' && s.kind === 'method'));
  assert.ok(structure.symbols.some((s) => s.name === 'CalculateSum' && s.kind === 'function'));
});

test('LanguageRegistry parses Rust structs, traits, and impl methods', () => {
  const rustCode = `use std::collections::HashMap;

pub trait Worker<'a> {
  fn work(&'a self) -> &'a str;
}

pub struct Engine<'a> {
  id: u32,
  tag: &'a str,
}

struct Point(f64, f64);

impl<'a> Engine<'a> {
  pub fn new(id: u32, tag: &'a str) -> Self {
    Engine { id, tag }
  }

  pub(crate) const unsafe fn process<'a, T: AsRef<str>>(&'a self, x: T) -> &'a str {
    self.tag
  }
}
`;
  const structure = LanguageRegistry.parseStructure('src/lib.rs', rustCode);
  assert.equal(structure.language, 'rust');
  assert.ok(structure.symbols.some((s) => s.name === 'Worker' && s.kind === 'trait'));

  const workFn = structure.symbols.find((s) => s.name === 'work');
  assert.ok(workFn, 'work function must be found');
  assert.equal(workFn.startLine, 4);
  assert.equal(workFn.endLine, 4, 'work function without body must terminate at line 4');

  const pointStruct = structure.symbols.find((s) => s.name === 'Point');
  assert.ok(pointStruct, 'Point tuple struct must be found');
  assert.equal(pointStruct.startLine, 12);
  assert.equal(pointStruct.endLine, 12, 'tuple struct must terminate at line 12');

  assert.ok(structure.symbols.some((s) => s.name === 'Engine' && s.kind === 'struct'));
  assert.ok(structure.symbols.some((s) => s.name === 'Engine.new' && s.kind === 'method'));
  assert.ok(structure.symbols.some((s) => s.name === 'Engine.process' && s.kind === 'method'));
});

test('LanguageRegistry parses Java classes, interfaces, and methods', () => {
  const javaCode = `package com.example.service;

import java.util.List;
import java.io.File;

public class OrderService {
  private String orderId;

  public OrderService(String orderId) {
    this.orderId = orderId;
  }

  public void processOrder() {
    System.out.println("Processing " + orderId);
  }
}
`;
  const structure = LanguageRegistry.parseStructure('OrderService.java', javaCode);
  assert.equal(structure.language, 'java');
  assert.equal(structure.imports.length, 2);
  assert.ok(structure.symbols.some((s) => s.name === 'OrderService' && s.kind === 'class'));
  assert.ok(structure.symbols.some((s) => s.name === 'OrderService.processOrder' && s.kind === 'method'));
});

test('LanguageRegistry parses Kotlin classes and functions', () => {
  const ktCode = `package com.example.app

import kotlinx.coroutines.flow.Flow

class UserRepository(private val api: ApiClient) {
  fun fetchUser(id: String): User {
    return api.get(id)
  }
}

fun formatUserName(user: User): String {
  return user.name.trim()
}
`;
  const structure = LanguageRegistry.parseStructure('UserRepository.kt', ktCode);
  assert.equal(structure.language, 'kotlin');
  assert.ok(structure.symbols.some((s) => s.name === 'UserRepository' && s.kind === 'class'));
  assert.ok(structure.symbols.some((s) => s.name === 'UserRepository.fetchUser' && s.kind === 'method'));
  assert.ok(structure.symbols.some((s) => s.name === 'formatUserName' && s.kind === 'function'));
});

test('LanguageRegistry parses C++ classes, methods, and functions', () => {
  const cppCode = `#include <iostream>
#include <vector>

class Matrix {
public:
  void compute() {
    std::cout << "compute" << std::endl;
  }
};

void runPipeline() {
  Matrix m;
  m.compute();
}
`;
  const structure = LanguageRegistry.parseStructure('Matrix.cpp', cppCode);
  assert.equal(structure.language, 'cpp');
  assert.equal(structure.imports.length, 2);
  assert.ok(structure.symbols.some((s) => s.name === 'Matrix' && (s.kind === 'class' || s.kind === 'struct')));
  assert.ok(structure.symbols.some((s) => s.name === 'Matrix::compute' && s.kind === 'method'));
  assert.ok(structure.symbols.some((s) => s.name === 'runPipeline' && s.kind === 'function'));
});

test('LanguageRegistry parses C# classes and methods', () => {
  const csCode = `using System;
using System.Threading.Tasks;

namespace MyApp {
  public class AccountManager {
    public async Task<bool> ValidateUser(string username) {
      return await Task.FromResult(true);
    }
  }
}
`;
  const structure = LanguageRegistry.parseStructure('AccountManager.cs', csCode);
  assert.equal(structure.language, 'csharp');
  assert.ok(structure.symbols.some((s) => s.name === 'AccountManager' && s.kind === 'class'));
  assert.ok(structure.symbols.some((s) => s.name === 'AccountManager.ValidateUser' && s.kind === 'method'));
});

test('LanguageRegistry parses PHP classes and methods', () => {
  const phpCode = `<?php
namespace App\\Http;

use App\\Models\\User;

class AuthController {
  public function login($request) {
    return response()->json(['token' => 'xyz']);
  }
}

function verifySignature($token) {
  return true;
}
`;
  const structure = LanguageRegistry.parseStructure('AuthController.php', phpCode);
  assert.equal(structure.language, 'php');
  assert.ok(structure.symbols.some((s) => s.name === 'AuthController' && s.kind === 'class'));
  assert.ok(structure.symbols.some((s) => s.name === 'AuthController::login' && s.kind === 'method'));
  assert.ok(structure.symbols.some((s) => s.name === 'verifySignature' && s.kind === 'function'));
});

test('LanguageRegistry parses Ruby classes and methods', () => {
  const rbCode = `require 'json'
require_relative 'helper'

class PaymentGateway
  def process_payment(amount)
    puts "Charging #{amount}"
  end
end

def format_currency(val)
  "$#{val}"
end
`;
  const structure = LanguageRegistry.parseStructure('gateway.rb', rbCode);
  assert.equal(structure.language, 'ruby');
  assert.equal(structure.imports.length, 2);
  assert.ok(structure.symbols.some((s) => s.name === 'PaymentGateway' && s.kind === 'class'));
  assert.ok(structure.symbols.some((s) => s.name === 'PaymentGateway#process_payment' && s.kind === 'method'));
  assert.ok(structure.symbols.some((s) => s.name === 'format_currency' && s.kind === 'function'));
});

test('LanguageRegistry handles exact filenames and shebang sniffing like Zed/Cursor', () => {
  // 1. Exact filename (Gemfile -> Ruby)
  const gemfile = `source 'https://rubygems.org'
gem 'rails', '~> 7.0'
`;
  const gemStructure = LanguageRegistry.parseStructure('Gemfile', gemfile);
  assert.equal(gemStructure.language, 'ruby');

  // 2. Shebang sniffing for extensionless script (#!/usr/bin/env python3)
  const pythonScript = `#!/usr/bin/env python3
def main():
    print("hello from script")
`;
  const scriptStructure = LanguageRegistry.parseStructure('bin/run-task', pythonScript);
  assert.equal(scriptStructure.language, 'python');
  assert.ok(scriptStructure.symbols.some((s) => s.name === 'main'));
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

  // 4. Read by startLine only
  const startOnlyRead = CodeTools.read('src/engine.js', JS_CODE, { startLine: 20 });
  assert.ok(startOnlyRead.code.includes('export function helperFunction'));

  // 5. Default rejection of full file read without flag
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
    startLine: 20,
  });

  assert.ok(editResult.newContent.includes('return val * 10;'));
  assert.ok(!editResult.newContent.includes('return val * 2;'));
  assert.ok(editResult.updatedLocators.length > 0);

  // Symbol re-anchoring verified
  const fnLocator = editResult.updatedLocators.find((l) => l.symbol === 'helperFunction');
  assert.ok(fnLocator);

  // Verify regex special tokens ($1, $&, $$) are not expanded
  const placeholderTarget = 'val * 10;';
  const placeholderReplacement = '$1 and $& and $$;';
  const placeholderResult = CodeTools.edit('src/engine.js', editResult.newContent, {
    targetContent: placeholderTarget,
    replacementContent: placeholderReplacement,
  });
  assert.ok(placeholderResult.newContent.includes('$1 and $& and $$;'));
});

test('CoverageChecker identifies gaps and covered files', () => {
  const files = ['src/a.js', 'src/b.js', 'src/c.js'];
  const blocks = [
    {
      id: 'block-1',
      artifactRefs: [{ path: 'src/a.js', hash: 'hash-a' }, { path: 'src/b.js', hash: 'hash-b' }],
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

test('CoverageChecker resolves directory tree anchors without enumerating files', () => {
  const files = ['node_modules/runtime/index.js', 'resources/icon.png', 'src/app.js'];
  const blocks = [
    {
      id: 'block-dependencies',
      artifactRefs: [{
        path: 'node_modules',
        anchorKind: 'tree',
        hashMode: 'manifest',
        manifest: 'package-lock.json',
        hash: 'lock-hash',
      }],
    },
    {
      id: 'block-resources',
      artifactRefs: [{
        path: 'resources',
        anchorKind: 'tree',
        hashMode: 'content',
        hash: 'tree-hash',
      }],
    },
  ];

  const report = CoverageChecker.checkCoverage(files, blocks);
  assert.equal(report.coveredFiles, 2);
  assert.deepEqual(report.uncoveredList, ['src/app.js']);
});

test('TreeSitterParser extracts true AST symbols across target languages', () => {
  // 1. Rust AST
  const rustCode = `
pub trait Service<'a> {
  fn serve(&'a self) -> bool;
}
pub struct AppEngine {
  workers: u32,
}
impl AppEngine {
  pub fn run(&self) -> bool {
    true
  }
}
`;
  const rustRes = TreeSitterParser.parse('rust', rustCode, rustCode.split('\n'));
  assert.ok(rustRes);
  assert.ok(rustRes.symbols.some((s) => s.name === 'Service' && s.kind === 'trait'));
  assert.ok(rustRes.symbols.some((s) => s.name === 'serve' && s.kind === 'function'));
  assert.ok(rustRes.symbols.some((s) => s.name === 'AppEngine' && s.kind === 'struct'));
  assert.ok(rustRes.symbols.some((s) => s.name === 'AppEngine.run' && s.kind === 'method'));

  // 2. Go AST
  const goCode = `
package worker
type JobPool struct {
  Size int
}
func (jp *JobPool) Dispatch() error {
  return nil
}
`;
  const goRes = TreeSitterParser.parse('go', goCode, goCode.split('\n'));
  assert.ok(goRes);
  assert.ok(goRes.symbols.some((s) => s.name === 'JobPool' && s.kind === 'struct'));
  assert.ok(goRes.symbols.some((s) => s.name === 'JobPool.Dispatch' && s.kind === 'method'));

  // 3. Python AST
  const pyCode = `
class NeuralNet:
    def __init__(self, layers):
        self.layers = layers
    async def forward(self, x):
        return x
`;
  const pyRes = TreeSitterParser.parse('python', pyCode, pyCode.split('\n'));
  assert.ok(pyRes);
  assert.ok(pyRes.symbols.some((s) => s.name === 'NeuralNet' && s.kind === 'class'));
  assert.ok(pyRes.symbols.some((s) => s.name === 'NeuralNet.forward' && s.kind === 'method'));
});

test('LanguageRegistry robust fallback when language wasm is missing or unsupported', () => {
  // Plain text / unsupported extension
  const textContent = 'Simple plain text without grammar.\nLine 2.\n';
  const textStructure = LanguageRegistry.parseStructure('README.txt', textContent);
  assert.equal(textStructure.language, 'text');
  assert.equal(textStructure.capability, 'L1');
  assert.equal(textStructure.symbols.length, 1);
  assert.equal(textStructure.symbols[0].kind, 'file');

  // Verify non-existent language does not crash TreeSitterParser
  const invalidRes = TreeSitterParser.parse('nonexistent_lang_xyz', 'hello', ['hello']);
  assert.equal(invalidRes, null);
  assert.equal(TreeSitterParser.isLanguageSupported('nonexistent_lang_xyz'), false);
});

test('TreeSitterParser handles advanced language features across all target grammars', () => {
  // 1. Python decorated functions and methods
  const pyAdvanced = `
@app.route("/metrics")
@login_required
def get_metrics():
    return {}

class UserProfile:
    @property
    def display_name(self):
        return self._name

    @classmethod
    def from_dict(cls, data):
        return cls()
`;
  const pyRes = TreeSitterParser.parse('python', pyAdvanced, pyAdvanced.split('\n'));
  assert.ok(pyRes.symbols.some((s) => s.name === 'get_metrics' && s.kind === 'function'));
  assert.ok(pyRes.symbols.some((s) => s.name === 'UserProfile' && s.kind === 'class'));
  assert.ok(pyRes.symbols.some((s) => s.name === 'UserProfile.display_name' && s.kind === 'method'));
  assert.ok(pyRes.symbols.some((s) => s.name === 'UserProfile.from_dict' && s.kind === 'method'));

  // 2. C++ namespaces, templates, and clean pointer return names
  const cppAdvanced = `
namespace compute::math {
  template <typename T>
  class TensorEngine {
    void scale();
  };
}
char* format_buffer(int size) { return nullptr; }
`;
  const cppRes = TreeSitterParser.parse('cpp', cppAdvanced, cppAdvanced.split('\n'));
  assert.ok(cppRes.symbols.some((s) => s.name === 'TensorEngine' && s.kind === 'class'));
  assert.ok(cppRes.symbols.some((s) => s.name === 'TensorEngine::scale' && s.kind === 'method'));
  assert.ok(cppRes.symbols.some((s) => s.name === 'format_buffer' && s.kind === 'function'));

  // 3. C typedef struct
  const cCode = `
typedef struct GeometryPoint {
  double x;
  double y;
} GeoPoint;
`;
  const cRes = TreeSitterParser.parse('c', cCode, cCode.split('\n'));
  assert.ok(cRes.symbols.some((s) => (s.name === 'GeoPoint' || s.name === 'GeometryPoint') && s.kind === 'struct'));

  // 4. Swift protocols and structs with public/private modifiers
  const swiftAdvanced = `
protocol DataRepository {
  func fetchAll() -> [String]
}
public struct AppTheme {
  let primaryColor: String
}
`;
  const swiftRes = TreeSitterParser.parse('swift', swiftAdvanced, swiftAdvanced.split('\n'));
  const proto = swiftRes.symbols.find((s) => s.name === 'DataRepository');
  assert.ok(proto);
  assert.equal(proto.kind, 'interface');
  assert.ok(swiftRes.symbols.some((s) => s.name === 'DataRepository.fetchAll' && s.kind === 'method'));
  const strct = swiftRes.symbols.find((s) => s.name === 'AppTheme');
  assert.ok(strct);
  assert.equal(strct.kind, 'struct');

  // 5. Go generics receiver and interface methods
  const goAdvanced = `
package server
type HttpHandler interface {
  HandleRequest(req string) bool
}
func (s *ClusterManager[T]) Rebalance() error {
  return nil
}
`;
  const goRes = TreeSitterParser.parse('go', goAdvanced, goAdvanced.split('\n'));
  assert.ok(goRes.symbols.some((s) => s.name === 'HttpHandler' && s.kind === 'interface'));
  assert.ok(goRes.symbols.some((s) => s.name === 'HttpHandler.HandleRequest' && s.kind === 'method'));
  assert.ok(goRes.symbols.some((s) => s.name === 'ClusterManager.Rebalance' && s.kind === 'method'));

  // 6. Rust mod items
  const rustAdvanced = `
mod networking {
  pub struct Socket {
    fd: i32,
  }
  impl Socket {
    pub fn connect(&self) -> bool { true }
  }
}
`;
  const rustRes = TreeSitterParser.parse('rust', rustAdvanced, rustAdvanced.split('\n'));
  assert.ok(rustRes.symbols.some((s) => s.name === 'networking' && s.kind === 'module'));
  assert.ok(rustRes.symbols.some((s) => s.name === 'Socket' && s.kind === 'struct'));
  assert.ok(rustRes.symbols.some((s) => s.name === 'Socket.connect' && s.kind === 'method'));

  // 7. Ruby nested modules and classes
  const rbAdvanced = `
module Analytics
  class Tracker
    def track_event(name)
      puts name
    end
  end
end
`;
  const rbRes = TreeSitterParser.parse('ruby', rbAdvanced, rbAdvanced.split('\n'));
  assert.ok(rbRes.symbols.some((s) => s.name === 'Analytics' && s.kind === 'module'));
  assert.ok(rbRes.symbols.some((s) => s.name === 'Analytics::Tracker' && s.kind === 'class'));
  assert.ok(rbRes.symbols.some((s) => s.name === 'Analytics::Tracker#track_event' && s.kind === 'method'));

  // 8. Java, C#, PHP enums
  const csEnum = `public enum TaskStatus { Draft, Active, Done }`;
  const csRes = TreeSitterParser.parse('csharp', csEnum, csEnum.split('\n'));
  assert.ok(csRes.symbols.some((s) => s.name === 'TaskStatus' && s.kind === 'enum'));

  const javaEnum = `public enum LogLevel { DEBUG, INFO, ERROR }`;
  const javaRes = TreeSitterParser.parse('java', javaEnum, javaEnum.split('\n'));
  assert.ok(javaRes.symbols.some((s) => s.name === 'LogLevel' && s.kind === 'enum'));

  const phpEnum = `<?php\nenum PaymentState: string { case PAID = 'paid'; }`;
  const phpRes = TreeSitterParser.parse('php', phpEnum, phpEnum.split('\n'));
  assert.ok(phpRes.symbols.some((s) => s.name === 'PaymentState' && s.kind === 'enum'));
});

test('normalizeCallee handles generics, receivers, chaining, and rejects closures', () => {
  // Generic stripping
  assert.equal(normalizeCallee('parse<T>'), 'parse');
  assert.equal(normalizeCallee('parse::<Config>'), 'parse');
  assert.equal(normalizeCallee('map::<K, V>'), 'map');
  assert.equal(normalizeCallee('Container<T>::get'), 'Container::get');

  // Receiver stripping
  assert.equal(normalizeCallee('this.compute'), 'compute');
  assert.equal(normalizeCallee('self.dispatch'), 'dispatch');
  assert.equal(normalizeCallee('$this->execute'), 'execute');
  assert.equal(normalizeCallee('$this.run'), 'run');
  assert.equal(normalizeCallee('this->action'), 'action');

  // Arrow notation normalization
  assert.equal(normalizeCallee('db->save'), 'db.save');

  // Chained calls parentheses stripping
  assert.equal(normalizeCallee('builder().build'), 'build');
  assert.equal(normalizeCallee('client.get().then'), 'then');

  // Multiline & closure rejections
  assert.equal(normalizeCallee('func() {\n  foo()\n}'), null);
  assert.equal(normalizeCallee('() => { bar(); }'), null);
  assert.equal(normalizeCallee('{ val: 1 }'), null);
  assert.equal(normalizeCallee('function'), null);
  assert.equal(normalizeCallee('func'), null);
  assert.equal(normalizeCallee('lambda'), null);
  assert.equal(normalizeCallee(''), null);
  assert.equal(normalizeCallee(null), null);
});

test('TreeSitterParser extracts 2-hop calls and isolates nested function scopes', () => {
  // JS with nested scopes and compound statements
  const jsSource = `
export function processOrder(order) {
  validateOrder(order);
  if (order.isValid) {
    calculateTaxes(order.total);
    saveOrder(order);
  }

  // Nested arrow function should NOT pollute processOrder calls
  const innerFormatter = (val) => {
    formatCurrency(val);
    return val;
  };

  // Nested function declaration should NOT pollute processOrder calls
  function localAudit() {
    writeAuditLog('audit');
  }

  notifyCustomer(order.id);
}
`;
  const jsRes = TreeSitterParser.parse('javascript', jsSource, jsSource.split('\n'));
  const procSym = jsRes.symbols.find((s) => s.name === 'processOrder');
  assert.ok(procSym);
  assert.ok(procSym.calls.includes('validateOrder'));
  assert.ok(procSym.calls.includes('calculateTaxes'));
  assert.ok(procSym.calls.includes('saveOrder'));
  assert.ok(procSym.calls.includes('notifyCustomer'));
  // Ensure inner calls are NOT in outer function's calls
  assert.equal(procSym.calls.includes('formatCurrency'), false);
  assert.equal(procSym.calls.includes('writeAuditLog'), false);

  // Go with struct methods, if blocks, and func_literal (IIFE)
  const goSource = `package service
type OrderService struct {}
func (s *OrderService) Execute() error {
  initContext()
  if true {
    checkPermissions()
  }
  go func() {
    backgroundTelemetry()
  }()
  finalize()
  return nil
}
`;
  const goRes = TreeSitterParser.parse('go', goSource, goSource.split('\n'));
  const execSym = goRes.symbols.find((s) => s.name === 'OrderService.Execute');
  assert.ok(execSym);
  assert.ok(execSym.calls.includes('initContext'));
  assert.ok(execSym.calls.includes('checkPermissions'));
  assert.ok(execSym.calls.includes('finalize'));
  // The anonymous func_literal must NOT leak into calls
  assert.equal(execSym.calls.includes('backgroundTelemetry'), false);
  assert.ok(!execSym.calls.some((c) => c.includes('func')));

  // Python class method with self receiver and helper call
  const pySource = `class Service:
    def execute(self):
        self.prepare()
        run_worker()
        self.cleanup()
`;
  const pyRes = TreeSitterParser.parse('python', pySource, pySource.split('\n'));
  const pySym = pyRes.symbols.find((s) => s.name === 'Service.execute');
  assert.ok(pySym);
  assert.deepEqual(pySym.calls, ['prepare', 'run_worker', 'cleanup']);

  // Rust impl with generics and receiver calls
  const rustSource = `impl Manager {
    pub fn start(&self) {
      self.init();
      parse::<Config>();
      spawn();
    }
}
`;
  const rustRes = TreeSitterParser.parse('rust', rustSource, rustSource.split('\n'));
  const rustSym = rustRes.symbols.find((s) => s.name === 'Manager.start');
  assert.ok(rustSym);
  assert.ok(rustSym.calls.includes('init'));
  assert.ok(rustSym.calls.includes('parse'));
  assert.ok(rustSym.calls.includes('spawn'));
});

test('CodeTools.outline formats 2-Hop calls and associates container methods correctly', () => {
  const pyCode = `class Controller:
    def handle(self):
        self.authenticate()
        process_request()
`;
  const pyOutline = CodeTools.outline('app/ctrl.py', pyCode);
  assert.ok(pyOutline.markdown.includes('- **class** `Controller`'));
  assert.ok(pyOutline.markdown.includes('- **method** `Controller.handle`'));
  assert.ok(pyOutline.markdown.includes('-> calls: [authenticate, process_request]'));

  // Go struct methods rendered under struct with calls
  const goCode = `package main
type Server struct {}
func (s *Server) Start() {
    bind()
    listen()
}
`;
  const goOutline = CodeTools.outline('server.go', goCode);
  assert.ok(goOutline.markdown.includes('- **struct** `Server`'));
  assert.ok(goOutline.markdown.includes('- **method** `Server.Start`'));
  assert.ok(goOutline.markdown.includes('-> calls: [bind, listen]'));

  // JS class methods and constructors are not duplicated
  const jsCode = `export class Engine {
  constructor() {
    this.setup();
  }
  start() {
    init();
  }
}
`;
  const jsOutline = CodeTools.outline('engine.js', jsCode);
  // Ensure 'constructor' only appears once under Engine
  const constructorMatches = (jsOutline.markdown.match(/constructor/g) || []).length;
  assert.equal(constructorMatches, 1);
  assert.ok(jsOutline.markdown.includes('-> calls: [setup]'));
  assert.ok(jsOutline.markdown.includes('-> calls: [init]'));

  // Go method declared BEFORE struct definition in file order
  const goOutOfOrderCode = `package main
func (s *Server) Start() {
    bind()
    listen()
}
type Server struct {}
`;
  const goOutOfOrderOutline = CodeTools.outline('server_order.go', goOutOfOrderCode);
  assert.ok(goOutOfOrderOutline.markdown.includes('- **struct** `Server`'));
  assert.ok(goOutOfOrderOutline.markdown.includes('  - **method** `Server.Start`'));
  assert.ok(goOutOfOrderOutline.markdown.includes('-> calls: [bind, listen]'));
  // Ensure Start is not rendered twice
  const startMatches = (goOutOfOrderOutline.markdown.match(/Server\.Start/g) || []).length;
  assert.equal(startMatches, 1);

  // Ruby method with receiver and nested block isolation
  const rubyCode = `def process
  self.db.save(record)
  [1, 2].each do |x|
    inner_worker(x)
  end
  notify()
end
`;
  const rubyRes = TreeSitterParser.parse('ruby', rubyCode, rubyCode.split('\n'));
  const procMethod = rubyRes.symbols.find((s) => s.name === 'process');
  assert.ok(procMethod);
  assert.ok(procMethod.calls.includes('db.save'));
  assert.ok(procMethod.calls.includes('notify'));
  // Bare 'self' must NOT be in calls
  assert.equal(procMethod.calls.includes('self'), false);
  // Nested do_block must NOT leak into process calls
  assert.equal(procMethod.calls.includes('inner_worker'), false);

  // Rust nested helper function isolation
  const rustNestedCode = `fn compute() {
    setup();
    fn local_helper() {
        nested_call();
    }
    teardown();
}
`;
  const rustNestedRes = TreeSitterParser.parse('rust', rustNestedCode, rustNestedCode.split('\n'));
  const compSym = rustNestedRes.symbols.find((s) => s.name === 'compute');
  assert.ok(compSym);
  assert.ok(compSym.calls.includes('setup'));
  assert.ok(compSym.calls.includes('teardown'));
  assert.equal(compSym.calls.includes('nested_call'), false);

  // JS nested class method isolation
  const jsNestedClassCode = `function runPipeline() {
    init();
    class LocalWorker {
      work() {
        doSecretWork();
      }
    }
    finish();
}
`;
  const jsNestedRes = TreeSitterParser.parse('javascript', jsNestedClassCode, jsNestedClassCode.split('\n'));
  const pipeSym = jsNestedRes.symbols.find((s) => s.name === 'runPipeline');
  assert.ok(pipeSym);
  assert.ok(pipeSym.calls.includes('init'));
  assert.ok(pipeSym.calls.includes('finish'));
  assert.equal(pipeSym.calls.includes('doSecretWork'), false);
});

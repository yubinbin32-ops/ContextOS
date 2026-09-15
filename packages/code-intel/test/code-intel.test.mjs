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

pub trait Worker {
  fn work(&self);
}

pub struct Engine {
  id: u32,
}

impl Engine {
  pub fn new(id: u32) -> Self {
    Engine { id }
  }
}
`;
  const structure = LanguageRegistry.parseStructure('src/lib.rs', rustCode);
  assert.equal(structure.language, 'rust');
  assert.ok(structure.symbols.some((s) => s.name === 'Worker' && s.kind === 'trait'));
  assert.ok(structure.symbols.some((s) => s.name === 'Engine' && s.kind === 'struct'));
  assert.ok(structure.symbols.some((s) => s.name === 'Engine.new' && s.kind === 'method'));
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

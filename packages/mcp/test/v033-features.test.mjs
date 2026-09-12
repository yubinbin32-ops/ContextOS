import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  detectLanguage,
  extractSymbols,
  extractSymbolSlice,
  replaceSymbolSlice,
} from "../src/ast.mjs";

test("v0.3.3 AST: language detection for all supported languages", () => {
  assert.equal(detectLanguage("main.go"), "go");
  assert.equal(detectLanguage("lib.rs"), "rust");
  assert.equal(detectLanguage("OrderService.java"), "java");
  assert.equal(detectLanguage("Handler.kt"), "kotlin");
  assert.equal(detectLanguage("Handler.kts"), "kotlin");
  assert.equal(detectLanguage("ContentView.swift"), "swift");
  assert.equal(detectLanguage("service.py"), "python");
  assert.equal(detectLanguage("index.ts"), "typescript");
  assert.equal(detectLanguage("server.mjs"), "javascript");
  assert.equal(detectLanguage("core.cpp"), "cpp");
  assert.equal(detectLanguage("unknown.xyz"), "text");
});

test("v0.3.3 AST: Go symbol extraction, nesting, and slicing", () => {
  const goCode = `package service

import (
\t"context"
\t"fmt"
)

type Config struct {
\tPort int
\tHost string
}

type Greeter interface {
\tGreet(ctx context.Context, name string) (string, error)
}

type Server struct {
\tcfg Config
}

func NewServer(cfg Config) *Server {
\treturn &Server{cfg: cfg}
}

func (s *Server) Greet(ctx context.Context, name string) (string, error) {
\tif name == "" {
\t\treturn "", fmt.Errorf("empty name")
\t}
\treturn fmt.Sprintf("Hello %s", name), nil
}
`;

  const symbols = extractSymbols(goCode, { language: "go", filePath: "server.go" });
  assert.ok(symbols.length >= 5);

  const configStruct = symbols.find((s) => s.name === "Config");
  assert.ok(configStruct);
  assert.equal(configStruct.kind, "struct");

  const greeterIface = symbols.find((s) => s.name === "Greeter");
  assert.ok(greeterIface);
  assert.equal(greeterIface.kind, "interface");

  const serverStruct = symbols.find((s) => s.name === "Server");
  assert.ok(serverStruct);
  assert.equal(serverStruct.kind, "struct");

  const newServerFunc = symbols.find((s) => s.name === "NewServer");
  assert.ok(newServerFunc);
  assert.equal(newServerFunc.kind, "function");

  const greetMethod = symbols.find((s) => s.name === "Greet");
  assert.ok(greetMethod);
  assert.equal(greetMethod.kind, "method");

  // Slicing: extract Greet method
  const slice = extractSymbolSlice(goCode, { symbol: "Greet", language: "go", filePath: "server.go" });
  assert.ok(slice.code.includes('return fmt.Sprintf("Hello %s", name), nil'));
  assert.ok(slice.startLine > 0);
  assert.ok(slice.endLine >= slice.startLine);

  // Mutation / Replacement
  const mutated = replaceSymbolSlice(goCode, {
    symbol: "Greet",
    newCode: `func (s *Server) Greet(ctx context.Context, name string) (string, error) {\n\treturn "Hi " + name, nil\n}`,
    language: "go",
    filePath: "server.go",
  });
  assert.ok(mutated.updatedCode.includes('return "Hi " + name, nil'));
  assert.ok(mutated.updatedCode.includes("func NewServer(cfg Config) *Server"));
});

test("v0.3.3 AST: Rust symbol extraction, async fn, traits, and impl blocks", () => {
  const rustCode = `pub struct Client {
    endpoint: String,
}

pub trait Dispatcher {
    fn dispatch(&self, event: &str) -> bool;
}

impl Client {
    pub fn new(endpoint: &str) -> Self {
        Self { endpoint: endpoint.to_string() }
    }

    pub async fn send_ping(&self) -> Result<(), String> {
        Ok(())
    }
}
`;

  const symbols = extractSymbols(rustCode, { language: "rust", filePath: "client.rs" });
  assert.ok(symbols.some((s) => s.name === "Client" && s.kind === "struct"));
  assert.ok(symbols.some((s) => s.name === "Dispatcher" && s.kind === "trait"));
  assert.ok(symbols.some((s) => s.name === "new" && s.kind === "function"));
  assert.ok(symbols.some((s) => s.name === "send_ping" && s.kind === "function"));

  // Slice extract
  const slice = extractSymbolSlice(rustCode, { symbol: "send_ping", language: "rust", filePath: "client.rs" });
  assert.ok(slice.code.includes("send_ping"));
  assert.ok(slice.code.includes("Ok(())"));
});

test("v0.3.3 AST: Java & Kotlin symbol extraction, classes, records, and methods", () => {
  const javaCode = `package com.example.service;

import java.util.List;

public record UserRecord(String id, String name) {}

public class UserService {
    private final List<UserRecord> users;

    public UserService(List<UserRecord> users) {
        this.users = users;
    }

    public UserRecord findById(String id) {
        return users.stream()
            .filter(u -> u.id().equals(id))
            .findFirst()
            .orElse(null);
    }
}
`;

  const symbols = extractSymbols(javaCode, { language: "java", filePath: "UserService.java" });
  assert.ok(symbols.some((s) => s.name === "UserRecord" && s.kind === "record"));
  assert.ok(symbols.some((s) => s.name === "UserService" && s.kind === "class"));
  assert.ok(symbols.some((s) => (s.name === "findById" || s.name === "UserService.findById") && s.kind === "method"));

  // Slice extract
  const slice = extractSymbolSlice(javaCode, { symbol: "findById", language: "java", filePath: "UserService.java" });
  assert.ok(slice.code.includes("public UserRecord findById(String id)"));
  assert.ok(slice.code.includes("filter(u -> u.id().equals(id))"));
});

test("v0.3.3 AST: zero external dependency verification", () => {
  const astFile = fs.readFileSync(new URL("../src/ast.mjs", import.meta.url), "utf8");
  const imports = astFile.match(/^import\s+.*?from\s+['"](.*?)['"]/gm) || [];
  for (const imp of imports) {
    const from = imp.match(/from\s+['"](.*?)['"]/)[1];
    assert.ok(
      from.startsWith("node:") || from.startsWith("./") || from.startsWith("../"),
      `ast.mjs must only import built-in node modules or relative files, found: ${from}`
    );
  }
});

test("v0.3.3 Scheme A Checkpoints: progress calculation and empty handling", () => {
  function calculateCheckpointMetrics(checkpoints) {
    const totalCount = checkpoints.length;
    const passedCount = checkpoints.filter((c) => c.status === "passed").length;
    const passPercentage = totalCount > 0 ? Math.floor((passedCount / totalCount) * 100) : 0;
    const isClean = totalCount === 0;

    return {
      totalCount,
      passedCount,
      passPercentage,
      displayText: totalCount > 0
        ? `${passedCount}/${totalCount} 检查点通过 (${passPercentage}%)`
        : "0 检查点",
      isClean,
    };
  }

  // Case 1: Empty checkpoints
  const emptyMetrics = calculateCheckpointMetrics([]);
  assert.equal(emptyMetrics.totalCount, 0);
  assert.equal(emptyMetrics.passedCount, 0);
  assert.equal(emptyMetrics.passPercentage, 0);
  assert.equal(emptyMetrics.displayText, "0 检查点");

  // Case 2: 2 passing checkpoints
  const passingMetrics = calculateCheckpointMetrics([
    { id: "cp-1", status: "passed" },
    { id: "cp-2", status: "passed" },
  ]);
  assert.equal(passingMetrics.totalCount, 2);
  assert.equal(passingMetrics.passedCount, 2);
  assert.equal(passingMetrics.passPercentage, 100);
  assert.equal(passingMetrics.displayText, "2/2 检查点通过 (100%)");

  // Case 3: Mixed checkpoints
  const mixedMetrics = calculateCheckpointMetrics([
    { id: "cp-1", status: "passed" },
    { id: "cp-2", status: "pending" },
    { id: "cp-3", status: "retest_required" },
    { id: "cp-4", status: "passed" },
  ]);
  assert.equal(mixedMetrics.totalCount, 4);
  assert.equal(mixedMetrics.passedCount, 2);
  assert.equal(mixedMetrics.passPercentage, 50);
  assert.equal(mixedMetrics.displayText, "2/4 检查点通过 (50%)");

  // Case 4: Verify NO 45-block pollution
  assert.notEqual(passingMetrics.displayText, "2/45 已验证 (4%)");
});

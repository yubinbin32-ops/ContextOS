import test from "node:test";
import assert from "node:assert/strict";
import { extractSymbols, extractSymbolSlice, buildChainCodeStream, replaceSymbolSlice, detectLanguage } from "../src/ast.mjs";

test("ast: detectLanguage detects extensions correctly", () => {
  assert.equal(detectLanguage("src/service.ts"), "typescript");
  assert.equal(detectLanguage("src/components/button.tsx"), "typescript");
  assert.equal(detectLanguage("main.swift"), "swift");
  assert.equal(detectLanguage("handler.py"), "python");
  assert.equal(detectLanguage("unknown.xyz"), "text");
});

test("ast: extractSymbols from TypeScript handles functions, classes, interfaces and types", () => {
  const tsCode = `
export interface UserPayload {
  id: string;
  email: string;
}

export type TokenResult = string | null;

export class AuthService {
  async login(payload: UserPayload): Promise<TokenResult> {
    return "token_123";
  }
}

export async function verifySession(token: string) {
  return true;
}
`;

  const symbols = extractSymbols(tsCode, { language: "typescript" });
  assert.equal(symbols.length, 4);

  const iface = symbols.find((s) => s.name === "UserPayload");
  assert.ok(iface);
  assert.equal(iface.kind, "interface");

  const typeAlias = symbols.find((s) => s.name === "TokenResult");
  assert.ok(typeAlias);
  assert.equal(typeAlias.kind, "type");

  const cls = symbols.find((s) => s.name === "AuthService");
  assert.ok(cls);
  assert.equal(cls.kind, "class");

  const fn = symbols.find((s) => s.name === "verifySession");
  assert.ok(fn);
  assert.equal(fn.kind, "function");
  assert.ok(fn.startLine > 0);
  assert.ok(fn.endLine >= fn.startLine);
});

test("ast: extractSymbols from Swift and Python handles methods and classes", () => {
  const swiftCode = `
public struct UserProfile {
    let id: String
}

final class PaymentProcessor {
    func processPayment(amount: Double) -> Bool {
        return true
    }
}
`;
  const swiftSymbols = extractSymbols(swiftCode, { language: "swift" });
  assert.ok(swiftSymbols.find((s) => s.name === "UserProfile" && s.kind === "struct"));
  assert.ok(swiftSymbols.find((s) => s.name === "PaymentProcessor" && s.kind === "class"));
  assert.ok(swiftSymbols.find((s) => s.name === "processPayment" && s.kind === "function"));

  const pyCode = `
class InventoryService:
    def check_stock(self, sku_id: str) -> int:
        return 42
`;
  const pySymbols = extractSymbols(pyCode, { language: "python" });
  assert.ok(pySymbols.find((s) => s.name === "InventoryService" && s.kind === "class"));
  assert.ok(pySymbols.find((s) => s.name === "check_stock" && s.kind === "function"));
});

test("ast: extractSymbolSlice extracts targeted slice with collapse", () => {
  const code = Array.from({ length: 100 }, (_, i) => `const line_${i + 1} = ${i + 1};`).join("\n");
  const slice = extractSymbolSlice(code, { startLine: 10, endLine: 80, maxLines: 20 });

  assert.equal(slice.startLine, 10);
  assert.equal(slice.endLine, 80);
  assert.equal(slice.totalLines, 71);
  assert.ok(slice.code.includes("const line_10 = 10;"));
  assert.ok(slice.code.includes("collapsed"));
});

test("ast: buildChainCodeStream produces unified code stream across materialized and virtual nodes", () => {
  const stream = buildChainCodeStream([
    {
      blockId: "auth-service",
      title: "用户鉴权",
      filePath: "src/auth.ts",
      symbol: "login",
      code: "export async function login() { return 'ok'; }",
    },
    {
      blockId: "risk-evaluator",
      title: "待规划风控评估",
      contract: "evaluateRisk(userId, amount) -> RiskLevel",
    },
  ]);

  assert.ok(stream.includes("[Node: auth-service]"));
  assert.ok(stream.includes("export async function login"));
  assert.ok(stream.includes("[Node: risk-evaluator]"));
  assert.ok(stream.includes("Planned Contract"));
  assert.ok(stream.includes("evaluateRisk"));
});

test("ast: replaceSymbolSlice replaces targeted function and preserves surrounding code", () => {
  const original = `import { foo } from "./foo.js";

export function calculateTax(amount) {
  return amount * 0.1;
}

export function processOrder(orderId) {
  return "order_" + orderId;
}
`;

  const newTaxFn = `export function calculateTax(amount) {
  // Upgraded tax logic
  return amount * 0.15;
}`;

  const { updatedCode, replacedLines } = replaceSymbolSlice(original, {
    symbol: "calculateTax",
    newCode: newTaxFn,
    language: "javascript",
  });

  assert.ok(updatedCode.includes("Upgraded tax logic"));
  assert.ok(updatedCode.includes("amount * 0.15"));
  assert.ok(updatedCode.includes("processOrder(orderId)"));
  assert.ok(updatedCode.includes('import { foo } from "./foo.js";'));
  assert.equal(replacedLines.startLine, 3);
});

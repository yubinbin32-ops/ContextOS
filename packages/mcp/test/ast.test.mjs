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
  assert.equal(symbols.length, 5);

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
  assert.ok(symbols.find((s) => s.name === "login" && s.kind === "method"));
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

  const swiftSlice = extractSymbolSlice(swiftCode, {
    symbol: "processPayment",
    filePath: "main.swift",
    maxLines: 10,
  });
  assert.equal(swiftSlice.found, true);
  assert.ok(swiftSlice.signature.includes("processPayment"));
});

test("ast: file paths select the adapter and expose computed Swift properties", () => {
  const swiftCode = `
struct DetailView {
    var body: some View {
        Text("detail")
    }

    private func refresh() {
        print("refresh")
    }
}
`;
  const symbols = extractSymbols(swiftCode, { filePath: "DetailView.swift" });
  assert.ok(symbols.find((s) => s.name === "body" && s.kind === "property"));
  assert.equal(symbols.find((s) => s.name === "body")?.qualifiedName, "DetailView.body");
  assert.ok(symbols.find((s) => s.name === "refresh" && s.kind === "function"));
  const body = extractSymbolSlice(swiftCode, { symbol: "DetailView.body", filePath: "DetailView.swift" });
  assert.equal(body.found, true);
  assert.match(body.code, /Text\("detail"\)/);
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
  const nodes = [
    {
      blockId: "auth-service",
      title: "用户鉴权",
      filePath: "src/auth.ts",
      symbol: "login",
      code: "export async function login() { return 'ok'; }",
      signature: "export async function login()",
      sourceStatus: "anchored",
    },
    {
      blockId: "risk-evaluator",
      title: "待规划风控评估",
      contract: "evaluateRisk(userId, amount) -> RiskLevel",
      sourceStatus: "virtual",
    },
    {
      blockId: "legacy-range",
      title: "旧行号绑定",
      filePath: "src/legacy.ts",
      startLine: 12,
      endLine: 40,
      sourceStatus: "line_only",
    },
  ];
  const stream = buildChainCodeStream(nodes);

  assert.ok(stream.includes("[Node: auth-service]"));
  assert.ok(stream.includes("Source status: anchored"));
  assert.ok(!stream.includes("return 'ok'"));
  assert.ok(stream.includes("[Node: risk-evaluator]"));
  assert.ok(stream.includes("Contract:"));
  assert.ok(stream.includes("evaluateRisk"));
  assert.ok(stream.includes("line-only binding"));

  assert.ok(!stream.includes("return 'ok'"));
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

test("ast: extractSymbols from Go, Rust, Java handles functions, structs and methods with 0 dependencies", () => {
  // 1. Go
  const goCode = `package main
type User struct {
    ID string
}
type Repository interface {
    Get(id string) (*User, error)
}
func NewUser(id string) *User {
    return &User{ID: id}
}
func (u *User) Save() error {
    return nil
}
`;
  const goSymbols = extractSymbols(goCode, { language: "go" });
  assert.equal(goSymbols.length, 4);
  assert.ok(goSymbols.find(s => s.name === "User" && s.kind === "struct"));
  assert.ok(goSymbols.find(s => s.name === "Repository" && s.kind === "interface"));
  assert.ok(goSymbols.find(s => s.name === "NewUser" && s.kind === "function"));
  assert.ok(goSymbols.find(s => s.name === "Save" && s.kind === "method"));

  // 2. Rust
  const rustCode = `pub struct Order {
    pub id: u64,
}
pub trait OrderService {
    fn process(&self);
}
pub async fn execute_order(order: Order) -> bool {
    true
}
`;
  const rustSymbols = extractSymbols(rustCode, { language: "rust" });
  assert.equal(rustSymbols.length, 4);
  assert.ok(rustSymbols.find(s => s.name === "Order" && s.kind === "struct"));
  assert.ok(rustSymbols.find(s => s.name === "OrderService" && s.kind === "trait"));
  assert.ok(rustSymbols.find(s => s.name === "process"));
  assert.ok(rustSymbols.find(s => s.name === "execute_order" && s.kind === "function"));

  // 3. Java
  const javaCode = `public class PaymentService {
    public static PaymentResult processPayment(PaymentRequest req) {
        return new PaymentResult();
    }
}
`;
  const javaSymbols = extractSymbols(javaCode, { language: "java" });
  assert.equal(javaSymbols.length, 2);
  assert.ok(javaSymbols.find(s => s.name === "PaymentService" && s.kind === "class"));
  assert.ok(javaSymbols.find(s => s.name === "processPayment" && s.kind === "method"));
});

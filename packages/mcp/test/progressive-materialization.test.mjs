import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ContextOSService } from "../src/service.mjs";

test("progressive materialization: virtual blueprint vs anchored code facades", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "contextos-test-materialization-"));
  const contextosDir = path.join(tmpDir, ".contextos");
  const srcDir = path.join(tmpDir, "src");
  await fs.mkdir(contextosDir, { recursive: true });
  await fs.mkdir(srcDir, { recursive: true });

  await fs.writeFile(
    path.join(contextosDir, "project.json"),
    JSON.stringify({
      schemaVersion: "2.0.0",
      id: "materialization-test",
      name: "Materialization Test",
      defaultLocale: "en",
      supportedLocales: ["en"],
    }),
  );

  // Write a real TS source file to test auto-resolution of symbol line numbers
  const tsCode = `
export class PaymentService {
  async processPayment(amount: number) {
    return { status: "success", txId: "tx_999" };
  }
}
`;
  await fs.writeFile(path.join(srcDir, "payment.ts"), tsCode);

  const service = new ContextOSService({ projectRoot: tmpDir, autoSync: true });

  // 1. Create a virtual (Ghost) block for a future feature and a solid block for payment
  service.mutate({
    reason: "Bootstrap virtual and implementing blocks",
    operations: [
      {
        action: "create_block",
        id: "future-risk",
        fields: {
          title: "风控引擎未来规划",
          kind: "service",
          architectureLayer: "domain",
          deliveryState: "planned",
          summary: "未来接入实时机器学习风控规则",
          contract: "evaluate(tx) -> RiskScore",
        },
      },
      {
        action: "create_block",
        id: "payment-service",
        fields: {
          title: "真实支付服务",
          kind: "service",
          architectureLayer: "application",
          deliveryState: "implementing",
          summary: "微信支付宝网关支付",
          contract: "processPayment(amount) -> Result",
        },
      },
      {
        action: "add_source_ref",
        id: "payment-service",
        fields: {
          path: "src/payment.ts:processPayment", // auto-resolution test
        },
      },
      {
        action: "create_chain",
        id: "checkout-chain",
        fields: {
          title: "收银链路",
          intent: "测试全链路",
        },
      },
      {
        action: "set_chain_path",
        id: "checkout-chain",
        expectedRevision: 1,
        fields: {
          nodeIds: ["payment-service", "future-risk"],
        },
      },
    ],
  });

  // 2. Verify contextForTask shows Ghost vs Solid
  const taskRes = service.contextForTask({ task: "修改支付服务与未来风控对接", maxChars: 4000 });
  assert.ok(taskRes.markdown.includes("Solid (Anchored)"));
  assert.ok(taskRes.markdown.includes("Ghost (Virtual Blueprint)"));
  assert.ok(taskRes.markdown.includes("src/payment.ts :: processPayment"));

  // 3. Verify chainCodeStream produces stream across solid (real code) and ghost (planned contract)
  const contractStreamRes = service.chainCodeStream({ chainId: "checkout-chain" });
  assert.equal(contractStreamRes.mode, "contract");
  assert.ok(contractStreamRes.codeStream.includes("processPayment"));
  assert.ok(!contractStreamRes.codeStream.includes('return { status: "success"'));
  assert.ok(contractStreamRes.codeStream.includes("evaluate(tx) -> RiskScore"));

  const streamRes = service.chainCodeStream({ chainId: "checkout-chain" });
  assert.equal(streamRes.nodes.length, 2);
  assert.ok(streamRes.codeStream.includes("processPayment"));
  assert.ok(streamRes.codeStream.includes("Contract:"));
  assert.ok(streamRes.codeStream.includes("evaluate(tx) -> RiskScore"));
  assert.ok(!streamRes.codeStream.includes('return { status: "success"'));
  assert.throws(
    () => service.chainCodeStream({ chainId: "checkout-chain", mode: "slice" }),
    /locator-only/,
  );

  const commandResult = service.runCommand({
    command: "printf 'OPENAI_API_KEY=sk-test-secret\\n%s\\n' \"$PWD/src/payment.ts\"",
    maxChars: 500,
  });
  assert.equal(commandResult.success, true);
  assert.ok(!commandResult.output.includes("sk-test-secret"));
  assert.ok(!commandResult.output.includes(tmpDir));
  assert.ok(commandResult.output.includes("[REDACTED]"));

  const failedCommand = service.runCommand({
    command: "printf 'Error: verification failed\\n' 1>&2; exit 2",
    maxChars: 500,
  });
  assert.equal(failedCommand.success, false);
  assert.equal(failedCommand.exitCode, 2);
  assert.equal(failedCommand.hasErrors, true);
  assert.ok(failedCommand.output.includes("verification failed"));


  service.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

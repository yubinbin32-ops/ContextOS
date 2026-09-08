import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { MdflowService } from "../src/service.mjs";

test("progressive materialization: virtual blueprint vs anchored code facades", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mdflow-test-materialization-"));
  const mdflowDir = path.join(tmpDir, ".mdflow");
  const srcDir = path.join(tmpDir, "src");
  await fs.mkdir(mdflowDir, { recursive: true });
  await fs.mkdir(srcDir, { recursive: true });

  await fs.writeFile(
    path.join(mdflowDir, "project.json"),
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

  const service = new MdflowService({ projectRoot: tmpDir, autoSync: true });

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
          deliveryState: "complete",
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
  const streamRes = service.chainCodeStream({ chainId: "checkout-chain" });
  assert.equal(streamRes.nodes.length, 2);
  assert.ok(streamRes.codeStream.includes("PaymentService"));
  assert.ok(streamRes.codeStream.includes("Planned Contract"));
  assert.ok(streamRes.codeStream.includes("evaluate(tx) -> RiskScore"));

  service.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

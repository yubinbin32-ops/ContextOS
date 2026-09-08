import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { MdflowService } from "../src/service.mjs";

test("context retrieval: CJK tokens and field-weighted relevance ranking", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mdflow-test-retrieval-"));
  const mdflowDir = path.join(tmpDir, ".mdflow");
  await fs.mkdir(mdflowDir, { recursive: true });

  await fs.writeFile(
    path.join(mdflowDir, "project.json"),
    JSON.stringify({ id: "retrieval-test", name: "Retrieval Test" }, null, 2)
  );

  const service = new MdflowService({ projectRoot: tmpDir });

  // Create blocks with different field matches
  service.mutate({
    reason: "Create test blocks for retrieval verification",
    operations: [
      {
        action: "create_block",
        id: "block:auth-api",
        fields: {
          title: "用户认证接口",
          kind: "service",
          deliveryState: "complete",
          healthState: "healthy",
          summary: "处理 JWT Token 校验与用户会话状态",
          scope: "auth",
          architectureLayer: "boundary",
        },
      },
      {
        action: "create_block",
        id: "block:data-store",
        fields: {
          title: "持久化存储引擎",
          kind: "database",
          deliveryState: "complete",
          healthState: "healthy",
          summary: "基于 SQLite 与 JSON 的原子提交管理",
          scope: "database",
          architectureLayer: "data",
        },
      },
      {
        action: "create_block",
        id: "block:git-sync",
        fields: {
          title: "Git 版本同步与原子撤回",
          kind: "service",
          deliveryState: "complete",
          healthState: "healthy",
          summary: "支持通过 Git Discard 撤回代码与图谱真理源",
          scope: "sync",
          architectureLayer: "domain",
        },
      },
    ],
  });

  // Query 1: Chinese query matching title "用户认证"
  const result1 = service.contextForTask({
    task: "需要修改用户认证接口的逻辑",
    maxChars: 4000,
  });
  assert.ok(result1.markdown.includes("用户认证接口") || result1.markdown.includes("auth-api"));
  assert.ok(!result1.markdown.includes("持久化存储引擎"));

  // Query 2: Chinese query matching summary "Git Discard 撤回"
  const result2 = service.contextForTask({
    task: "测试 Git Discard 撤回功能是否正常",
    maxChars: 4000,
  });
  assert.ok(result2.markdown.includes("Git 版本同步与原子撤回") || result2.markdown.includes("git-sync"));

  // Query 3: Focus ref priority
  const result3 = service.contextForTask({
    task: "常规任务",
    focusRefs: ["block:data-store"],
    maxChars: 4000,
  });
  assert.ok(result3.markdown.includes("持久化存储引擎") || result3.markdown.includes("data-store"));

  service.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

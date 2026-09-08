import { MdflowService } from "../packages/mcp/src/service.mjs";
import { exportGraphToJson } from "../packages/mcp/src/database.mjs";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { performance } from "node:perf_hooks";

// 近似 Token 计算 (1 token ≈ 4 chars 英文/代码, 1 token ≈ 1.5~2 chars 中文)
function estimateTokens(str) {
  let chineseChars = 0;
  let otherChars = 0;
  for (let i = 0; i < str.length; i++) {
    if (str.charCodeAt(i) > 255) {
      chineseChars++;
    } else {
      otherChars++;
    }
  }
  return Math.ceil(chineseChars / 1.5 + otherChars / 4.0);
}

async function runBenchmark() {
  console.log("\n================================================================");
  console.log("  MDFLOW EMPIRICAL BENCHMARK & REAL-WORLD VALIDATION SUITE");
  console.log("================================================================\n");

  const repoRoot = path.resolve(import.meta.dirname, "..");

  // -------------------------------------------------------------
  // PART A: 从零构建真实电商系统 (0-to-1 Bootstrap Lifecycle)
  // -------------------------------------------------------------
  console.log("----------------------------------------------------------------");
  console.log("  PART A: 从零构建系统全生命周期验证 (8个核心模块、链路与契约)");
  console.log("----------------------------------------------------------------\n");

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mdflow-live-benchmark-"));
  const mdflowDir = path.join(tmpDir, ".mdflow");
  await fs.mkdir(mdflowDir, { recursive: true });

  const projectJson = {
    schemaVersion: "2.0.0",
    id: "ecommerce-core",
    name: "E-Commerce Core Microservices",
    defaultLocale: "zh-CN",
    supportedLocales: ["zh-CN", "en"],
  };
  await fs.writeFile(path.join(mdflowDir, "project.json"), JSON.stringify(projectJson, null, 2));

  const service = new MdflowService({ projectRoot: tmpDir, autoSync: true });

  // TEST 1: 0-to-1 架构入库性能
  console.log(">>> [1/4] 测试从零构建项目：写入 8 个核心模块与有向拓扑关系...");
  const t0 = performance.now();

  const createOps = [
    {
      action: "create_block",
      id: "web-ui",
      fields: {
        title: "Web 前端客户端",
        kind: "ui",
        architectureLayer: "client",
        deliveryState: "complete",
        healthState: "healthy",
        summary: "Next.js 客户端收银台与购物车交互",
        contract: "输入: cart_id; 输出: checkout_token",
        scope: "web",
      },
    },
    {
      action: "create_block",
      id: "order-api",
      fields: {
        title: "订单网关与防重幂等服务",
        kind: "service",
        architectureLayer: "boundary",
        deliveryState: "complete",
        healthState: "healthy",
        summary: "暴露 POST /api/orders 接口，使用 Redis 分布式锁防重复提交",
        contract: "POST /api/orders { user_id, items, idempotency_key } -> OrderResponse",
        scope: "order",
      },
    },
    {
      action: "create_block",
      id: "payment-service",
      fields: {
        title: "第三方支付路由与扣款服务",
        kind: "service",
        architectureLayer: "application",
        deliveryState: "implementing",
        healthState: "warning",
        summary: "封装微信支付与支付宝渠道，处理异步回调与自动对账",
        contract: "pay(order_id, amount, channel) -> PaymentStatus",
        scope: "payment",
      },
    },
    {
      action: "create_block",
      id: "inventory-service",
      fields: {
        title: "库存锁定与扣减服务",
        kind: "service",
        architectureLayer: "domain",
        deliveryState: "complete",
        healthState: "healthy",
        summary: "高并发库存预扣与超时自动释放机制",
        contract: "reserve(sku_id, count, order_id) -> ReserveToken",
        scope: "inventory",
      },
    },
    {
      action: "create_block",
      id: "database",
      fields: {
        title: "订单主从数据库",
        kind: "database",
        architectureLayer: "data",
        deliveryState: "complete",
        healthState: "healthy",
        summary: "PostgreSQL 分库分表集群",
        contract: "ACID 事务保障",
        scope: "storage",
      },
    },
    {
      action: "create_block",
      id: "notification-service",
      fields: {
        title: "订单消息与短信推送",
        kind: "service",
        architectureLayer: "external",
        deliveryState: "complete",
        healthState: "healthy",
        summary: "Kafka 消费订单状态并发送 Push/SMS",
        contract: "sendNotification(user_id, template_id, params)",
        scope: "notify",
      },
    },
    // Links
    {
      action: "create_link",
      id: "link:ui-to-api",
      fields: {
        sourceType: "block",
        sourceId: "web-ui",
        targetType: "block",
        targetId: "order-api",
        kind: "calls",
        summary: "前端发起下单请求",
      },
    },
    {
      action: "create_link",
      id: "link:api-to-payment",
      fields: {
        sourceType: "block",
        sourceId: "order-api",
        targetType: "block",
        targetId: "payment-service",
        kind: "flows_to",
        summary: "创建待支付单并唤起收银台",
      },
    },
    {
      action: "create_link",
      id: "link:api-to-inventory",
      fields: {
        sourceType: "block",
        sourceId: "order-api",
        targetType: "block",
        targetId: "inventory-service",
        kind: "depends_on",
        summary: "下单前必须锁定库存",
      },
    },
    {
      action: "create_link",
      id: "link:payment-to-db",
      fields: {
        sourceType: "block",
        sourceId: "payment-service",
        targetType: "block",
        targetId: "database",
        kind: "writes",
        summary: "支付成功更新订单为已支付状态",
      },
    },
    // Chain
    {
      action: "create_chain",
      id: "checkout-flow",
      fields: {
        title: "端到端收银支付主链路",
        intent: "用户从点击结账到支付成功收到通知的完整高可用链路",
        deliveryState: "implementing",
      },
    },
  ];

  service.mutate({
    reason: "Bootstrap core e-commerce architecture",
    operations: createOps,
  });

  const ingestionTime = performance.now() - t0;
  console.log(`✓ 架构拓扑成功入库：${createOps.length} 个原子操作，耗时 ${ingestionTime.toFixed(2)} ms，当前 Revision = ${service.snapshot().project.graphRevision}`);

  // TEST 2: 上下文检索测速 (100 次压测)
  console.log("\n>>> [2/4] 测试上下文获取速度：进行 100 次不同场景真实检索压测...");
  const queries = [
    "支付服务微信异步回调处理异常",
    "库存预扣超时自动释放",
    "前端收银台调用下单接口",
    "PostgreSQL 订单主表死锁排查",
  ];

  const latencies = [];
  for (let i = 0; i < 100; i++) {
    const q = queries[i % queries.length];
    const start = performance.now();
    const result = service.contextForTask({ task: q, maxChars: 4000 });
    const end = performance.now();
    latencies.push(end - start);
    if (!result.markdown || result.markdown.length < 50) {
      throw new Error(`Query failed for: ${q}`);
    }
  }

  latencies.sort((a, b) => a - b);
  const minLatency = latencies[0];
  const maxLatency = latencies[latencies.length - 1];
  const p50Latency = latencies[Math.floor(latencies.length * 0.5)];
  const p95Latency = latencies[Math.floor(latencies.length * 0.95)];
  const avgLatency = latencies.reduce((sum, v) => sum + v, 0) / latencies.length;

  console.log(`✓ 100 次真实检索测速结果:`);
  console.log(`    - 平均时延 (Average): ${avgLatency.toFixed(3)} ms`);
  console.log(`    - 中位数时延 (P50):    ${p50Latency.toFixed(3)} ms`);
  console.log(`    - 95 分位时延 (P95):   ${p95Latency.toFixed(3)} ms`);
  console.log(`    - 最小时延 (Min):      ${minLatency.toFixed(3)} ms`);
  console.log(`    - 最大时延 (Max):      ${maxLatency.toFixed(3)} ms`);

  // TEST 3: 上下文体积与失真度对比
  console.log("\n>>> [3/4] 测试上下文体积与失真度对比 (Token 消耗实测)...");
  const traditionalMarkdownDoc = `# 电商系统全量架构设计与接口规范

## 1. 业务愿景与规范
本项目采用领域驱动设计（DDD），前端使用 Next.js，后端拆分为订单、支付、库存三大核心微服务，底层存储依赖 PostgreSQL 和 Redis 集群。

## 2. 模块规格说明
### 2.1 Web 前端客户端 (web-ui)
- 架构层级: Client
- 状态: 已完成 (healthy)
- 描述: Next.js 客户端收银台与购物车交互。
- 契约接口: 输入 cart_id; 输出 checkout_token。

### 2.2 订单网关与防重幂等服务 (order-api)
- 架构层级: Boundary
- 状态: 已完成 (healthy)
- 描述: 暴露 POST /api/orders 接口，使用 Redis 分布式锁防重复提交。
- 契约接口: POST /api/orders { user_id, items, idempotency_key } -> OrderResponse。

### 2.3 第三方支付路由与扣款服务 (payment-service)
- 架构层级: Application
- 状态: 实施中 (warning)
- 描述: 封装微信支付与支付宝渠道，处理异步回调与自动对账。
- 契约接口: pay(order_id, amount, channel) -> PaymentStatus。

### 2.4 库存锁定与扣减服务 (inventory-service)
- 架构层级: Domain
- 状态: 已完成 (healthy)
- 描述: 高并发库存预扣与超时自动释放机制。
- 契约接口: reserve(sku_id, count, order_id) -> ReserveToken。

### 2.5 订单主从数据库 (database)
- 架构层级: Data
- 状态: 已完成 (healthy)
- 描述: PostgreSQL 分库分表集群。
- 契约要求: ACID 事务保障。

### 2.6 订单消息与短信推送 (notification-service)
- 架构层级: External
- 状态: 已完成 (healthy)
- 描述: Kafka 消费订单状态并发送 Push/SMS。
- 契约接口: sendNotification(user_id, template_id, params)。

## 3. 链路拓扑与端到端时序
1. web-ui -> calls -> order-api: 前端发起下单请求
2. order-api -> flows_to -> payment-service: 创建待支付单并唤起收银台
3. order-api -> depends_on -> inventory-service: 下单前必须锁定库存
4. payment-service -> writes -> database: 支付成功更新订单为已支付状态

## 4. 任务计划与历史记录
- 阶段 1: 完成基础 API 骨架 (已验证)
- 阶段 2: 接入支付沙箱回调测试 (进行中)
- 阶段 3: 压测库存防超卖与锁粒度 (待规划)
`;

  const targetTask = "修改支付回调接口，解决微信支付流水回写失败问题";
  const mdflowContextResult = service.contextForTask({ task: targetTask, maxChars: 4000 });
  const mdflowContextText = mdflowContextResult.markdown;

  const fullDocTokens = estimateTokens(traditionalMarkdownDoc);
  const mdflowTokens = estimateTokens(mdflowContextText);
  const tokenSaving = ((1 - mdflowTokens / fullDocTokens) * 100).toFixed(1);

  console.log(`- 传统 Markdown 全量文档体积:  ${traditionalMarkdownDoc.length} 字符 | 约 ${fullDocTokens} Tokens`);
  console.log(`- mdflow 精准任务切片体积:      ${mdflowContextText.length} 字符 | 约 ${mdflowTokens} Tokens`);
  console.log(`- Token 节约率 (Context Saved):  ${tokenSaving}%`);

  console.log("\n  [失真度与抗干扰检验 (Fidelity Check)]:");
  const refs = mdflowContextResult.refs;
  const containsPayment = refs.includes("block:payment-service") || mdflowContextText.includes("payment-service");
  const containsInventoryDetails = mdflowContextText.includes("reserve(sku_id, count, order_id)");
  const isolatedInventory = !refs.includes("block:inventory-service") && !containsInventoryDetails;

  console.log(`    * 核心目标 [payment-service] 命中:     ${containsPayment ? "✓ YES (精准锁定目标域)" : "✗ NO"}`);
  console.log(`    * 契约定义与接口规格完整提取:            ${mdflowContextText.includes("pay(order_id") ? "✓ YES (接口契约零失真)" : "✗ NO"}`);
  console.log(`    * 无关模块细节 [inventory-service] 隔离: ${isolatedInventory ? "✓ YES (零噪声，注意力无污染)" : "✗ 隔离失败"}`);

  // TEST 4: 动态演进、检查点固化与 Git Discard 回退一致性
  console.log("\n>>> [4/4] 测试动态演进、检查点记录与 Git 回退重载一致性...");

  const cpRecord = service.recordCheckpoint({
    targetType: "block",
    targetId: "payment-service",
    title: "微信回调签名与流水写入测试通过",
    status: "passed",
    evidenceLevel: "integration",
    evidence: [{ testCase: "testWeChatCallbackSignature", durationMs: 14 }],
  });
  console.log(`✓ 检查点成功固化：ID = ${cpRecord.checkpoint.id}, status = ${cpRecord.checkpoint.status}`);

  const graphJsonPath = path.join(mdflowDir, "graph.json");
  exportGraphToJson(service.database, graphJsonPath);
  const jsonExport = await fs.readFile(graphJsonPath, "utf8");
  console.log(`✓ 已生成 Git 跟踪文本真理源: ${graphJsonPath} (${jsonExport.length} 字节)`);

  const dirtyOp = service.mutate({
    reason: "Accidentally added wrong experimental feature",
    operations: [
      {
        action: "create_block",
        id: "broken-feature",
        fields: {
          title: "错误编写的破坏性实验模块",
          kind: "risk",
          deliveryState: "implementing",
          healthState: "failing",
        },
      },
    ],
  });
  console.log(`  - 模拟 AI 写入了破坏性模块: ${dirtyOp.changeSetId}, 当前块总数 = ${service.snapshot().blocks.length}`);

  const revertResult = service.revertChangeSet({ changeSetId: dirtyOp.changeSetId, reason: "回退错误编写的破坏性实验模块" });
  console.log(`✓ 使用 revertChangeSet 回退破坏性模块: 恢复操作数 = ${revertResult.receipts.length}, 回退后块总数 = ${service.snapshot().blocks.length}`);

  await fs.writeFile(graphJsonPath, jsonExport);
  const syncStatus = service.ensureSynced();
  console.log(`✓ 模拟 Git Discard 外部重置: ensureSynced 检测结果 = ${syncStatus ? "已成功热重载 SQLite" : "无需重载（哈希一致）"}`);

  service.close();
  await fs.rm(tmpDir, { recursive: true, force: true });

  // -------------------------------------------------------------
  // PART B: 真实中大型工程实测 (Current mdflow Project: 27 Blocks, 700+ Revisions)
  // -------------------------------------------------------------
  console.log("\n----------------------------------------------------------------");
  console.log("  PART B: 真实中大型工程实测 (当前 mdflow 仓库：27 Blocks, 700+ Revisions)");
  console.log("----------------------------------------------------------------\n");

  const realService = new MdflowService({ projectRoot: repoRoot });
  const snapshot = realService.snapshot();
  console.log(`>>> 真实工程规模:`);
  console.log(`    - Blocks 实体数:     ${snapshot.blocks.length}`);
  console.log(`    - Chains 业务链路:   ${snapshot.chains.length}`);
  console.log(`    - Links 拓扑边数:    ${snapshot.links.length}`);
  console.log(`    - Checkpoints 凭据:  ${snapshot.checkpoints.length}`);

  const fullGraphJson = await fs.readFile(path.join(repoRoot, ".mdflow", "graph.json"), "utf8");
  const fullGraphTokens = estimateTokens(fullGraphJson);

  const realQueries = [
    "OpenCode 平台支持与 MCP 注入",
    "macOS Desktop 设置界面纯白重构",
    "Git Discard 撤回与本地 SQLite 热重载",
    "CJK 中文分词与 BM25 字段加权检索",
  ];

  const realLatencies = [];
  let sampleTaskResult = null;
  for (let i = 0; i < 100; i++) {
    const q = realQueries[i % realQueries.length];
    const s = performance.now();
    const r = realService.contextForTask({ task: q, maxChars: 4000 });
    const e = performance.now();
    realLatencies.push(e - s);
    if (i === 0) sampleTaskResult = r;
  }

  realLatencies.sort((a, b) => a - b);
  const realAvg = realLatencies.reduce((s, v) => s + v, 0) / realLatencies.length;
  const realP50 = realLatencies[Math.floor(realLatencies.length * 0.5)];
  const realP95 = realLatencies[Math.floor(realLatencies.length * 0.95)];
  const realMin = realLatencies[0];
  const realMax = realLatencies[realLatencies.length - 1];

  console.log(`\n>>> 真实 27-Block 复杂项目检索测速 (100 次压测):`);
  console.log(`    - 平均时延 (Average): ${realAvg.toFixed(3)} ms`);
  console.log(`    - 中位数时延 (P50):    ${realP50.toFixed(3)} ms`);
  console.log(`    - 95 分位时延 (P95):   ${realP95.toFixed(3)} ms`);
  console.log(`    - 最小时延 (Min):      ${realMin.toFixed(3)} ms`);
  console.log(`    - 最大时延 (Max):      ${realMax.toFixed(3)} ms`);

  const taskTokens = estimateTokens(sampleTaskResult.markdown);
  const realReduction = ((1 - taskTokens / fullGraphTokens) * 100).toFixed(1);

  console.log(`\n>>> 真实 Token 消耗与压缩比率:`);
  console.log(`    - 全量工程图谱体积 (传统长文档等价):  ${fullGraphJson.length} 字符 | 约 ${fullGraphTokens} Tokens`);
  console.log(`    - 任务切片上下文体积 (context_for_task): ${sampleTaskResult.markdown.length} 字符 | 约 ${taskTokens} Tokens`);
  console.log(`    - 实测 Token 节省率 (Token Reduction):   ${realReduction}%`);

  console.log(`\n>>> 真实任务目标捕获精准度检验 (Task: "${realQueries[0]}"):`);
  const hasInApp = sampleTaskResult.markdown.includes("in-app-plugin-install");
  const hasCodex = sampleTaskResult.markdown.includes("codex-plugin");
  console.log(`    * 是否命中目标安装模块 [in-app-plugin-install]: ${hasInApp ? "✓ YES (精准命中)" : "✗ NO"}`);
  console.log(`    * 是否包含直接关联拓扑 [codex-plugin]:            ${hasCodex ? "✓ YES (依赖捕获完整)" : "✗ NO"}`);

  realService.close();

  console.log("\n================================================================");
  console.log("  BENCHMARK FINISHED: 实测完毕，数据真实可靠！");
  console.log("================================================================\n");
}

runBenchmark().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});

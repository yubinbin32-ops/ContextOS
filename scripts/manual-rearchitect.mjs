import fs from "node:fs";
import path from "node:path";
import { ContextOSV2Service } from "../packages/mcp/src/v2-service.mjs";

const projectRoot = process.cwd();
const projectId = "contextos";
const service = new ContextOSV2Service({ projectRoot, projectId });

const BLOCKS = [
  {
    id: "block-intent-surface",
    title: "意图入口层",
    kind: "gateway",
    summary: "只暴露 explore/change/verify/ship/ops 五个意图级 MCP 工具；AI 给意图，OS 跑内部能力。",
    paths: ["packages/mcp/src/v3-server.mjs"],
  },
  {
    id: "block-orchestrator",
    title: "编排内核",
    kind: "engine",
    summary: "意图路由、四条流水线、上下文预算、会话存储、git 对账与追踪，一次调用跑完整条能力链。",
    paths: [
      "packages/orchestrator/src/index.mjs",
      "packages/orchestrator/src/pipelines.mjs",
      "packages/orchestrator/src/intent-router.mjs",
      "packages/orchestrator/src/context-budget.mjs",
      "packages/orchestrator/src/session-store.mjs",
      "packages/orchestrator/src/observer.mjs",
      "packages/orchestrator/src/tracer.mjs",
    ],
  },
  {
    id: "block-module-index",
    title: "派生模块索引",
    kind: "service",
    summary: "用 AST 与目录聚类派生 mod-* 模块并按 mtime/size 增量缓存，取代人工声明 Block 的义务。",
    paths: ["packages/orchestrator/src/module-index.mjs"],
  },
  {
    id: "block-capability-registry",
    title: "内部能力注册表",
    kind: "gateway",
    summary: "把 V2 的 os_context/plan/task/block/chain/code/run_command/process/knowledge 收敛为内部能力，ops 直通保留。",
    paths: ["packages/orchestrator/src/capabilities.mjs", "packages/mcp/src/service-factory.mjs"],
  },
  {
    id: "block-ast-engine",
    title: "真 AST 解析引擎",
    kind: "engine",
    summary: "Tree-sitter 多语言解析与语言注册，提供符号、方法、2-Hop 调用拓扑与哈希锚点。",
    paths: ["packages/code-intel/src/tree-sitter-parser.mjs", "packages/code-intel/src/language-registry.mjs"],
  },
  {
    id: "block-surgical-code",
    title: "手术刀读写与重锚",
    kind: "service",
    summary: "大纲、全局符号检索、按行或符号切片、唯一匹配改写，写盘后自动重解析并重锚符号。",
    paths: ["packages/code-intel/src/code-tools.mjs", "packages/code-intel/src/bindings.mjs"],
  },
  {
    id: "block-coverage-advisory",
    title: "覆盖率与不变式校验",
    kind: "service",
    summary: "文件归属、覆盖率计算与架构不变式守卫；V3 路径下为 advisory，strict 模式才硬门禁。",
    paths: ["packages/code-intel/src/coverage.mjs", "packages/domain/src/invariants.mjs"],
  },
  {
    id: "block-sqlite-store",
    title: "SQLite 存储与 schema",
    kind: "database",
    summary: "WAL 模式下的活动状态存储、schema 迁移与项目写锁，是架构事实的唯一落点。",
    paths: ["packages/storage/src/database.mjs", "packages/storage/src/schema.mjs", "packages/storage/src/project-lock.mjs"],
  },
  {
    id: "block-graph-sync",
    title: "图谱双写与 Git 对账",
    kind: "service",
    summary: "graph.json 与 SQLite 双写、outbox 恢复，以及外部改动的 mtime/SHA256 对账与冲突检测。",
    paths: ["packages/storage/src/sync-engine.mjs"],
  },
  {
    id: "block-domain-models",
    title: "领域实体模型",
    kind: "model",
    summary: "Plan/Task/Block/Chain/Link/Knowledge 实体与状态机，V3 下仅由 ops 与内部能力驱动。",
    paths: [
      "packages/domain/src/plan.mjs",
      "packages/domain/src/task.mjs",
      "packages/domain/src/block.mjs",
      "packages/domain/src/chain.mjs",
      "packages/domain/src/link.mjs",
      "packages/domain/src/knowledge.mjs",
    ],
  },
  {
    id: "block-app-services",
    title: "应用服务层",
    kind: "service",
    summary: "PlanService/TaskService/KnowledgeService：计划、任务与规则决策的应用层协调。",
    paths: [
      "packages/application/src/plan-service.mjs",
      "packages/application/src/task-service.mjs",
      "packages/application/src/knowledge-service.mjs",
    ],
  },
  {
    id: "block-command-gateway",
    title: "出舱命令与脱敏回执",
    kind: "service",
    summary: "一次性命令的沙箱执行：剥离 ANSI、脱敏密钥、全量日志出舱，只回传精简 Receipt。",
    paths: ["packages/process-host/src/runner.mjs", "packages/process-host/src/sanitizer.mjs"],
  },
  {
    id: "block-process-supervisor",
    title: "常驻进程托管",
    kind: "service",
    summary: "dev server / watcher 等常驻进程的启动、日志按需调阅与整棵进程树终止。",
    paths: ["packages/process-host/src/process-manager.mjs", "apps/daemon/src/osd.mjs"],
  },
  {
    id: "block-context-renderer",
    title: "渐进式上下文渲染",
    kind: "service",
    summary: "L0-L3 分层 Markdown 渲染，把图谱、计划、任务与规则压成可放进上下文预算的简报。",
    paths: ["packages/context/src/markdown-renderer.mjs"],
  },
  {
    id: "block-metro-layout",
    title: "地铁图布局引擎",
    kind: "engine",
    summary: "把 Block 与 Chain 计算成地铁线路与换乘站坐标，供桌面端与可视化消费。",
    paths: ["packages/layout/src/network-layout.mjs"],
  },
  {
    id: "block-desktop-shell",
    title: "桌面应用外壳",
    kind: "ui",
    summary: "macOS 原生应用入口、窗口与主题、版本更新，承载整个架构图谱工作台。",
    paths: [
      "apps/desktop/Sources/ContextOSDesktop/ContextOSDesktopApp.swift",
      "apps/desktop/Sources/ContextOSDesktop/ContentView.swift",
      "apps/desktop/Sources/ContextOSDesktop/Theme.swift",
      "apps/desktop/Sources/ContextOSDesktop/AppUpdater.swift",
    ],
  },
  {
    id: "block-desktop-canvas",
    title: "图谱画布与布局视图",
    kind: "ui",
    summary: "地铁图场景、画布交互与图谱状态管理，把模块与链条渲染成可导航的线路。",
    paths: [
      "apps/desktop/Sources/ContextOSDesktop/CanvasScene.swift",
      "apps/desktop/Sources/ContextOSDesktop/GraphCanvasView.swift",
      "apps/desktop/Sources/ContextOSDesktop/NetworkLayoutEngine.swift",
      "apps/desktop/Sources/ContextOSDesktop/GraphStore.swift",
    ],
  },
  {
    id: "block-desktop-inspector",
    title: "检视器与知识阅读",
    kind: "ui",
    summary: "详情检视、知识抽屉与 Markdown 渲染，以及桌面端对项目库与工程位置的读写。",
    paths: [
      "apps/desktop/Sources/ContextOSDesktop/DetailView.swift",
      "apps/desktop/Sources/ContextOSDesktop/KnowledgeView.swift",
      "apps/desktop/Sources/ContextOSDesktop/MarkdownPage.swift",
      "apps/desktop/Sources/ContextOSDesktop/Models.swift",
      "apps/desktop/Sources/ContextOSDesktop/ProjectDatabase.swift",
      "apps/desktop/Sources/ContextOSDesktop/ProjectLocation.swift",
    ],
  },
  {
    id: "block-desktop-installer",
    title: "桌面端环境与插件同步",
    kind: "tooling",
    summary: "检测宿主编辑器、注入 MCP 与 Skill、安装与升级插件包。",
    paths: ["apps/desktop/Sources/ContextOSDesktop/PluginInstaller.swift"],
  },
  {
    id: "block-plugin-bootstrap",
    title: "插件打包与系统能力",
    kind: "tooling",
    summary: "初始化工作区、注入编辑器、云端或本地切换与环境自检（init/doctor/switch）。",
    paths: ["packages/mcp/src/bootstrap-util.mjs", "packages/mcp/src/system-tools.mjs", "packages/mcp/src/admin-cli.mjs"],
  },
  {
    id: "block-cloud-hub",
    title: "云端 Hub 与边缘同步",
    kind: "api",
    summary: "Cloudflare Worker + D1 的远端中枢、云端客户端与混合服务，实现本地或云端快照双向迁移。",
    paths: [
      "worker.js",
      "apps/cloud/src/index.mjs",
      "packages/mcp/src/cloud-client.mjs",
      "packages/mcp/src/hybrid-service.mjs",
    ],
  },
  {
    id: "block-verification-suite",
    title: "验证与回归套件",
    kind: "testing",
    summary: "流程模拟、插件冒烟、单测与基准：以真实开发任务为门禁，守住意图级循环的成本与正确性。",
    paths: [
      "scripts/dev-flow-sim.mjs",
      "scripts/plugin-smoke.mjs",
      "scripts/fixture-project.mjs",
      "scripts/manual-tree-bindings.mjs",
      "scripts/benchmark.mjs",
    ],
  },
];

const CHAINS = [
  {
    id: "chain-intent-orchestration",
    title: "意图入口与编排链",
    summary: "从意图到执行的整条链路：入口工具 -> 编排内核 -> 派生索引 -> 内部能力。",
    members: ["block-intent-surface", "block-orchestrator", "block-module-index", "block-capability-registry"],
  },
  {
    id: "chain-code-intel",
    title: "AST 代码智能链",
    summary: "解析、检索、切片与改写，为手术刀式读写与覆盖率校验提供能力。",
    members: ["block-ast-engine", "block-surgical-code", "block-coverage-advisory"],
  },
  {
    id: "chain-state-storage",
    title: "状态与存储链",
    summary: "从领域模型到应用服务，再到 SQLite 与图谱双写，构成架构事实的唯一落点。",
    members: ["block-domain-models", "block-app-services", "block-sqlite-store", "block-graph-sync"],
  },
  {
    id: "chain-execution",
    title: "执行与命令链",
    summary: "一次性命令出舱与常驻进程托管，保证日志不进上下文而证据留在 Receipt。",
    members: ["block-command-gateway", "block-process-supervisor"],
  },
  {
    id: "chain-context-presentation",
    title: "上下文渲染与布局链",
    summary: "把图谱与状态渲染成预算内的简报，并计算地铁图坐标。",
    members: ["block-context-renderer", "block-metro-layout"],
  },
  {
    id: "chain-desktop",
    title: "桌面端链",
    summary: "macOS 原生工作台：外壳、画布、检视器与插件同步。",
    members: ["block-desktop-shell", "block-desktop-canvas", "block-desktop-inspector", "block-desktop-installer"],
  },
  {
    id: "chain-distribution",
    title: "分发、云端与验证链",
    summary: "插件打包与系统能力、云端 Hub 同步，以及作为门禁的验证套件。",
    members: ["block-plugin-bootstrap", "block-cloud-hub", "block-verification-suite"],
  },
];

const LINKS = [
  { from: "block-intent-surface", to: "block-orchestrator", kind: "calls", reason: "入口工具把意图交给编排内核" },
  { from: "block-orchestrator", to: "block-capability-registry", kind: "calls", reason: "流水线调用内部能力" },
  { from: "block-orchestrator", to: "block-module-index", kind: "calls", reason: "候选模块与自动归属来自派生索引" },
  { from: "block-module-index", to: "block-ast-engine", kind: "depends_on", reason: "模块符号由 AST 解析得出" },
  { from: "block-capability-registry", to: "block-surgical-code", kind: "calls", reason: "code 能力落在手术刀读写" },
  { from: "block-capability-registry", to: "block-command-gateway", kind: "calls", reason: "run_command 能力落在命令网关" },
  { from: "block-capability-registry", to: "block-process-supervisor", kind: "calls", reason: "process 能力落在进程托管" },
  { from: "block-capability-registry", to: "block-app-services", kind: "calls", reason: "plan/task/knowledge 能力落在应用服务层" },
  { from: "block-capability-registry", to: "block-context-renderer", kind: "calls", reason: "简报与实体渲染复用渲染器" },
  { from: "block-surgical-code", to: "block-ast-engine", kind: "depends_on", reason: "切片与重锚依赖解析引擎" },
  { from: "block-coverage-advisory", to: "block-surgical-code", kind: "depends_on", reason: "覆盖率按文件与符号锚点计算" },
  { from: "block-app-services", to: "block-domain-models", kind: "depends_on", reason: "服务层操作领域实体" },
  { from: "block-app-services", to: "block-sqlite-store", kind: "depends_on", reason: "状态持久化在 SQLite" },
  { from: "block-graph-sync", to: "block-sqlite-store", kind: "depends_on", reason: "双写与 outbox 基于同一库" },
  { from: "block-context-renderer", to: "block-domain-models", kind: "depends_on", reason: "渲染对象来自领域模型" },
  { from: "block-desktop-canvas", to: "block-metro-layout", kind: "depends_on", reason: "画布坐标由布局引擎计算" },
  { from: "block-desktop-shell", to: "block-desktop-canvas", kind: "depends_on", reason: "外壳承载画布" },
  { from: "block-desktop-inspector", to: "block-sqlite-store", kind: "imports", reason: "桌面端直接读取项目库" },
  { from: "block-cloud-hub", to: "block-graph-sync", kind: "depends_on", reason: "云端快照与本地双写对账" },
  { from: "block-verification-suite", to: "block-intent-surface", kind: "depends_on", reason: "流程模拟以意图入口为被测面" },
  { from: "block-plugin-bootstrap", to: "block-intent-surface", kind: "depends_on", reason: "打包与注入的对象是意图入口" },
];

function purge() {
  const before = {
    links: service.db.listLinks(projectId).length,
    chains: service.db.listChains(projectId).length,
    blocks: service.db.listBlocks(projectId).length,
    plans: service.db.listPlans(projectId).length,
    tasks: service.db.listTasks().length,
  };
  for (const link of service.db.listLinks(projectId)) service.db.deleteLink(link.id);
  for (const chain of service.db.listChains(projectId)) service.db.deleteChain(chain.id);
  for (const block of service.db.listBlocks(projectId)) service.db.deleteBlock(block.id);
  // Historical plans are all completed or archived; tasks, phases and checkpoints cascade.
  for (const plan of service.db.listPlans(projectId)) service.db.deletePlan(plan.id);
  return before;
}

async function rebuild() {
  const missing = [];
  for (const block of BLOCKS) {
    const paths = block.paths.filter((relative) => {
      const exists = fs.existsSync(path.join(projectRoot, relative));
      if (!exists) missing.push(`${block.id}: ${relative}`);
      return exists;
    });
    if (!paths.length) continue;
    await service.block({
      action: "bind_auto",
      id: block.id,
      paths,
      blockData: { title: block.title, kind: block.kind, summary: block.summary },
    });
  }

  for (const chain of CHAINS) {
    await service.chain({
      action: "compose",
      chainData: {
        id: chain.id,
        title: chain.title,
        kind: "linear",
        summary: chain.summary,
        memberIds: chain.members,
      },
    });
  }

  for (const link of LINKS) {
    await service.chain({ action: "link", linkData: link });
  }

  const exportResult = service.syncEngine.exportGraphToJson(projectId, projectRoot);
  return { missing, exportResult };
}

const before = purge();
const { missing, exportResult } = await rebuild();

console.log("架构重整完成：");
console.log(`- 清理：plans ${before.plans}（含 tasks ${before.tasks}）、blocks ${before.blocks}、chains ${before.chains}、links ${before.links}`);
console.log(`- 重建：blocks ${BLOCKS.length}、chains ${CHAINS.length}、links ${LINKS.length}`);
console.log(`- graph.json 修订：${exportResult?.graphRevision ?? "n/a"}`);
if (missing.length) console.log(`- 路径缺失已跳过：\n  ${missing.join("\n  ")}`);
service.close();

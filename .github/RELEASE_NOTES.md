# ContextOS 2.7.1 — Focused code, compact receipts, reproducible results

ContextOS keeps AI coding conversations smaller by returning the code an agent needs and keeping command logs outside the conversation. This release fixes precise reads and installation verification, and replaces broad token-saving claims with a public benchmark.

## What you can measure

Five local runs using `o200k_base`, median **response-text tokens**:

| Controlled scenario | Native → ContextOS | Output reduction |
| --- | ---: | ---: |
| Smaller repository whole-file read → symbol | 1,459 → 336 | 76.97% |
| Large repository whole-file read → symbol | 43,031 → 280 | 99.35% |
| Repeated unchanged symbol read | 165 → 36 | 78.18% |
| Synthetic 1,000-line failed build | 14,016 → 150 | 98.93% |

**Tradeoffs are published too:** exact native slices were cheaper on first reads (165 vs 280 tokens in the large-file control); the compact tool, server instructions, and skill added about 2,504 tokens when loaded. These figures do not measure total-task tokens, model reasoning, cache discounts, or provider bills.

[Read the benchmark and controls](https://github.com/yubinbin32-ops/ContextOS/blob/v2.7.1/docs/BENCHMARK.md) · [Inspect every sample](https://github.com/yubinbin32-ops/ContextOS/blob/v2.7.1/docs/benchmarks/2026-09-30.json)

## Fixes that matter in daily use

- Parallel inspection preserves explicit symbols and line ranges.
- Non-contiguous code slices retain their original source line numbers.
- Installation refreshes Codex's registered version and verifies installed bytes.
- Read-only install checks reject stale versions and bundles; inactive historical caches stay intact.
- Plugin builds and installs include parser runtime assets; Python methods retain AST hashes and call information outside the repository.
- The benchmark checks content freshness, diagnostic preservation, and chain failure handling across five runs.

## Try it

Requires Node.js 22+. For the tested source-install route:

```bash
git clone --branch v2.7.1 https://github.com/yubinbin32-ops/ContextOS.git
cd ContextOS
npm ci
npm run plugin:build
codex plugin marketplace add .
codex plugin add contextos@contextos-development
npm run plugin:install
npm run plugin:install:check
```

Start a new chat after updating an installed plugin. Other MCP hosts can launch the same local server; see the [README](https://github.com/yubinbin32-ops/ContextOS/blob/v2.7.1/README.md).

Reproduce the measurements:

```bash
npm run benchmark:context -- --runs 5 --output .contextos/benchmarks/my-run.json
```

For a complete standalone MCP runtime, download `contextos-plugin-2.7.1.zip`, extract it, and configure your host to run `node /absolute/path/contextos-plugin/server/contextos-mcp.mjs`. It includes the parser WASM and grammars; Node.js 22+ is required. `SHA256SUMS-plugin.txt` covers the plugin archive and benchmark assets.

Release assets are listed below with checksums. Desktop availability is determined by the attached assets; the performance figures describe the MCP runtime on macOS arm64. Optional Cloud collaboration and Micro are outside this benchmark.

## 中文速览

本次更新修复了批量读取忽略区间、多区间行号错误，以及安装检查漏掉旧版本/旧文件的问题，同时补齐安装中的解析器资源，避免 Python 方法哈希与调用信息退化。公开测评包含五次运行、精确原生对照与负收益场景：两个源码整读改切片场景的返回 token 分别减少 76.97% 和 99.35%，但首次精确读取和极小任务可能更贵。**数据不代表完整开发任务的模型账单节省。**

[中文 README](https://github.com/yubinbin32-ops/ContextOS/blob/v2.7.1/README_zh.md) · [完整测评](https://github.com/yubinbin32-ops/ContextOS/blob/v2.7.1/docs/BENCHMARK.md)

If this helps your workflow, [star ContextOS](https://github.com/yubinbin32-ops/ContextOS) and share a real task benchmark. Bug reports and measurements where it costs more are welcome.

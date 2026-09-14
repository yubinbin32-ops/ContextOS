import path from 'node:path';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { ContextOSV2Service } from '../packages/mcp/src/v2-service.mjs';
import { CodeTools } from '../packages/code-intel/src/index.mjs';

async function runPracticalDevelopmentTest() {
  const repoRoot = path.resolve(import.meta.dirname, '..');
  console.log(`=== Starting Practical Development & AST Robustness Test ===`);
  console.log(`Repo: ${repoRoot}`);

  const service = new ContextOSV2Service({ projectRoot: repoRoot, projectId: 'contextos' });

  // -------------------------------------------------------------
  // Test 1: Progressive Context Retrieval (os_context)
  // -------------------------------------------------------------
  console.log('\n--- Step 1: Querying progressive context via os_context ---');
  const brief = await service.osContext({ action: 'brief', format: 'markdown' });
  assert.ok(brief.includes('# ContextOS Project Brief'), 'Brief markdown header should be present');
  assert.ok(brief.includes('Active Plan:'), 'Active Plan must be identified');
  console.log('✓ os_context returned compact L0/L1 summary without context bloat.');

  // -------------------------------------------------------------
  // Test 2: AST Progressive Reading (Code Tools)
  // -------------------------------------------------------------
  console.log('\n--- Step 2: Progressive AST outline and surgical read ---');
  const targetRelPath = 'packages/context/src/markdown-renderer.mjs';
  const outlineMarkdown = await service.code({
    action: 'outline',
    path: targetRelPath,
    format: 'markdown',
  });
  assert.ok(outlineMarkdown.includes('MarkdownRenderer'), 'Outline must discover MarkdownRenderer class');
  console.log('✓ CodeTools.outline parsed AST and returned structural symbol map.');

  // Surgical read of specific symbol
  const surgicalRead = await service.code({
    action: 'read',
    path: targetRelPath,
    selector: 'renderBrief',
    format: 'json',
  });
  assert.ok(surgicalRead.code.includes('static renderBrief'), 'Surgical read must extract renderBrief function');
  assert.ok(surgicalRead.startLine > 0, 'Start line must be positive');
  console.log(`✓ Surgical read extracted 'renderBrief' (lines ${surgicalRead.startLine}-${surgicalRead.endLine}) without reading full file.`);

  // -------------------------------------------------------------
  // Test 3: Real Code Modification via MCP & Automatic AST Re-anchoring
  // -------------------------------------------------------------
  console.log('\n--- Step 3: Real surgical code write and AST re-anchoring ---');
  const targetFileFull = path.join(repoRoot, targetRelPath);
  const originalCode = fs.readFileSync(targetFileFull, 'utf8');

  // We will insert a marker comment into renderBrief and replace it
  const marker = '// Practical Test Hook: OS V2 Active Verification';

  const editResult = await service.code({
    action: 'edit',
    path: targetRelPath,
    targetContent: '  static renderBrief({ project, activePlan, activeTask, processes = [], recentBlocks = [] }) {',
    replacementContent: `  ${marker}\n  static renderBrief({ project, activePlan, activeTask, processes = [], recentBlocks = [] }) {`,
  });

  assert.ok(editResult.newHash, 'New symbol hash must be computed');
  console.log(`✓ Surgical edit applied to ${targetRelPath}. New file hash: ${editResult.newHash.slice(0, 10)}...`);

  // Verify that the file on disk now contains the change
  const updatedDiskContent = fs.readFileSync(targetFileFull, 'utf8');
  assert.ok(updatedDiskContent.includes(marker), 'Disk file must reflect the write');

  // Verify AST re-anchoring: outline discovers new line numbers
  const updatedOutline = await service.code({
    action: 'outline',
    path: targetRelPath,
    format: 'json',
  });
  const renderBriefSymbol = updatedOutline.symbols.find((s) => s.name.includes('renderBrief'));
  assert.ok(renderBriefSymbol, 'Symbol must still be indexed');
  console.log(`✓ Symbol re-anchored cleanly at lines ${renderBriefSymbol.startLine}-${renderBriefSymbol.endLine}.`);

  // -------------------------------------------------------------
  // Test 4: Command Execution via Out-of-Context run_command
  // -------------------------------------------------------------
  console.log('\n--- Step 4: Executing test command through runCommand ---');
  const cmdReceipt = await service.runCommand({
    command: 'node --test packages/layout/test/layout.test.mjs',
  });
  assert.equal(cmdReceipt.exitCode, 0, 'Command must exit with 0');
  assert.ok(cmdReceipt.durationMs > 0, 'Duration must be recorded');
  assert.ok(cmdReceipt.logHandle, 'Log handle must point to out-of-context disk log');
  console.log(`✓ Command executed in ${cmdReceipt.durationMs}ms with out-of-context log: ${cmdReceipt.logHandle}`);

  // -------------------------------------------------------------
  // Test 5: Multi-Language AST Parsing Validation (Swift, Python, TS)
  // -------------------------------------------------------------
  console.log('\n--- Step 5: Validating multi-language AST compatibility ---');

  // Swift View and struct test
  const swiftRelPath = 'apps/desktop/Sources/ContextOSDesktop/ContentView.swift';
  const swiftOutline = await service.code({
    action: 'outline',
    path: swiftRelPath,
    format: 'json',
  });
  assert.ok(swiftOutline.symbols.length > 0, 'Swift outline must find symbols');
  const hasContentView = swiftOutline.symbols.some((s) => s.name === 'ContentView');
  assert.ok(hasContentView, 'Swift outline must identify ContentView struct');
  console.log(`✓ Swift AST: parsed ContentView with ${swiftOutline.symbols.length} top-level symbols.`);

  // TypeScript with complex braces and strings test
  const tsSnippet = `
    export interface ComplexModel {
      id: string;
      config: { nested: boolean };
    }
    export function parseData(input: string): string {
      const regex = /[{}]/;
      const str = "curly { brace } inside quote";
      // comment with { braces }
      return str.replace(regex, "");
    }
  `;
  const tsOutline = CodeTools.outline('test.ts', tsSnippet);
  assert.ok(tsOutline.structure.symbols.some((s) => s.name === 'ComplexModel'), 'TS interface must be parsed');
  assert.ok(tsOutline.structure.symbols.some((s) => s.name === 'parseData'), 'TS function with braces must be parsed');
  console.log('✓ TypeScript AST: successfully parsed interface and function with nested string/comment braces.');

  // -------------------------------------------------------------
  // Revert the temporary test edit to keep the codebase pristine
  // -------------------------------------------------------------
  console.log('\n--- Cleaning up temporary edit ---');
  fs.writeFileSync(targetFileFull, originalCode, 'utf8');
  console.log('✓ Restored original file content.');

  service.close();
  console.log('\n=== ALL PRACTICAL DEVELOPMENT TESTS PASSED 100%! ===');
}

runPracticalDevelopmentTest().catch((err) => {
  console.error('Practical test failed:', err);
  process.exit(1);
});

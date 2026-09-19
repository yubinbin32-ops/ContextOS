import { bindingMatchesPath } from './bindings.mjs';

/**
 * Coverage checker: Calculates project or task working set Block coverage.
 * Detects orphan code and coverage gaps.
 */

export class CoverageChecker {
  static checkCoverage(filePaths, blocks = []) {
    const fileCoverageMap = new Map();

    for (const filePath of filePaths) {
      fileCoverageMap.set(filePath, {
        path: filePath,
        coveredByBlocks: [],
        symbolsCovered: [],
      });
    }

    for (const block of blocks) {
      for (const ref of block.artifactRefs || []) {
        const anchorKind = ref.anchorKind || (ref.symbol ? 'symbol' : 'file');
        const hasHash = typeof ref.hash === 'string' && ref.hash.trim() && ref.hash !== 'untracked';
        const hasSymbol = typeof ref.symbol === 'string' && ref.symbol.trim() && ref.symbol !== '*';
        if (!ref.path || !hasHash || (anchorKind === 'symbol' && !hasSymbol)) continue;
        for (const [filePath, entry] of fileCoverageMap.entries()) {
          if (!bindingMatchesPath(ref.path, anchorKind, filePath)) continue;
          if (!entry.coveredByBlocks.includes(block.id)) {
            entry.coveredByBlocks.push(block.id);
          }
          if (ref.symbol && !entry.symbolsCovered.includes(ref.symbol)) {
            entry.symbolsCovered.push(ref.symbol);
          }
        }
      }
    }

    const coveredFiles = [];
    const uncoveredFiles = [];
    const gaps = [];

    for (const [filePath, entry] of fileCoverageMap.entries()) {
      if (entry.coveredByBlocks.length > 0) {
        coveredFiles.push(entry);
      } else {
        uncoveredFiles.push(filePath);
        gaps.push({
          path: filePath,
          reason: 'No Block currently owns this code file.',
        });
      }
    }

    const totalCount = filePaths.length;
    const coveredCount = coveredFiles.length;
    const coveragePercent = totalCount > 0 ? Number(((coveredCount / totalCount) * 100).toFixed(1)) : 100;

    return {
      totalFiles: totalCount,
      coveredFiles: coveredCount,
      uncoveredFiles: uncoveredFiles.length,
      coveragePercent,
      isFullyCovered: uncoveredFiles.length === 0,
      coveredList: coveredFiles,
      uncoveredList: uncoveredFiles,
      gaps,
    };
  }
}

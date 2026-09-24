import { bindingMatchesPath, normalizeBindingPath } from './bindings.mjs';

/**
 * Coverage checker: Calculates project or task working set Block coverage.
 * Detects orphan code and coverage gaps.
 */

export class CoverageChecker {
  static checkCoverage(filePaths, blocks = []) {
    const fileCoverageMap = new Map();

    for (const filePath of filePaths) {
      fileCoverageMap.set(normalizeBindingPath(filePath), {
        path: filePath,
        coveredByBlocks: new Set(),
        symbolsCovered: new Set(),
      });
    }

    for (const block of blocks) {
      for (const ref of block.artifactRefs || []) {
        const anchorKind = ref.anchorKind || (ref.symbol ? 'symbol' : 'file');
        const hasHash = typeof ref.hash === 'string' && ref.hash.trim() && ref.hash !== 'untracked';
        const hasSymbol = typeof ref.symbol === 'string' && ref.symbol.trim() && ref.symbol !== '*';
        if (!ref.path || !hasHash || (anchorKind === 'symbol' && !hasSymbol)) continue;

        const applyCoverage = (entry) => {
          entry.coveredByBlocks.add(block.id);
          if (hasSymbol) entry.symbolsCovered.add(ref.symbol);
        };

        if (anchorKind === 'tree') {
          for (const entry of fileCoverageMap.values()) {
            if (bindingMatchesPath(ref.path, anchorKind, entry.path)) applyCoverage(entry);
          }
        } else {
          const entry = fileCoverageMap.get(normalizeBindingPath(ref.path));
          if (entry) applyCoverage(entry);
        }
      }
    }

    const coveredFiles = [];
    const uncoveredFiles = [];
    const gaps = [];

    for (const entry of fileCoverageMap.values()) {
      const result = {
        path: entry.path,
        coveredByBlocks: Array.from(entry.coveredByBlocks),
        symbolsCovered: Array.from(entry.symbolsCovered),
      };
      if (result.coveredByBlocks.length > 0) {
        coveredFiles.push(result);
      } else {
        uncoveredFiles.push(result.path);
        gaps.push({
          path: result.path,
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

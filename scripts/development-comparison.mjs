import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
const median = (values) => { const v = [...values].sort((a,b) => a-b); return v.length % 2 ? v[(v.length-1)/2] : (v[v.length/2-1]+v[v.length/2])/2; };
const fields = ['inputTokens', 'totalTokens', 'uncachedInputTokens', 'peakRequestInputTokens'];
export function compareDevelopment(runs, { minimumPairs = 3, totalSavings = 0.2, peakSavings = 0.1 } = {}) {
  const groups = new Map(), excluded = [], pairs = [];
  for (const run of runs) {
    if (!run.pairId) { excluded.push({ arm: run.arm, reason: 'Unpaired smoke or legacy run' }); continue; }
    if (!groups.has(run.pairId)) groups.set(run.pairId, []);
    groups.get(run.pairId).push(run);
  }
  for (const [id, rows] of groups) {
    const native = rows.find((r) => r.arm === 'native'), os = rows.find((r) => r.arm === 'contextos');
    const errors = [];
    if (rows.length !== 2 || !native || !os) errors.push('Exactly one complete native/OS pair is required');
    if (rows.some((r) => !r.validForComparison || !r.accountingMatches || !r.quality?.pass || !r.scopePass)) errors.push('Incomplete accounting or failed task quality');
    if (native && os) {
      for (const key of ['baseCommit','promptSha256','model','effort','cliVersion','provider','task','inputTree']) {
        if (!native[key] || native[key] !== os[key]) errors.push('Missing or mismatched ' + key);
      }
      if (native.model !== 'gpt-6-luna' || native.effort !== 'max') errors.push('Unsupported evaluation model');
      if (!native.scenario || JSON.stringify(native.scenario) !== JSON.stringify(os.scenario)) errors.push('Missing or mismatched scenario');
      for (const key of ['bundleSha256','skillSha256','version']) {
        if (!native.candidateSnapshot?.[key] || native.candidateSnapshot[key] !== os.candidateSnapshot?.[key]) errors.push('Missing or mismatched candidate ' + key);
      }
      for (const key of fields) if (!(native.metrics?.[key] > 0) || !(os.metrics?.[key] >= 0)) errors.push('Missing metric ' + key);
      if (!(native.elapsedSeconds > 0) || !(os.elapsedSeconds > 0)) errors.push('Missing elapsed time');
    }
    if (errors.length) { excluded.push({ pairId:id, reason:[...new Set(errors)].join('; ') }); continue; }
    const savings = Object.fromEntries(fields.map((key) => [key, 1-os.metrics[key]/native.metrics[key]]));
    savings.elapsedSeconds = 1-os.elapsedSeconds/native.elapsedSeconds;
    pairs.push({ pairId:id, task:native.task, scenario:native.scenario, candidateSnapshot:native.candidateSnapshot, native:native.metrics, contextos:os.metrics, savings });
  }
  const medians = pairs.length ? Object.fromEntries([...fields,'elapsedSeconds'].map((key) => [key,median(pairs.map((p) => p.savings[key]))])) : null;
  const gates = { sameCandidate:pairs.length > 0 && new Set(pairs.map((p) => JSON.stringify(p.candidateSnapshot))).size === 1, completePairs:pairs.length >= minimumPairs, matchedGroups:excluded.every((r) => !r.pairId),
    totalTokens:medians !== null && medians.totalTokens >= totalSavings,
    peakContext:medians !== null && medians.peakRequestInputTokens >= peakSavings,
    uncachedInput:medians !== null && medians.uncachedInputTokens >= 0,
    regressionGuard:pairs.length > 0 && pairs.every((p) => p.savings.totalTokens >= -0.1),
    taskDiversity:new Set(pairs.map((p) => p.task)).size >= 3,
    repoDiversity:new Set(pairs.map((p) => p.scenario?.repo).filter(Boolean)).size >= 2,
    longSession:pairs.some((p) => p.scenario?.kind === 'long-session' && groups.get(p.pairId).every((r) => r.quality?.resume?.pass === true) && groups.get(p.pairId).some((r) => r.tools?.compactionRecords > 0)) };
  return { schemaVersion:1, qualified:Object.values(gates).every(Boolean), thresholds:{minimumPairs,totalSavings,peakSavings,maximumPairRegression:0.1}, gates, pairs, excluded, medianSavings:medians,
    limitations:['Provider usage counts are not currency.','Only completed matched pairs contribute to savings.','Small samples do not establish universal savings.','Long-session qualification requires observed compaction and independent resume validation.'] };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const runs = process.argv.slice(2).flatMap((file) => { const r = JSON.parse(fs.readFileSync(file)); return r.results || [r]; });
  console.log(JSON.stringify(compareDevelopment(runs),null,2));
}

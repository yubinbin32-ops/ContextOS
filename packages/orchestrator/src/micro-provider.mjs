export const MICRO_COST_WEIGHTS = Object.freeze({
  cachedInput: 0.1,
  uncachedInput: 2,
  output: 10,
});
export const MICRO_WORKER_COST_DIVISOR = 7;
export const MICRO_COST_FORMULA = 'cached input * 0.1 + uncached input * 2 + output * 10; api-micro and cli-agent divide the result by 7';

function finiteCount(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

export function weightedCostTokens(usage = {}) {
  const prompt = finiteCount(usage.prompt_tokens ?? usage.inputTokens ?? usage.input_tokens);
  const output = finiteCount(usage.completion_tokens ?? usage.outputTokens ?? usage.output_tokens);
  const cachedReported = finiteCount(usage.cached_input_tokens ?? usage.cachedInputTokens);
  const uncachedReported = finiteCount(usage.uncached_input_tokens ?? usage.uncachedInputTokens);
  const derivedCached = prompt !== null && uncachedReported !== null ? prompt - uncachedReported : null;
  const derivedUncached = prompt !== null && cachedReported !== null ? prompt - cachedReported : null;
  const cached = cachedReported ?? derivedCached;
  const uncached = uncachedReported ?? derivedUncached;
  if (cached === null || uncached === null || output === null || cached < 0 || uncached < 0) return null;
  return cached * MICRO_COST_WEIGHTS.cachedInput
    + uncached * MICRO_COST_WEIGHTS.uncachedInput
    + output * MICRO_COST_WEIGHTS.output;
}

export function mainEquivalentCostTokens(usage = {}, role = 'api-micro') {
  const weighted = weightedCostTokens(usage);
  if (weighted === null) return null;
  return weighted / (role === 'main' ? 1 : MICRO_WORKER_COST_DIVISOR);
}

export function selectMicroProvider(config = {}, options = {}) {
  const pinned = options.provider ?? (['api', 'cli'].includes(config.provider) ? config.provider : null);
  if (pinned) {
    if (!['api', 'cli'].includes(pinned)) return { ok: false, error: 'Micro provider must be api or cli.' };
    return { ok: true, provider: pinned, reason: 'explicit provider' };
  }
  return { ok: true, provider: 'api', reason: 'API Micro is the default semantic evidence role' };
}

export function microCostEstimate(result, config = {}) {
  void config;
  const usage = result.providerUsage || result.usage || {};
  const rawTokens = finiteCount(usage?.total_tokens ?? usage?.totalTokens);
  const weightedCost = weightedCostTokens(usage);
  if (weightedCost === null) return { ...result };
  return {
    ...result,
    costEstimate: {
      ...(result.providerUsageComplete === false ? { complete: false } : {}),
      rawTokens,
      weightedCostTokens: weightedCost,
      workerDivisor: MICRO_WORKER_COST_DIVISOR,
      mainEquivalentTokens: weightedCost / MICRO_WORKER_COST_DIVISOR,
      weights: MICRO_COST_WEIGHTS,
      formula: MICRO_COST_FORMULA,
      assumption: 'weighted main-token equivalent; not an actual provider bill',
    },
  };
}

import { cliDoctor } from './micro-cli.mjs';

export function selectMicroProvider(config = {}, options = {}) {
  const pinned = options.provider || (!config.priority && config.provider);
  if (pinned) {
    if (!['api', 'cli'].includes(pinned)) return { ok: false, error: 'Micro provider must be api or cli.' };
    return { ok: true, provider: pinned, reason: 'explicit provider', priority: null };
  }
  if (config.priority && !['cli-first', 'api-first'].includes(config.priority)) return { ok: false, error: 'micro.priority must be cli-first or api-first.' };
  if (!config.priority && !config.cli?.command) return { ok: true, provider: 'api', reason: 'legacy API configuration', priority: null };
  const order = config.priority === 'api-first' ? ['api', 'cli'] : ['cli', 'api'];
  const available = { api: Boolean(options.url || config.api?.url || config.url), cli: cliDoctor({ ...config, model: options.model || config.cli?.model || config.model }).ok };
  const provider = order.find(name => available[name]);
  return provider ? { ok: true, provider, priority: config.priority || 'cli-first', reason: available[order[0]] ? 'preferred provider is locally configured' : 'preferred provider unavailable before dispatch' }
    : { ok: false, error: 'No locally configured Micro provider. Configure API URL/model or a CLI adapter.' };
}

export function microCostEstimate(result, config = {}) {
  const divisor = Number(config.cost?.tokenDivisor ?? 1);
  const total = result.providerUsage?.total_tokens;
  return {
    ...result,
    ...(total != null && Number.isFinite(divisor) && divisor > 0 ? { costEstimate: {
      rawTokens: total, tokenDivisor: divisor, mainEquivalentTokens: total / divisor,
      assumption: divisor === 1 ? 'unweighted tokens' : 'user-configured relative token price; not an actual bill',
    } } : {}),
  };
}

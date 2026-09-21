/**
 * Intent classification for the V3 ingress surface.
 *
 * The router is deliberately deterministic (keyword + structural scoring, no model
 * call): the OS must decide what to run in microseconds, and it stays debuggable
 * through the session trace.
 */

export const INTENTS = ['explore', 'change', 'verify', 'ship', 'system'];

const INTENT_HINTS = {
  ship: [
    ['完成', 3], ['收尾', 3], ['完结', 3], ['结束', 2], ['提交', 2], ['同步', 2], ['交付', 3],
    ['ship', 4], ['done', 4], ['finish', 3], ['commit', 2], ['close out', 3], ['wrap up', 3],
  ],
  verify: [
    ['测试', 3], ['跑一下', 3], ['跑测试', 4], ['验证', 3], ['构建', 2], ['编译', 2], ['检查', 2],
    ['test', 4], ['verify', 4], ['build', 3], ['lint', 3], ['check', 2], ['run ', 2],
  ],
  change: [
    ['修改', 4], ['改成', 4], ['修复', 4], ['修一下', 4], ['新增', 3], ['添加', 3], ['实现', 4],
    ['重构', 4], ['删除', 3], ['改名', 3], ['重写', 3],
    ['fix', 4], ['add', 3], ['implement', 4], ['refactor', 4], ['update', 2], ['remove', 3],
    ['rename', 3], ['edit', 3], ['patch', 3],
  ],
  explore: [
    ['看看', 3], ['了解', 3], ['理解', 3], ['定位', 3], ['在哪', 3], ['为什么', 3], ['谁调用', 3],
    ['架构', 3], ['继续', 2], ['恢复', 3], ['接着', 2],
    ['explain', 3], ['understand', 3], ['find', 2], ['where', 3], ['why', 3], ['locate', 3],
    ['resume', 3], ['explore', 4], ['how does', 3],
  ],
};

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'into', 'when', 'then', 'file', 'code',
  'should', 'would', 'need', 'make', 'please', 'help', 'want', 'using', 'about', 'their',
]);

const PATH_EXTENSIONS = 'mjs|cjs|js|jsx|ts|tsx|py|swift|go|rs|java|kt|rb|php|c|h|cpp|cs|md|json|toml|yml|yaml|sql|sh';

export function classifyIntent(text = '', hints = {}) {
  const haystack = String(text).toLowerCase();
  const scores = {};
  for (const intent of Object.keys(INTENT_HINTS)) {
    let score = 0;
    const signals = [];
    for (const [needle, weight] of INTENT_HINTS[intent]) {
      if (haystack.includes(needle)) {
        score += weight;
        signals.push(needle.trim());
      }
    }
    scores[intent] = { score, signals };
  }

  // Structural hints beat keywords: they come from the arguments, not the prose.
  if (hints.hasEdits || hints.hasCreate) scores.change.score += 6;
  if (hints.hasCommands) scores.verify.score += 6;
  if (hints.hasSummary) scores.ship.score += 5;
  if (hints.capability) scores.system.score += 10;

  let intent = 'explore';
  let best = 0;
  for (const [name, value] of Object.entries(scores)) {
    if (value.score > best) {
      best = value.score;
      intent = name;
    }
  }

  return { intent, confidence: best, signals: scores[intent].signals, scores };
}

export function tokenize(text = '') {
  const tokens = new Set();
  const source = String(text);
  for (const word of source.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) || []) {
    if (!STOP_WORDS.has(word)) tokens.add(word);
  }
  // Chinese has no spaces: fall back to character bigrams for overlap scoring.
  for (const run of source.match(/[\u4e00-\u9fff]{2,}/g) || []) {
    for (let i = 0; i < run.length - 1; i += 1) tokens.add(run.slice(i, i + 2));
  }
  return tokens;
}

export function extractPaths(text = '') {
  const source = String(text);
  const found = new Set();
  const slashMatch = source.match(/(?:[\w.-]+[/\\])+[\w.-]+/g) || [];
  const fileMatch = source.match(new RegExp(`[\\w.-]+\\.(?:${PATH_EXTENSIONS})\\b`, 'g')) || [];
  for (const candidate of [...slashMatch, ...fileMatch]) {
    const clean = candidate.replace(/^[("'`]+|[)"'`.,;:]+$/g, '');
    if (!clean || /^(https?|www)\b/.test(clean)) continue;
    found.add(clean);
  }
  // `database.mjs` and `packages/storage/src/database.mjs` are the same file:
  // keep the most specific spelling only.
  const paths = Array.from(found);
  return paths
    .filter((candidate) => !paths.some((other) => other !== candidate && other.endsWith(`/${candidate}`)))
    .slice(0, 8);
}

export function extractIdentifiers(text = '') {
  const source = String(text);
  const found = [];
  const seen = new Set();
  for (const word of source.match(/\b[A-Za-z_][A-Za-z0-9_]{3,}\b/g) || []) {
    if (STOP_WORDS.has(word.toLowerCase())) continue;
    const isSnake = word.includes('_');
    const isCamel = /[a-z][A-Z]/.test(word);
    if (!isSnake && !isCamel) continue;
    if (seen.has(word)) continue;
    seen.add(word);
    found.push(word);
  }
  return found.slice(0, 6);
}

export function extractCommands(text = '') {
  const source = String(text);
  const found = new Set();
  for (const match of source.matchAll(/`([^`]{2,80})`/g)) {
    const value = match[1].trim();
    if (/^(npm|node|pnpm|yarn|bun|swift|go|cargo|python3?|pytest|make|git)\b/.test(value)) {
      found.add(value);
    }
  }
  return Array.from(found).slice(0, 5);
}

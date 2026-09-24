import fs from 'node:fs';
import path from 'node:path';
import { fitSections, resolveBudget } from './context-budget.mjs';
import { observe } from './observer.mjs';
import { ModuleIndex } from './module-index.mjs';
import { extractIdentifiers, extractPaths, tokenize } from './intent-router.mjs';
import { redactSecrets } from '../../process-host/src/sanitizer.mjs';
import { CodeTools } from '../../code-intel/src/code-tools.mjs';

const OUTLINE_CLIP = 1200;
const SEARCH_CLIP = 360;

function compactOutlineData(text) {
  if (typeof text !== 'string') return '';
  const lines = text.split(/\r?\n/);
  const symbols = [];
  for (const line of lines) {
    const trimmed = line.trim();
    const match = trimmed.match(/^[-*]\s+\*\*([a-zA-Z]+)\*\*\s+`([^`]+)`\s+\[(L\d+-L\d+)\]/);
    if (match) {
      const [, kind, name, range] = match;
      symbols.push(`${kind} ${name} ${range}`);
    }
  }
  if (symbols.length) {
    const slice = symbols.slice(0, 8);
    return `(${slice.join(', ')}${symbols.length > 8 ? ` +${symbols.length - 8}` : ''})`;
  }
  return clip(text, 200);
}

function clip(text, max, { withHint = false } = {}) {
  const value = typeof text === 'string' ? text : JSON.stringify(text, null, 2);
  if (max === Infinity || value.length <= max) return value;
  const hint = withHint
    ? '\n[TRUNCATED: budget exceeded. Action required: specify \'ranges: [{startLine, endLine}]\' or pass \'budget: "full"\' to receive the entire content]'
    : '';
  const cutLen = Math.max(0, max - 24 - hint.length);
  return `${value.slice(0, cutLen)}\n... (+${value.length - cutLen} chars omitted)${hint}`;
}

function stringify(value) {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

function countOccurrences(content, target) {
  if (typeof content !== 'string' || typeof target !== 'string' || !target) return 0;
  let count = 0;
  let offset = 0;
  while ((offset = content.indexOf(target, offset)) !== -1) {
    count += 1;
    offset += target.length;
  }
  return count;
}

function resolvePreviewPath(projectRoot, inputPath) {
  if (typeof inputPath !== 'string' || !inputPath) {
    return { error: 'path is required' };
  }
  const fullPath = path.resolve(projectRoot, inputPath);
  const relativePath = path.relative(projectRoot, fullPath).split(path.sep).join('/');
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return { error: `path '${inputPath}' is outside project root` };
  }
  return { fullPath, relativePath };
}

function previewEdit(projectRoot, spec = {}, store = null) {
  let specPath = spec.path;
  let specSymbol = spec.symbol;
  if (spec.slot && store) {
    const slotData = store.getSlot(spec.slot);
    if (slotData) {
      specPath = slotData.path || specPath;
      specSymbol = slotData.symbol || specSymbol;
    }
  }
  const resolved = resolvePreviewPath(projectRoot, specPath);
  const fallback = {
    filePath: resolved.relativePath || specPath || '(missing)',
    before: typeof spec.target === 'string' ? spec.target : '',
    after: typeof spec.replacement === 'string' ? spec.replacement : (spec.append || ''),
    matches: 0,
    unique: false,
  };
  if (resolved.error) return { ...fallback, error: resolved.error };
  if (!fs.existsSync(resolved.fullPath)) return { ...fallback, error: 'file not found' };

  if (spec.fullFile) {
    const content = fs.readFileSync(resolved.fullPath, 'utf8');
    return {
      filePath: resolved.relativePath,
      before: content,
      after: spec.replacement ?? '',
      matches: 1,
      unique: true,
      scope: 'fullFile',
    };
  }

  if (spec.append) {
    return {
      filePath: resolved.relativePath,
      before: '(end of file)',
      after: spec.append,
      matches: 1,
      unique: true,
      scope: 'append',
    };
  }

  try {
    const content = fs.readFileSync(resolved.fullPath, 'utf8');
    const target = typeof spec.target === 'string' ? spec.target : '';
    let before = target;
    let scopeLabel = null;
    if (spec.startLine !== undefined || spec.endLine !== undefined) {
      const lines = content.split(/\r?\n/);
      const startLine = Math.max(1, Math.min(Number(spec.startLine) || 1, lines.length));
      const endLine = Math.max(startLine, Math.min(Number(spec.endLine) || lines.length, lines.length));
      if (!before) before = lines.slice(startLine - 1, endLine).join('\n');
      scopeLabel = `L${startLine}-L${endLine}`;
    }

    CodeTools.edit(resolved.relativePath, content, {
      targetContent: target || null,
      replacementContent: spec.replacement ?? '',
      startLine: spec.startLine ?? null,
      endLine: spec.endLine ?? null,
      symbol: specSymbol ?? null,
      append: spec.append ?? null,
    });

    const matches = target ? countOccurrences(content, target) : 1;
    return {
      ...fallback,
      before,
      after: spec.replacement ?? '',
      matches,
      unique: matches === 1,
      scope: scopeLabel,
    };
  } catch (error) {
    return { ...fallback, error: error.message };
  }
}

function renderEditPreview(preview, index) {
  const matchLabel = `${preview.matches} match${preview.matches === 1 ? '' : 'es'}`;
  const lines = [
    `### Edit ${index + 1}`,
    `- File: \`${preview.filePath}\``,
    `- Target unique: ${preview.unique ? 'true' : 'false'} (${matchLabel}${preview.scope ? ` in ${preview.scope}` : ''})`,
  ];
  if (preview.error) lines.push(`- Error: ${preview.error}`);
  lines.push(
    '- Before:',
    '```text',
    preview.before,
    '```',
    '- After:',
    '```text',
    preview.after,
    '```'
  );
  return lines.join('\n');
}

function overlapScore(tokens, text) {
  if (!tokens.size) return 0;
  const haystack = tokenize(text);
  let score = 0;
  for (const token of tokens) {
    if (haystack.has(token)) score += 1;
  }
  return score;
}

function decisionHeadings(projectRoot, limit = 3) {
  const docPath = path.join(projectRoot, 'DECISION.md');
  if (!fs.existsSync(docPath)) return [];
  try {
    const content = fs.readFileSync(docPath, 'utf8');
    const matches = content.match(/^## \[(DEC-\d+)\]\s+(.+)$/gm) || [];
    return matches.slice(-limit).map((line) => line.replace(/^##\s+/, '- '));
  } catch (_) {
    return [];
  }
}

function suggestVerify(profile) {
  return profile.verify.length ? profile.verify[0] : null;
}

function receiptStatus(receipt) {
  if (receipt.exitCode === 0) return 'passed';
  return receipt.status === 'superseded' ? 'superseded' : 'unresolved';
}

// Chinese intents carry latin keywords ("coverage", "sync") that never look
// like identifiers but are still worth one workspace symbol search.
// Words that are already part of a supplied path are skipped: searching for
// "packages" only returns noise.
function latinQueries(text = '', exclude = '') {
  const haystack = String(exclude).toLowerCase();
  return Array.from(tokenize(text))
    .filter((token) => /^[a-z][a-z0-9_-]{4,}$/.test(token))
    .filter((token) => !haystack.includes(token))
    .slice(0, 2);
}

function computeNext({ session, changedCount, profile, stage, intent = '' }) {
  const receipts = session?.receipts || [];
  const green = receipts.some((receipt) => receipt.exitCode === 0);
  const editedHere = (session?.touchedFiles || []).some((entry) => entry.source === 'edit');

  if (stage === 'change' || (editedHere && !green)) {
    const command = suggestVerify(profile);
    return command
      ? `verify(${JSON.stringify({ commands: [command] })})`
      : 'verify({"commands":["<your command>"]}) — set `verify` in .contextos/profile.json to auto-infer';
  }
  if (green) return `ship(${JSON.stringify({ summary: '<what changed and why>' })})`;
  if (changedCount > 0) {
    const command = suggestVerify(profile);
    return command
      ? `verify(${JSON.stringify({ commands: [command] })}) — dirty files exist with no receipt yet`
      : 'verify({"commands":["<your command>"]}) — dirty files exist with no receipt yet';
  }
  return `change(${JSON.stringify({ intent: intent || '<what you want to change>' })}) — pass edits: [{ path, target, replacement }]`;
}

export async function explorePipeline(ctx, input = {}) {
  const { caps, store, tracer, projectRoot, profile } = ctx;
  const intent = input.intent || '';

  const obs = await observe({ projectRoot, store });
  const session = store.ensureSession(intent);
  tracer.step('observe', { gitAvailable: obs.gitAvailable, reconciled: obs.reconciled });

  const explicitPaths = Array.isArray(input.paths) ? input.paths.filter(Boolean) : [];
  const paths = explicitPaths.length ? explicitPaths : extractPaths(intent);
  const identifiers = extractIdentifiers(intent);
  const tokens = tokenize(`${intent} ${paths.join(' ')} ${identifiers.join(' ')}`);

  const dirty = [...obs.untracked, ...obs.changed];
  const systemChanged = (obs.systemChanged || []).filter(
    (p) => !p.endsWith('.sqlite') && !p.endsWith('.sqlite-shm') && !p.endsWith('.sqlite-wal')
  );
  const nowLines = [
    `- Session: \`${session.id}\` (${session.status})`,
    `- Intent: ${intent || '(none yet)'}`,
    `- Code git dirty: ${dirty.length ? dirty.slice(0, 8).map((p) => `\`${p}\``).join(', ') : 'clean'}${dirty.length > 8 ? ` (+${dirty.length - 8})` : ''}`,
    `- OS state dirty: ${systemChanged.length ? systemChanged.slice(0, 8).map((p) => `\`${p}\``).join(', ') : 'clean'}${systemChanged.length > 8 ? ` (+${systemChanged.length - 8})` : ''}`,
  ];
  if (session.touchedFiles.length) {
    const recentTouches = [...session.touchedFiles]
      .filter((entry) => entry.lastTouchedAt || entry.firstSeenAt)
      .sort((a, b) => Date.parse(b.lastTouchedAt || b.firstSeenAt) - Date.parse(a.lastTouchedAt || a.firstSeenAt))
      .slice(0, 6);
    if (recentTouches.length) {
      nowLines.push(`- Session touch history: ${recentTouches.map((entry) => `\`${entry.path}\` (${entry.source}, ${(entry.lastTouchedAt || entry.firstSeenAt).slice(11, 19)}Z)`).join(', ')}`);
    }
  }
  if (session.receipts.length) {
    const last = session.receipts[session.receipts.length - 1];
    const olderFailed = session.receipts.slice(0, -1).filter((r) => r.exitCode !== 0 && r.status !== 'superseded');
    const maskInfo = olderFailed.length > 0 ? ` (${olderFailed.length} older failed receipt${olderFailed.length > 1 ? 's' : ''} masked)` : '';
    nowLines.push(`- Last receipt: \`${last.command}\` exit ${last.exitCode} (${last.id || 'n/a'}, ${receiptStatus(last)})${maskInfo}`);
  }
  if (session.touchedFiles.length >= 6 || session.receipts.length >= 5) {
    nowLines.push(`💡 [Context Health] State safely saved in OS blackboard (.contextos/blackboard.md). You can /clear anytime; call explore() to resume in ~150 tokens.`);
  }

  const whereLines = [];

  // Derived modules come first: they are computed from the AST, so they exist
  // even when nobody curated a Block.
  const index = new ModuleIndex({ projectRoot });
  index.bootstrapIfEmpty();
  index.ensure([...paths, ...dirty].slice(0, 12));

  // Paths may point at a directory: expand it into the module's real files
  // instead of asking the AST engine to outline a folder.
  const resolvedPaths = [];
  for (const target of paths) {
    const fullPath = path.join(projectRoot, target);
    if (!fs.existsSync(fullPath)) continue;
    if (fs.statSync(fullPath).isDirectory()) {
      for (const file of index.entries.keys()) {
        if (file.startsWith(`${target.replace(/\/+$/, '')}/`) && !file.includes('node_modules')) {
          resolvedPaths.push(file);
        }
      }
    } else {
      resolvedPaths.push(target);
    }
  }

  const modules = index.lookup(`${intent} ${paths.join(' ')}`);
  for (const module of modules) {
    const files = module.files.slice(0, 3).map((file) => `\`${file}\``).join(', ');
    whereLines.push(`- **${module.id}** (${module.directory}) — ${files}${module.files.length > 3 ? ` (+${module.files.length - 3})` : ''}`);
    if (resolvedPaths.length < 6) {
      for (const f of module.files) {
        if (!resolvedPaths.includes(f)) resolvedPaths.push(f);
      }
    }
  }
  // If resolvedPaths is still empty (e.g. non-English intent, vague prompt, or fresh workspace),
  // fallback to the top source files in index.entries so the agent is never left blind.
  if (resolvedPaths.length === 0 && index.entries.size > 0) {
    const allFiles = Array.from(index.entries.keys()).filter((f) => !f.includes('node_modules'));
    const srcFiles = allFiles.filter((f) => f.startsWith('src/') || f.startsWith('lib/') || f.startsWith('packages/'));
    const candidates = srcFiles.length > 0 ? srcFiles : allFiles;
    for (const f of candidates.slice(0, 5)) {
      resolvedPaths.push(f);
    }
  }

  const filePaths = Array.from(new Set(resolvedPaths)).slice(0, 6);

  if (filePaths.length) {
    for (const target of filePaths) {
      const outline = await caps.code({ action: 'outline', path: target });
      if (outline.ok) {
        if (input.depth === 'deep') {
          whereLines.push(`- \`${target}\`\n${clip(outline.data, OUTLINE_CLIP)}`);
        } else {
          whereLines.push(`- \`${target}\` ${compactOutlineData(outline.data)}`);
        }
      } else {
        whereLines.push(`- \`${target}\`: ${outline.error}`);
      }
    }
    tracer.step('outline', { paths: filePaths });
  }

  // Pre-slicing and Action Slots:
  // Provide instant code previews so the agent never suffers from Read-Blindness,
  // and register actionable slots [S1], [S2] to eliminate parameter alignment errors.
  const isQuery = /[?？]/.test(intent) || /(在哪|谁在调用|为什么|怎么实现|在哪里)/.test(intent) || /^(where|who|why|how)\b/i.test(intent.trim());
  const sliceLines = [];
  const slots = {};
  let slotIdx = 1;

  if (!isQuery) {
    for (const target of filePaths.slice(0, 2)) {
      const read = await caps.code({ action: 'read', path: target, startLine: 1, endLine: 40 });
      if (read.ok && read.data) {
        sliceLines.push(`### \`${target}\`\n\`\`\`text\n${clip(read.data, 400)}\n\`\`\``);
        const slotId = `S${slotIdx++}`;
        slots[slotId] = { path: target, action: 'edit' };
      }
    }
  }

  const slotLines = [];
  for (const [sId, sData] of Object.entries(slots)) {
    slotLines.push(`- [${sId}] Edit \`${sData.path}\` -> \`change({ slot: "${sId}", append: "..." })\` or \`change({ slot: "${sId}", symbol: "...", replacement: "..." })\``);
  }
  if (!isQuery && Object.keys(slots).length > 0) {
    const defaultVerify = profile.verify && profile.verify.length ? profile.verify[0] : 'npm test';
    const verifySlotId = `S${slotIdx++}`;
    slots[verifySlotId] = { action: 'verify', command: defaultVerify };
    slotLines.push(`- [${verifySlotId}] Verify -> in-situ in \`change({ verify: "${defaultVerify}" })\` or \`verify({ command: "${defaultVerify}" })\``);
  }

  store.setSlots(slots);

  const blocks = await caps.blocks();
  if (blocks.ok && blocks.data.length) {
    const scored = blocks.data
      .map((block) => ({
        block,
        score: overlapScore(tokens, `${block.title} ${block.summary || ''} ${(block.artifactRefs || []).map((r) => r.path).join(' ')}`),
      }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 2);
    for (const { block } of scored) {
      const refs = Array.from(new Set((block.artifactRefs || []).map((ref) => ref.path))).slice(0, 3);
      whereLines.push(`- curated [${block.id}] **${block.title}** — ${refs.length ? refs.map((p) => `\`${p}\``).join(', ') : 'no refs'}`);
    }
    tracer.step('blocks', { candidates: scored.length, total: blocks.data.length });
  }

  const searchQueries = Array.from(new Set([...identifiers, ...latinQueries(intent, paths.join(" "))]));
  for (const query of searchQueries.slice(0, 3)) {
    const search = await caps.code({ action: 'search', query });
    if (!search.ok) continue;
    whereLines.push(`- symbols \`${query}\`:\n${clip(search.data, SEARCH_CLIP)}`);
  }

  if (!whereLines.length) {
    whereLines.push('- No indexed module matched. Pass `paths` or run `explore({ intent })` after binding blocks via `ops({ capability: "block", action: "bind_auto" })`.');
  }

  const rulesLines = [];
  const rules = await caps.rules();
  if (rules.ok && rules.data.length) {
    const scored = rules.data
      .map((rule) => ({ rule, score: overlapScore(tokens, `${rule.title} ${rule.category} ${rule.summary || ''}`) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);
    for (const { rule } of scored) {
      rulesLines.push(`- \`${rule.id}\` **${rule.title}** (${rule.category}) — ${clip(rule.summary || '', 120)}`);
    }
    rulesLines.push('> Full text on demand: `ops({ capability: "knowledge", action: "rule_open", args: { ruleId: "..." } })`');
  }

  const memoryLines = [];
  for (const note of (session.notes || []).slice(-3)) {
    memoryLines.push(`- (${note.kind}) ${clip(note.text, 160)}`);
  }
  for (const past of store.recentHistory(2)) {
    memoryLines.push(`- last session \`${past.id}\`: ${clip(past.summary || past.intent || '', 160)}`);
  }
  const headings = decisionHeadings(projectRoot);
  if (headings.length) memoryLines.push(...headings);

  const nextLines = [`👉 ${computeNext({ session, changedCount: dirty.length, profile, stage: 'explore', intent })}`];

  const budget = resolveBudget(input.depth, ctx.profile?.budget);
  const sections = [
    { key: 'next', title: 'Next', priority: 0, lines: nextLines },
  ];
  if (slotLines.length) {
    sections.push({ key: 'slots', title: 'Available Action Slots (Pick a slot or pass directly)', priority: 1, lines: slotLines });
  }
  sections.push(
    { key: 'where', title: 'Where to look', priority: 2, lines: whereLines },
    { key: 'now', title: 'Now', priority: 3, lines: nowLines }
  );
  if (sliceLines.length) {
    sections.push({ key: 'slices', title: 'Code Slices (Direct Preview)', priority: 4, lines: sliceLines });
  }
  sections.push(
    { key: 'rules', title: 'Applicable rules', priority: 5, lines: rulesLines },
    { key: 'memory', title: 'Memory', priority: 6, lines: memoryLines }
  );

  const { text, meta } = fitSections(sections, { maxChars: budget });

  tracer.step('explore.response', { budget, ...meta });
  return `# ContextOS explore\n\n${text}\n\n<!-- budget ${meta.used}/${meta.maxChars} chars; dropped: ${meta.dropped.join(',') || 'none'} -->`;
}

export async function changePipeline(ctx, input = {}) {
  const { caps, store, tracer, profile } = ctx;
  const creates = Array.isArray(input.create) ? [...input.create] : [];
  const rawEdits = Array.isArray(input.edits) ? [...input.edits] : [];

  if (input.path && typeof input.content === 'string') {
    creates.push({
      path: input.path,
      content: input.content,
      overwrite: input.overwrite ?? true,
    });
  }

  if (input.slot || input.append || input.symbol || input.replacement || input.target || input.fullFile) {
    if (!rawEdits.length && (input.path || input.slot)) {
      rawEdits.push({
        slot: input.slot,
        path: input.path,
        target: input.target,
        replacement: input.replacement,
        symbol: input.symbol,
        append: input.append,
        startLine: input.startLine,
        endLine: input.endLine,
        fullFile: input.fullFile,
      });
    }
  }

  // Resolve slots for each edit
  const edits = rawEdits.map((spec) => {
    let filePath = spec.path;
    let symbol = spec.symbol;
    if (spec.slot) {
      const slotData = store.getSlot(spec.slot);
      if (slotData) {
        filePath = slotData.path || filePath;
        symbol = slotData.symbol || symbol;
      }
    }
    return {
      ...spec,
      path: filePath,
      symbol,
    };
  });
  const resultLines = [];
  const touched = [];

  if (input.dryRun === true) {
    const previewLines = [];

    creates.forEach((spec, index) => {
      const resolved = resolvePreviewPath(ctx.projectRoot, spec?.path);
      if (resolved.error) {
        previewLines.push(`### Create ${index + 1}\n- File: \`${spec?.path || '(missing)'}\`\n- Error: ${resolved.error}`);
        return;
      }
      const exists = fs.existsSync(resolved.fullPath);
      const before = exists ? fs.readFileSync(resolved.fullPath, 'utf8') : '';
      const wouldCreate = exists ? (spec?.overwrite ? 'true (overwrite)' : 'false (file already exists)') : 'true';
      previewLines.push(
        [
          `### Create ${index + 1}`,
          `- File: \`${resolved.relativePath}\``,
          `- Target unique: n/a (create)`,
          `- Would create: ${wouldCreate}`,
          '- Before:',
          '```text',
          before,
          '```',
          '- After:',
          '```text',
          spec?.content ?? '',
          '```',
        ].join('\n')
      );
    });

    edits.forEach((spec, index) => {
      previewLines.push(renderEditPreview(previewEdit(ctx.projectRoot, spec, store), index));
    });

    if (!previewLines.length) {
      previewLines.push('No edits or creates supplied.');
    }

    const { text } = fitSections(
      [{ key: 'preview', title: 'Preview', priority: 0, lines: previewLines }],
      { maxChars: resolveBudget(input.depth, ctx.profile?.budget) }
    );
    return `# ContextOS change (dry run)\n\n${text}`;
  }

  if (!creates.length && !edits.length) {
    const targets = (Array.isArray(input.paths) && input.paths.length ? input.paths : extractPaths(input.intent || '')).slice(0, 2);
    const previewLines = [];
    for (const target of targets) {
      const read = await caps.code({ action: 'read', path: target, startLine: 1, endLine: 60 });
      previewLines.push(read.ok ? `- \`${target}\`\n${clip(read.data, OUTLINE_CLIP)}` : `- \`${target}\`: ${read.error}`);
    }
    if (!previewLines.length) {
      previewLines.push('Pass `edits: [{ path, target, replacement }]` or `create: [{ path, content }]`, or call `explore` first to locate the target.');
    }
    const { text } = fitSections(
      [
        { key: 'next', title: 'Next', priority: 0, lines: ['👉 change({ edits: [{ path, target, replacement }] })'] },
        { key: 'preview', title: 'Preview', priority: 1, lines: previewLines },
      ],
      { maxChars: resolveBudget(input.depth, ctx.profile?.budget) }
    );
    return `# ContextOS change (propose)\n\n${text}`;
  }

  const changes = [
    ...creates.map((spec) => ({
      kind: 'create',
      path: spec?.path,
      content: spec?.content ?? '',
      overwrite: Boolean(spec?.overwrite),
    })),
    ...edits.map((spec) => ({
      kind: 'edit',
      path: spec?.path,
      target: spec?.target,
      replacement: spec?.replacement ?? '',
      startLine: spec?.startLine,
      endLine: spec?.endLine,
      symbol: spec?.symbol,
      append: spec?.append,
      fullFile: Boolean(spec?.fullFile),
    })),
  ];

  const backups = new Map();
  if (input.autoRevert === true && input.verify) {
    for (const edit of edits) {
      if (!edit?.path) continue;
      const fullPath = path.resolve(ctx.projectRoot, edit.path);
      if (fs.existsSync(fullPath) && !backups.has(fullPath)) {
        try {
          backups.set(fullPath, fs.readFileSync(fullPath, 'utf8'));
        } catch (_) {}
      }
    }
  }

  const changeset = await caps.code({ action: 'changeset', changes, format: 'json' });
  if (!changeset.ok) {
    tracer.step('changeset', { ok: false, error: changeset.error });
    resultLines.push(`- ✗ changeset rejected: ${changeset.error}`);
    const { text } = fitSections(
      [
        { key: 'next', title: 'Next', priority: 0, lines: ['Fix the changeset error, then retry `change`; no files were modified.'] },
        { key: 'result', title: 'Result', priority: 1, lines: resultLines },
      ],
      { maxChars: resolveBudget(input.depth, ctx.profile?.budget) }
    );
    return `# ContextOS change\n\n${text}`;
  }

  const changedFiles = Array.isArray(changeset.data?.files) ? changeset.data.files : [];
  for (const file of changedFiles) {
    const action = file.created ? 'created' : 'edited';
    resultLines.push(`- ${action} \`${file.path}\` (hash ${file.newHash || 'n/a'}, ${(file.locators || []).length} locators re-anchored)`);
    touched.push(file.path);
  }
  tracer.step('changeset', { ok: true, files: touched });

  let session = store.touch(touched, 'edit');
  const verifyLines = [];
  const failureLines = [];
  let verifyPassed = true;

  if (input.verify) {
    const verifyCommands = input.verify === true
      ? profile.verify
      : (Array.isArray(input.verify) ? input.verify : [input.verify]);

    if (verifyCommands && verifyCommands.length) {
      for (const cmd of verifyCommands) {
        const res = await caps.run({
          command: cmd,
          cwd: input.cwd,
          timeoutMs: input.timeoutMs ?? profile.timeoutMs,
        });
        if (!res.ok) {
          verifyPassed = false;
          verifyLines.push(`- \`${cmd}\` → ✗ ${res.error}`);
          continue;
        }
        const receipt = res.data;
        store.attachReceipt(receipt);
        session = store.current;
        const label = redactSecrets(cmd);
        verifyLines.push(`- \`${label}\` → exit ${receipt.exitCode} (${receipt.durationMs}ms, receipt ${receipt.id})`);
        if (receipt.exitCode !== 0) {
          verifyPassed = false;
          const diag = receipt.diagnostics && receipt.diagnostics.length
            ? receipt.diagnostics.join('\n\n---\n\n')
            : (receipt.errors && receipt.errors.length ? receipt.errors.slice(0, 5).join('\n') : clip(receipt.summary || 'failed', 240));
          failureLines.push(`### \`${label}\`\n${diag}`);
        }
        tracer.step('change_verify', { command: cmd, exitCode: receipt.exitCode });
      }

      if (!verifyPassed && input.autoRevert === true) {
        for (const spec of creates) {
          if (!spec?.path) continue;
          const fullPath = path.resolve(ctx.projectRoot, spec.path);
          if (fs.existsSync(fullPath)) {
            try { fs.rmSync(fullPath, { force: true }); } catch (_) {}
          }
        }
        for (const [fullPath, originalContent] of backups) {
          try { fs.writeFileSync(fullPath, originalContent, 'utf8'); } catch (_) {}
        }
        resultLines.push(`- ↺ autoReverted disk changes due to verify failure`);
      } else if (verifyPassed) {
        resultLines.push('💡 [Milestone Reached] Verification passed. State saved to blackboard (.contextos/blackboard.md). You may /clear anytime; explore() will resume in ~150 tokens.');
      }
    }
  }

  const nextLines = input.verify
    ? (verifyPassed
        ? [`👉 ship(${JSON.stringify({ summary: input.intent || '<what changed and why>' })})`]
        : [`👉 change(${JSON.stringify({ intent: input.intent || '<fix the failure>' })}) to repair and verify again`])
    : [`👉 ${computeNext({ session, changedCount: touched.length, profile, stage: 'change', intent: input.intent })}`];

  const touchedLines = session.touchedFiles.slice(-8).map((entry) => `- \`${entry.path}\` (${entry.source})`);

  const sections = [
    { key: 'next', title: 'Next', priority: 0, lines: nextLines },
    { key: 'result', title: 'Result', priority: 1, lines: resultLines },
  ];
  if (verifyLines.length) {
    sections.push({
      key: 'verdict',
      title: verifyPassed ? 'Verify: PASS' : 'Verify: FAIL',
      priority: 2,
      lines: verifyLines,
    });
  }
  if (failureLines.length) {
    sections.push({ key: 'failures', title: 'Failures', priority: 3, lines: failureLines });
  }
  sections.push({ key: 'touched', title: 'Touched', priority: 4, lines: touchedLines });

  const { text } = fitSections(sections, { maxChars: resolveBudget(input.depth, ctx.profile?.budget) });
  return `# ContextOS change\n\n${text}`;
}

export async function inspectPipeline(ctx, input = {}) {
  const { caps, store } = ctx;
  let targetPath = input.path;
  let symbol = input.symbol;

  if (input.slot) {
    const slotData = store.getSlot(input.slot);
    if (slotData) {
      targetPath = slotData.path || targetPath;
      symbol = slotData.symbol || symbol;
    }
  }

  const requestedBudget = input.budget || input.depth;
  const isFull = requestedBudget === 'full';
  const explicitMaxChars = typeof input.maxChars === 'number' && input.maxChars > 0 ? input.maxChars : null;
  const contentMaxChars = isFull ? Infinity : (explicitMaxChars ?? 2500);

  const paths = Array.isArray(input.paths) && input.paths.length
    ? input.paths
    : (targetPath ? [targetPath] : []);

  if (!paths.length) {
    return '# ContextOS inspect\n\nNo target path provided. Pass `path`, `paths`, or `slot` (e.g. `slot: "S1"`).';
  }

  const isOutline = input.mode === 'outline' || Boolean(input.outline);
  const outLines = [];
  for (let p of paths) {
    const fullP = path.join(ctx.projectRoot, p);
    if (!fs.existsSync(fullP) && fs.existsSync(`${fullP}.log`)) {
      p = `${p}.log`;
    }
    if (isOutline) {
      const outline = await caps.code({
        action: 'outline',
        path: p,
      });
      if (outline.ok) {
        outLines.push(`### \`${p}\` (AST Outline)\n\`\`\`markdown\n${clip(outline.data, contentMaxChars, { withHint: true })}\n\`\`\``);
      } else {
        outLines.push(`### \`${p}\`: ✗ ${outline.error}`);
      }
    } else {
      const read = await caps.code({
        action: 'read',
        path: p,
        symbol: symbol || undefined,
        startLine: input.startLine,
        endLine: input.endLine,
        ranges: input.ranges,
        budget: input.budget,
        maxChars: input.maxChars,
        fullFile: isFull || input.fullFile || false,
      });
      if (read.ok) {
        outLines.push(`### \`${p}\`${symbol ? ` (${symbol})` : ''}\n\`\`\`text\n${clip(read.data, contentMaxChars, { withHint: true })}\n\`\`\``);
      } else {
        outLines.push(`### \`${p}\`: ✗ ${read.error}`);
      }
    }
  }

  const budget = isFull ? Infinity : (explicitMaxChars ?? resolveBudget(requestedBudget, ctx.profile?.budget));
  const { text } = fitSections(
    [{ key: 'inspect', title: 'Inspection Result', priority: 0, lines: outLines }],
    { maxChars: budget }
  );
  return `# ContextOS inspect\n\n${text}`;
}

export async function verifyPipeline(ctx, input = {}) {
  const { caps, store, tracer, profile } = ctx;
  const mode = input.mode || 'once';

  if (mode === 'logs' && input.id && /^[A-Za-z0-9._-]+$/.test(input.id)) {
    const logPath = path.join(ctx.projectRoot, '.contextos', 'logs', `${input.id}.log`);
    if (fs.existsSync(logPath)) {
      const lines = fs.readFileSync(logPath, 'utf8').split(/\r?\n/);
      const filtered = input.grep
        ? lines.filter((line) => line.toLowerCase().includes(String(input.grep).toLowerCase()))
        : lines;
      const limit = Math.max(1, Number(input.lines) || 50);
      const selected = filtered.slice(-limit);
      tracer.step('receipt_logs', { id: input.id, lines: selected.length });
      return `# ContextOS verify (logs)\n\n- Receipt: \`${input.id}\`\n- Log: \`.contextos/logs/${input.id}.log\`\n- Lines: ${selected.length}/${filtered.length}\n\n\`\`\`text\n${selected.join('\n')}\n\`\`\``;
    }
  }

  if (mode !== 'once') {
    const res = await caps.process({
      action: mode === 'serve' ? 'start' : mode,
      command: input.command || (input.commands || [])[0],
      id: input.id,
      lines: input.lines ?? 50,
      grep: input.grep,
    });
    const body = res.ok ? stringify(res.data) : `✗ ${res.error}`;
    tracer.step('process', { mode, ok: res.ok });
    return `# ContextOS verify (${mode})\n\n${clip(body, resolveBudget(input.depth, ctx.profile?.budget))}`;
  }

  // A single `command` is accepted as a one-element list: agents type it far more often than `commands`.
  const explicit = Array.isArray(input.commands) && input.commands.length
    ? input.commands
    : (input.command ? [input.command] : null);
  const commands = explicit || profile.verify;
  if (!commands.length) {
    return '# ContextOS verify\n\nNo verification command available. Pass `command: "npm test"` (or `commands: [...]`) or set `verify` in `.contextos/profile.json`.';
  }

  const commandLines = [];
  const failureLines = [];
  let passed = true;

  for (const command of commands) {
    const res = await caps.run({
      command,
      cwd: input.cwd,
      maxChars: input.maxChars ?? profile.maxChars,
      timeoutMs: input.timeoutMs ?? profile.timeoutMs,
    });
    if (!res.ok) {
      passed = false;
      commandLines.push(`- \`${command}\` → ✗ ${res.error}`);
      continue;
    }
    const receipt = res.data;
    store.attachReceipt(receipt);
    const label = redactSecrets(command);
    commandLines.push(`- \`${label}\` → exit ${receipt.exitCode} (${receipt.durationMs}ms, receipt ${receipt.id})`);
    if (receipt.exitCode !== 0) {
      passed = false;
      const diag = receipt.diagnostics && receipt.diagnostics.length
        ? receipt.diagnostics.join('\n\n---\n\n')
        : (receipt.errors && receipt.errors.length ? receipt.errors.slice(0, 5).join('\n') : clip(receipt.summary || 'no stderr captured', 600));
      failureLines.push(`### \`${label}\`\n${diag}`);
    }
    tracer.step('run', { command, exitCode: receipt.exitCode });
  }

  const session = store.current;
  const nextLines = [
    passed
      ? `👉 ship(${JSON.stringify({ summary: '<what changed and why>' })})`
      : `👉 change(${JSON.stringify({ intent: input.intent || '<fix the failure>' })}) to fix, then verify again`,
  ];

  const { text } = fitSections(
    [
      { key: 'next', title: 'Next', priority: 0, lines: nextLines },
      { key: 'verdict', title: passed ? 'Verdict: PASS' : 'Verdict: FAIL', priority: 1, lines: commandLines },
      { key: 'failures', title: 'Failures', priority: 2, lines: failureLines },
    ],
    { maxChars: resolveBudget(input.depth, ctx.profile?.budget) }
  );
  return `# ContextOS verify\n\n${text}${session ? `\n\n<!-- session ${session.id}, ${session.receipts.length} receipts -->` : ''}`;
}

export async function shipPipeline(ctx, input = {}) {
  const { caps, store, tracer, projectRoot, profile } = ctx;
  const obs = await observe({ projectRoot, store });
  let session = store.current || store.ensureSession(input.summary || 'session');
  tracer.step('observe', { gitAvailable: obs.gitAvailable, reconciled: obs.reconciled });

  if (input.dryRun === true) {
    const touched = session.touchedFiles || [];
    const receipts = session.receipts || [];
    const summaryLines = [
      `- Session \`${session.id}\` will remain open`,
      `- Planned summary: ${input.summary || session.intent || 'session closed'}`,
      `- Touched files: ${touched.length}`,
      `- Receipts: ${receipts.length}`,
    ];
    const touchedLines = touched.slice(-10).map((entry) => `- \`${entry.path}\` (${entry.source})`);
    const receiptLines = receipts
      .slice(-5)
      .map((receipt) => `- [${receiptStatus(receipt).toUpperCase()}] \`${redactSecrets(receipt.command || '')}\` exit ${receipt.exitCode} (${receipt.id})`);
    tracer.step('dry_run', { touched: touched.length, receipts: receipts.length });

    const { text } = fitSections(
      [
        { key: 'summary', title: 'Planned closure', priority: 0, lines: summaryLines },
        { key: 'touched', title: 'Touched', priority: 1, lines: touchedLines },
        { key: 'receipts', title: 'Receipts', priority: 2, lines: receiptLines },
      ],
      { maxChars: resolveBudget(input.depth, ctx.profile?.budget) }
    );
    return `# ContextOS ship (dry run)\n\n${text}`;
  }

  const wantsVerify = input.verify === true || (Array.isArray(input.verify) && input.verify.length > 0);
  const extraLines = [];
  if (wantsVerify && !session.receipts.some((receipt) => receipt.exitCode === 0)) {
    const commands = Array.isArray(input.verify) && input.verify.length ? input.verify : profile.verify;
    for (const command of commands) {
      const res = await caps.run({ command, maxChars: profile.maxChars, timeoutMs: profile.timeoutMs });
      if (res.ok) {
        store.attachReceipt(res.data);
        extraLines.push(`- \`${redactSecrets(command)}\` → exit ${res.data.exitCode} (receipt ${res.data.id})`);
      } else {
        extraLines.push(`- \`${redactSecrets(command)}\` → ✗ ${res.error}`);
      }
    }
    session = store.current;
  }

  const green = (session.receipts || []).filter((receipt) => receipt.exitCode === 0);
  const superseded = (session.receipts || []).filter((receipt) => receiptStatus(receipt) === 'superseded');
  const unresolved = (session.receipts || []).filter((receipt) => receiptStatus(receipt) === 'unresolved');
  const unverified = green.length === 0 && unresolved.length === 0;

  if (profile.strict && (unverified || unresolved.length > 0)) {
    return [
      '# ContextOS ship — BLOCKED (strict profile)',
      '',
      unverified
        ? '- No passing receipt in this session.'
        : `- ${unresolved.length} unresolved failing receipt(s) remain in this session.`,
      `- Run \`verify({ commands: [...] })\` until the relevant command passes, or relax \`strict\` in \`.contextos/profile.json\`.`,
      ...(extraLines.length ? ['', '## Attempted', ...extraLines] : []),
    ].join('\n');
  }

  const attributablePaths = (session.touchedFiles || [])
    .filter((entry) => entry.deleted !== true)
    .map((entry) => entry.path);

  const known = await caps.blocks();
  const curatedBlocks = (known.ok ? known.data : []).filter((b) => !b.id.startsWith('mod-'));
  const isCuratedCovered = (filePath) => {
    const normalized = String(filePath).replace(/\\/g, '/').replace(/^\.\//, '');
    return curatedBlocks.some((block) =>
      (block.artifactRefs || []).some((ref) => {
        const binding = String(ref.path || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
        return ref.anchorKind === 'tree'
          ? normalized === binding || normalized.startsWith(`${binding}/`)
          : normalized === binding;
      })
    );
  };

  const isMajorSubsystem = (filePath) => {
    const normalized = String(filePath).replace(/\\/g, '/').replace(/^\.\//, '');
    const segments = normalized.split('/');
    return segments.length >= 2 && (segments[0] === 'apps' || segments[0] === 'packages');
  };

  const unmappedMajorFiles = attributablePaths.filter(
    (filePath) => isMajorSubsystem(filePath) && !isCuratedCovered(filePath)
  );

  const isStrictArchitecture = Boolean(profile.strict || profile.strictArchitecture);
  if (isStrictArchitecture && unmappedMajorFiles.length > 0) {
    return [
      '# ContextOS ship — BLOCKED (architecture governance gate)',
      '',
      `- Architecture completeness check failed: ${unmappedMajorFiles.length} file(s) in applications or packages are not covered by explicit Curated Blocks.`,
      '- Unmapped files:',
      ...unmappedMajorFiles.map((f) => `  - \`${f}\``),
      '',
      '- Action required: Run `ops block bind` to bind a curated Block and `ops chain link` to connect it to an architectural chain, or disable `strictArchitecture` / `strict` in `.contextos/profile.json`.',
      ...(extraLines.length ? ['', '## Attempted', ...extraLines] : []),
    ].join('\n');
  }

  // Derived attribution: the OS files every touched file under a module computed
  // from the AST. Best effort and never blocking (advisory governance).
  const attributionLines = [];
  const index = new ModuleIndex({ projectRoot });
  index.ensure(attributablePaths);
  const attribution = index.attribute(attributablePaths);
  const owned = new Set();
  for (const block of known.ok ? known.data : []) {
    for (const ref of block.artifactRefs || []) owned.add(ref.path);
  }
  const unclassified = attributablePaths.filter((filePath) => !owned.has(filePath));
  for (let i = 0; i < unclassified.length; i++) {
    const filePath = unclassified[i];
    const moduleId = attribution.get(filePath);
    const bound = await caps.block({
      action: 'bind_auto',
      id: moduleId,
      path: filePath,
      blockData: { title: `Derived module ${moduleId}`, kind: 'module' },
    });
    if (i < 8) {
      attributionLines.push(bound.ok
        ? `- \`${filePath}\` → **${moduleId}** (auto-bound)`
        : `- \`${filePath}\` → ${moduleId} (advisory only: ${bound.error})`);
    }
  }
  if (unclassified.length > 8) {
    attributionLines.push(`- (+${unclassified.length - 8} more auto-bound to derived modules)`);
  }
  tracer.step('attribute', { touched: (session.touchedFiles || []).length, unclassified: unclassified.length });

  const graph = await caps.exportGraph();
  tracer.step('graph', { ok: graph.ok });

  if (input.decision?.id) {
    const written = await caps.knowledge({
      action: 'decision_write',
      sectionId: input.decision.id,
      sectionTitle: input.decision.title || input.decision.id,
      content: input.decision.content || '',
    });
    tracer.step('decision', { id: input.decision.id, ok: written.ok });
  }

  const closed = store.close(input.summary || session.intent || 'session closed');

  const summaryLines = [
    `- Session \`${closed.id}\` closed at ${closed.closedAt}`,
    `- Touched files: ${closed.touchedFiles.length}`,
    `- Passing receipts: ${green.length}${unverified ? ' (unverified — advisory mode)' : ''}`,
    `- Superseded failures: ${superseded.length}`,
    `- Unresolved failures: ${unresolved.length}`,
    `- Derived attribution: ${unclassified.length} file(s) filed under derived modules${unclassified.length ? '' : ' (all already owned by curated Blocks)'}`,
  ];
  const touchedLines = closed.touchedFiles.slice(-10).map((entry) => `- \`${entry.path}\` (${entry.source})`);
  const evidenceLines = (closed.receipts || [])
    .slice(-5)
    .map((receipt) => `- [${receiptStatus(receipt).toUpperCase()}] \`${redactSecrets(receipt.command || '')}\` exit ${receipt.exitCode} (${receipt.id})`);
  const graphLines = [
    graph.ok
      ? `- graph.json exported${graph.data?.graphRevision ? ` (rev ${graph.data.graphRevision})` : ''}`
      : `- graph export pending: ${graph.error}`,
  ];
  const nextLines = [`👉 explore(${JSON.stringify({ intent: '<next goal>' })}) to start the next loop`];

  const { text } = fitSections(
    [
      { key: 'next', title: 'Next', priority: 0, lines: nextLines },
      { key: 'summary', title: 'Closure', priority: 1, lines: summaryLines },
      { key: 'evidence', title: 'Evidence', priority: 2, lines: evidenceLines },
      { key: 'touched', title: 'Touched', priority: 3, lines: touchedLines },
      { key: 'attribution', title: 'Attribution (derived)', priority: 4, lines: attributionLines },
      { key: 'graph', title: 'Graph', priority: 5, lines: graphLines },
    ],
    { maxChars: resolveBudget(input.depth, ctx.profile?.budget) }
  );
  return `# ContextOS ship\n\n${text}`;
}

function normalizeAction(action, projectRoot) {
  if (!action || typeof action !== 'object') {
    throw new Error(`Invalid action in pipeline: expected object, got ${typeof action}`);
  }
  let tool = action.tool;
  let args = { ...action };
  delete args.tool;

  // Shorthand keys:
  if (!tool) {
    if ('inspect' in action) {
      tool = 'inspect';
      args = typeof action.inspect === 'string' ? { path: action.inspect } : { ...action.inspect };
    } else if ('change' in action) {
      tool = 'change';
      args = typeof action.change === 'string' ? { path: action.change } : { ...action.change };
    } else if ('verify' in action) {
      tool = 'verify';
      args = typeof action.verify === 'string'
        ? { command: action.verify }
        : (action.verify === true ? {} : { ...action.verify });
    } else if ('ship' in action) {
      tool = 'ship';
      args = typeof action.ship === 'string' ? { summary: action.ship } : { ...action.ship };
    } else if ('run' in action || 'run_command' in action) {
      tool = 'ops';
      const cmd = action.run || action.run_command;
      const cmdArgs = typeof cmd === 'string' ? { command: cmd } : { ...cmd };
      if (action.raw !== undefined) cmdArgs.raw = action.raw;
      if (action.maxChars !== undefined) cmdArgs.maxChars = action.maxChars;
      if (action.mode !== undefined) cmdArgs.mode = action.mode;
      args = {
        capability: 'run_command',
        args: cmdArgs,
      };
    } else if ('block' in action) {
      tool = 'ops';
      args = {
        capability: 'block',
        ...(typeof action.block === 'object' ? action.block : { action: 'open', id: action.block }),
      };
    } else if ('chain' in action && !Array.isArray(action.chain)) {
      tool = 'ops';
      args = {
        capability: 'chain',
        ...(typeof action.chain === 'object' ? action.chain : { action: 'open', id: action.chain }),
      };
    } else if ('plan' in action) {
      tool = 'ops';
      args = {
        capability: 'plan',
        ...(typeof action.plan === 'object' ? action.plan : { action: 'open', id: action.plan }),
      };
    } else if ('task' in action) {
      tool = 'ops';
      args = {
        capability: 'task',
        ...(typeof action.task === 'object' ? action.task : { action: 'open', id: action.task }),
      };
    } else if ('ops' in action) {
      tool = 'ops';
      args = { ...action.ops };
    } else if ('explore' in action) {
      tool = 'explore';
      args = typeof action.explore === 'string' ? { intent: action.explore } : { ...action.explore };
    }
  }

  if (!tool) {
    throw new Error(`Could not determine tool for action: ${JSON.stringify(action)}`);
  }

  return {
    tool,
    input: {
      ...args,
      projectRoot: args.projectRoot || projectRoot,
    },
  };
}

export async function pipelinePipeline(ctx, input = {}) {
  let steps = input.steps || input.flow || input.actions;
  if (!steps) {
    if (input.parallel) steps = [{ parallel: input.parallel }];
    else if (input.chain) steps = [{ chain: input.chain }];
    else steps = [];
  }
  if (!Array.isArray(steps) || !steps.length) {
    return '# ContextOS pipeline\n- No steps provided in pipeline. Pass `steps: [...]`, `chain: [...]`, or `parallel: [...]`.';
  }

  const results = [];
  let halted = false;
  let haltReason = null;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const stepNum = i + 1;

    // Parallel group: Array or { parallel: [...] }
    if (Array.isArray(step) || (step && Array.isArray(step.parallel))) {
      const items = Array.isArray(step) ? step : step.parallel;
      const subResults = await Promise.all(
        items.map(async (action, idx) => {
          try {
            const normalized = normalizeAction(action, ctx.projectRoot);
            const res = await ctx.orchestrator.dispatch(normalized.tool, normalized.input);
            return { index: idx + 1, tool: normalized.tool, ok: true, output: res };
          } catch (err) {
            return { index: idx + 1, tool: action.tool || 'unknown', ok: false, error: err.message };
          }
        })
      );
      results.push({
        step: stepNum,
        kind: 'parallel',
        items: subResults,
        ok: subResults.every((r) => r.ok),
      });
      continue;
    }

    // Serial chain group: { chain: [...] }
    if (step && Array.isArray(step.chain)) {
      const items = step.chain;
      const subResults = [];
      let chainFailed = false;

      for (let j = 0; j < items.length; j++) {
        const action = items[j];
        try {
          const normalized = normalizeAction(action, ctx.projectRoot);
          const res = await ctx.orchestrator.dispatch(normalized.tool, normalized.input);
          const isFail = typeof res === 'string' && (res.includes('Verdict: FAIL') || res.includes('BLOCKED'));
          subResults.push({ index: j + 1, tool: normalized.tool, ok: !isFail, output: res });
          if (isFail) {
            chainFailed = true;
            haltReason = `Chain step ${j + 1} (${normalized.tool}) failed verification/gate`;
            break;
          }
        } catch (err) {
          subResults.push({ index: j + 1, tool: action.tool || 'unknown', ok: false, error: err.message });
          chainFailed = true;
          haltReason = `Chain step ${j + 1} (${action.tool || 'action'}) threw error: ${err.message}`;
          break;
        }
      }

      results.push({
        step: stepNum,
        kind: 'chain',
        items: subResults,
        ok: !chainFailed,
      });

      if (chainFailed) {
        halted = true;
        break;
      }
      continue;
    }

    // Regular single action step
    try {
      const normalized = normalizeAction(step, ctx.projectRoot);
      const res = await ctx.orchestrator.dispatch(normalized.tool, normalized.input);
      const isFail = typeof res === 'string' && (res.includes('Verdict: FAIL') || res.includes('BLOCKED'));
      results.push({
        step: stepNum,
        kind: 'single',
        tool: normalized.tool,
        ok: !isFail,
        output: res,
      });
      if (isFail) {
        halted = true;
        haltReason = `Step ${stepNum} (${normalized.tool}) failed verification/gate`;
        break;
      }
    } catch (err) {
      results.push({
        step: stepNum,
        kind: 'single',
        tool: step.tool || 'unknown',
        ok: false,
        error: err.message,
      });
      halted = true;
      haltReason = `Step ${stepNum} threw error: ${err.message}`;
      break;
    }
  }

  const lines = [
    `# ContextOS pipeline — ${halted ? 'HALTED ⚠️' : 'COMPLETED ✅'}`,
    `- Total steps executed: ${results.length} / ${steps.length}`,
    `- Status: ${halted ? `Stopped early: ${haltReason}` : 'All pipeline steps executed successfully'}`,
    '',
    '## Step Breakdown:',
  ];

  function formatPipelineOutput(output, budget = 1200) {
    if (!output) return '';
    if (typeof output === 'string') return clip(output, budget);
    if (typeof output === 'object') {
      if (output.text) return clip(output.text, budget);
      if (output.summary) return clip(output.summary, budget);
      return clip(JSON.stringify(output, null, 2), budget);
    }
    return clip(String(output), budget);
  }

  for (const r of results) {
    if (r.kind === 'parallel') {
      lines.push(`### Step ${r.step} [Parallel Concurrency: ${r.items.length} actions] (${r.ok ? 'PASS' : 'FAIL'})`);
      for (const item of r.items) {
        lines.push(`- **Action ${item.index} (${item.tool})**: ${item.ok ? 'OK' : `FAIL: ${item.error}`}`);
        if (item.output) {
          lines.push('```text', formatPipelineOutput(item.output, 1200), '```');
        }
      }
    } else if (r.kind === 'chain') {
      lines.push(`### Step ${r.step} [Sequential Chain: ${r.items.length} actions] (${r.ok ? 'PASS' : 'HALTED'})`);
      for (const item of r.items) {
        lines.push(`- **Chain Action ${item.index} (${item.tool})**: ${item.ok ? 'OK' : `FAILED: ${item.error || 'Verification/gate failed'}`}`);
        if (item.output) {
          lines.push('```text', formatPipelineOutput(item.output, 1200), '```');
        }
      }
    } else {
      lines.push(`### Step ${r.step} [Single Action: ${r.tool}] (${r.ok ? 'PASS' : 'FAIL'})`);
      if (r.error) lines.push(`- Error: ${r.error}`);
      if (r.output) {
        lines.push('```text', formatPipelineOutput(r.output, 1200), '```');
      }
    }
  }

  return lines.join('\n');
}


import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseRolloutTelemetry } from '../packages/orchestrator/src/rollout-telemetry.mjs';
const fields = ['input_tokens','cached_input_tokens','cache_write_input_tokens','output_tokens','reasoning_output_tokens','total_tokens'];
// Codex 0.159.2 emits a context-size hint after compaction. It is not a response.
// Only omit the observed zero-usage shape with an unchanged cumulative counter.
export function stripCompactionContextHints(content) {
  let cumulative = null, compacted = false, ignored = 0;
  const lines = content.split('\n').map((line) => {
    let record; try { record = JSON.parse(line); } catch { return line; }
    if (record.type === 'compacted') { compacted = true; return line; }
    if (record.type === 'token_usage_record') { compacted = false; return line; }
    if (record.type !== 'event_msg' || record.payload?.type !== 'token_count') return line;
    const info = record.payload.info, last = info?.last_token_usage, total = info?.total_token_usage;
    const sameTotal = cumulative && total && fields.every((key) => Number.isSafeInteger(total[key]) && total[key] >= 0 && total[key] === cumulative[key]);
    const hint = compacted && sameTotal && last && !info.response_id && !record.payload.response_id
      && fields.filter((key) => key !== 'total_tokens').every((key) => last[key] === 0)
      && Number.isSafeInteger(last.total_tokens) && last.total_tokens > 0;
    compacted = false; cumulative = total;
    if (hint) { ignored++; return ''; }
    return line;
  });
  return { content: lines.join('\n'), ignored };
}
export function parseDevelopmentRollouts(files) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-usage-'));
  let ignored = 0;
  try {
    const cleaned = files.map((file,index) => {
      const result = stripCompactionContextHints(fs.readFileSync(file,'utf8')); ignored += result.ignored;
      const target = path.join(temporary,`${index}.jsonl`); fs.writeFileSync(target,result.content); return target;
    });
    const result = parseRolloutTelemetry(cleaned);
    result.warnings = result.warnings.map((warning) => cleaned.reduce((text,file,index) => text.replaceAll(file,files[index]),warning));
    return { ...result, contextSizeHintsIgnored: ignored };
  } finally { fs.rmSync(temporary,{recursive:true,force:true}); }
}

// The routing envelope is shared by API and CLI transports. Missing routing
// metadata must preserve the answer rather than silently hide it.
export function microDeliveryPrompt(delivery, { evidence = false } = {}) {
  if (delivery === 'auto') return evidence
    ? '\nInclude needsHost:boolean and hostReason:string in the evidence JSON. Report findings, blockers, changes requiring integration, or decisions the host needs. Otherwise set needsHost=false and keep the answer empty. Report actual verification, never a plan as completed work.'
    : '\nReturn only JSON: {"needsHost":boolean,"hostReason":string,"answer":string or JSON value}. Report findings, blockers, changes requiring integration, or decisions the host needs with needsHost=true and a concise answer. Routine independent success can use needsHost=false and an empty answer. Report actual verification, never a plan as completed work.';
  if (delivery === 'errors-only') return '\nThe host receives errors only. Complete the assignment and return a concise final result; never hide a blocked or failed required action as success.';
  if (delivery === 'defer') return '\nYour concise result will reach the host on a later OS call. Include only the findings and verification it needs.';
  return '';
}

export function parseMicroRouting(content, structured = null) {
  let record = structured;
  if (!record || typeof record.needsHost !== 'boolean') {
    // Models frequently wrap the final JSON report in one Markdown code fence.
    // Accept only a whole fenced payload, never extract JSON from prose.
    const text = typeof content === 'string' ? content.trim() : '';
    const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(text);
    try { record = JSON.parse(fenced ? fenced[1].trim() : text); } catch { return null; }
  }
  if (!record || typeof record.needsHost !== 'boolean') return null;
  // A structured worker report carries its own summary/changes fields. Only
  // the broker envelope shape (needsHost + answer) rewrites the content to the
  // answer; otherwise keep the report intact for the agent-report normalizer.
  if (Object.hasOwn(record, 'summary') && !Object.hasOwn(record, 'answer')) {
    return { needsHost: record.needsHost, hostReason: typeof record.hostReason === 'string' ? record.hostReason.slice(0, 400) : null, content };
  }
  const answer = typeof record.answer === 'string' ? record.answer
    : record.answer != null ? JSON.stringify(record.answer) : '';
  // A positive notification without an answer is malformed: keep the original.
  if (record.needsHost && !answer.trim()) return null;
  return { needsHost: record.needsHost, hostReason: typeof record.hostReason === 'string' ? record.hostReason.slice(0, 400) : null, content: answer };
}

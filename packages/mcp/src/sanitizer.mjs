/**
 * Intelligent terminal log sanitizer to prevent AI context token flooding.
 * Strips ANSI codes, progress bars, collapses routine stdout, and preserves
 * head/tail failure stack traces.
 */

// Regular expressions for terminal control sequences
const ANSI_REGEX = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
const PROGRESS_REGEX = /(?:\[[=>\-\s]+\]|\b\d{1,3}%\b|[\u2580-\u259F]+|\r\s*)/g;
const FAILURE_MARKERS = [
  /\b(?:error|fatal|fail(?:ed|ure)?|exception|panic)\b/i,
  /\bassert(?:ion)?\s*(?:error|failed)?\b/i,
  /^\s*(?:not ok|\bFAIL\b|×|\u2717)/i,
  /\b(?:NullPointer|Undefined|TypeError|ReferenceError|SyntaxError)\b/,
];

/**
 * Clean ANSI control codes and carriage return progress rewrites
 */
export function cleanControlCharacters(text = "") {
  return text
    .replace(ANSI_REGEX, "")
    .replace(/\r+/g, "\n")
    .replace(PROGRESS_REGEX, "");
}

/**
 * Determine if a line contains a failure or error signal
 */
export function isFailureLine(line = "") {
  const trimmed = line.trim();
  if (!trimmed) return false;
  return FAILURE_MARKERS.some((regex) => regex.test(trimmed));
}

/**
 * Sanitize terminal output, reducing token consumption while preserving actionable error context
 */
export function sanitizeTerminalOutput(rawOutput = "", options = {}) {
  const {
    maxChars = 3000,
    headLines = 5,
    tailLines = 15,
    errorContextLines = 3,
    exitCode = null,
  } = options;

  const originalLength = rawOutput.length;
  if (!rawOutput.trim()) {
    return {
      text: "(No output)",
      originalLength: 0,
      sanitizedLength: 0,
      reductionRatio: "0%",
      hasErrors: false,
    };
  }

  const cleaned = cleanControlCharacters(rawOutput);
  const lines = cleaned.split("\n").map((l) => l.trimEnd()).filter((l, idx, arr) => {
    // Deduplicate consecutive empty lines
    return l.length > 0 || (idx > 0 && arr[idx - 1].length > 0);
  });

  // Check if there are failures
  const errorIndices = [];
  for (let i = 0; i < lines.length; i++) {
    if (isFailureLine(lines[i])) {
      errorIndices.push(i);
    }
  }

  const hasErrors = errorIndices.length > 0 || (exitCode !== null && exitCode !== 0);

  // If succeeded and output is purely routine tests/builds, collapse if long
  if (!hasErrors && lines.length > 25) {
    const summaryHead = lines.slice(0, 3).join("\n");
    const summaryTail = lines.slice(-5).join("\n");
    const collapsedCount = lines.length - 8;
    const text = `${summaryHead}\n... [${collapsedCount} lines routine build output collapsed] ...\n${summaryTail}`;
    return {
      text,
      originalLength,
      sanitizedLength: text.length,
      reductionRatio: `${((1 - text.length / originalLength) * 100).toFixed(1)}%`,
      hasErrors: false,
    };
  }

  // If has errors, capture head, error windows, and tail
  const keptIndices = new Set();

  // Keep head
  for (let i = 0; i < Math.min(headLines, lines.length); i++) {
    keptIndices.add(i);
  }

  // Keep tail
  for (let i = Math.max(0, lines.length - tailLines); i < lines.length; i++) {
    keptIndices.add(i);
  }

  // Keep error windows (context before and after each failure)
  for (const idx of errorIndices) {
    const start = Math.max(0, idx - errorContextLines);
    const end = Math.min(lines.length - 1, idx + errorContextLines);
    for (let j = start; j <= end; j++) {
      keptIndices.add(j);
    }
  }

  // Assemble result with collapsed indicators
  const sortedIndices = [...keptIndices].sort((a, b) => a - b);
  const resultLines = [];
  let lastIndex = -1;

  for (const idx of sortedIndices) {
    if (lastIndex !== -1 && idx > lastIndex + 1) {
      const skipped = idx - lastIndex - 1;
      resultLines.push(`... [${skipped} lines non-error output collapsed] ...`);
    }
    resultLines.push(lines[idx]);
    lastIndex = idx;
  }

  let text = resultLines.join("\n");
  if (text.length > maxChars) {
    text = `${text.slice(0, maxChars - 80)}\n... [truncated for context limit]`;
  }

  return {
    text,
    originalLength,
    sanitizedLength: text.length,
    reductionRatio: `${((1 - text.length / originalLength) * 100).toFixed(1)}%`,
    hasErrors,
  };
}

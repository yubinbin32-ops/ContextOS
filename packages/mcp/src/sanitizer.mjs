/**
 * Terminal output is untrusted, high-volume input. Keep this module as the
 * single compression/redaction boundary used by MCP tools and mutation
 * verification; callers must never return the raw stream to the model.
 */

const ANSI_REGEX = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
const PROGRESS_REGEX = /(?:\[[=>\-\s]+\]|\b\d{1,3}%\b|[\u2580-\u259F]+|\r\s*)/g;
const FAILURE_MARKERS = [
  /\b(?:error|fatal|fail(?:ed|ure)?|exception|panic)\b/i,
  /\bassert(?:ion)?\s*(?:error|failed)?\b/i,
  /^\s*(?:not ok|\bFAIL\b|×|\u2717)/i,
  /\b(?:NullPointer|Undefined|TypeError|ReferenceError|SyntaxError)\b/,
];

const SECRET_PATTERNS = [
  /(authorization\s*:\s*(?:bearer|basic)\s+)[^\s,;]+/gi,
  /((?:openai|aws|github|npm|api|access|secret|private)[_-]?(?:api[_-]?key|token|secret|password|access[_-]?key)\s*[=:]\s*)[^\s,;"']+/gi,
  /((?:api[_-]?key|token|secret|password|cookie|signature)\s*[=:]\s*)[^\s,;"']+/gi,
  /([?&](?:api[_-]?key|token|secret|password|signature)=)[^&#\s]+/gi,
];
const PRIVATE_KEY_REGEX = /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi;

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Clean ANSI control codes and carriage-return progress rewrites. */
export function cleanControlCharacters(text = "") {
  return String(text)
    .replace(ANSI_REGEX, "")
    .replace(/\r+/g, "\n")
    .replace(PROGRESS_REGEX, "");
}

/** Redact credentials before any compression or failure extraction occurs. */
export function redactSensitiveText(text = "", { projectRoot = "", homeDirectory = process.env.HOME ?? "" } = {}) {
  let redacted = String(text).replace(PRIVATE_KEY_REGEX, "[REDACTED PRIVATE KEY]");
  let redactionCount = PRIVATE_KEY_REGEX.test(String(text)) ? 1 : 0;
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, (_match, prefix) => {
      redactionCount += 1;
      return `${prefix}[REDACTED]`;
    });
  }

  const pathReplacements = [
    [projectRoot, "$PROJECT"],
    [homeDirectory, "$HOME"],
    [process.cwd(), "$CWD"],
  ]
    .filter(([value]) => typeof value === "string" && value.length > 1)
    .sort((left, right) => right[0].length - left[0].length);
  for (const [value, replacement] of pathReplacements) {
    const pattern = new RegExp(escapeRegex(value), "g");
    const before = redacted;
    redacted = redacted.replace(pattern, replacement);
    if (redacted !== before) redactionCount += 1;
  }

  return { text: redacted, redactionCount };
}

export function isFailureLine(line = "") {
  const trimmed = line.trim();
  if (!trimmed) return false;
  return FAILURE_MARKERS.some((regex) => regex.test(trimmed));
}

function clampText(text, maxChars) {
  if (text.length <= maxChars) return text;
  const suffix = "\n... [truncated for context limit]";
  const limit = Math.max(0, maxChars - suffix.length);
  return `${text.slice(0, limit)}${suffix}`;
}

function resultFor(text, { originalLength, hasErrors, redactionCount, maxChars }) {
  const finalText = clampText(text, maxChars);
  const sanitizedLength = finalText.length;
  return {
    text: finalText,
    sanitized: finalText,
    originalLength,
    originalChars: originalLength,
    sanitizedLength,
    finalChars: sanitizedLength,
    reductionRatio: `${originalLength === 0 ? 0 : ((1 - sanitizedLength / originalLength) * 100).toFixed(1)}%`,
    compressionRatio: originalLength === 0 ? "0%" : `${(sanitizedLength / originalLength).toFixed(3)}`,
    hasErrors,
    redactions: redactionCount,
  };
}

/**
 * Sanitize terminal output while preserving only actionable failure context.
 * An explicit exit code is authoritative: successful output containing words
 * such as “error context” is not reported as a failed command.
 */
export function sanitizeTerminalOutput(rawOutput = "", options = {}) {
  const {
    maxChars = 3000,
    headLines = 5,
    tailLines = 15,
    errorContextLines = 3,
    exitCode = null,
    projectRoot = "",
    homeDirectory = process.env.HOME ?? "",
  } = options;
  const raw = String(rawOutput);
  const originalLength = raw.length;
  if (!raw.trim()) {
    return resultFor("(No output)", {
      originalLength,
      hasErrors: exitCode !== null && exitCode !== 0,
      redactionCount: 0,
      maxChars,
    });
  }

  const cleaned = cleanControlCharacters(raw);
  const redacted = redactSensitiveText(cleaned, { projectRoot, homeDirectory });
  const lines = redacted.text.split("\n").map((line) => line.trimEnd()).filter((line, index, all) => {
    return line.length > 0 || (index > 0 && all[index - 1].length > 0);
  });
  const errorIndices = lines.reduce((indices, line, index) => {
    if (isFailureLine(line)) indices.push(index);
    return indices;
  }, []);
  const hasErrors = exitCode !== null ? exitCode !== 0 : errorIndices.length > 0;

  if (!hasErrors && lines.length > 25) {
    const text = [
      lines.slice(0, 3).join("\n"),
      `... [${lines.length - 8} lines routine build output collapsed] ...`,
      lines.slice(-5).join("\n"),
    ].join("\n");
    return resultFor(text, {
      originalLength,
      hasErrors: false,
      redactionCount: redacted.redactionCount,
      maxChars,
    });
  }

  const keptIndices = new Set();
  for (let i = 0; i < Math.min(headLines, lines.length); i += 1) keptIndices.add(i);
  for (let i = Math.max(0, lines.length - tailLines); i < lines.length; i += 1) keptIndices.add(i);
  for (const index of errorIndices) {
    for (let cursor = Math.max(0, index - errorContextLines); cursor <= Math.min(lines.length - 1, index + errorContextLines); cursor += 1) {
      keptIndices.add(cursor);
    }
  }

  const resultLines = [];
  let lastIndex = -1;
  for (const index of [...keptIndices].sort((left, right) => left - right)) {
    if (lastIndex !== -1 && index > lastIndex + 1) {
      resultLines.push(`... [${index - lastIndex - 1} lines non-error output collapsed] ...`);
    }
    resultLines.push(lines[index]);
    lastIndex = index;
  }
  return resultFor(resultLines.join("\n"), {
    originalLength,
    hasErrors,
    redactionCount: redacted.redactionCount,
    maxChars,
  });
}

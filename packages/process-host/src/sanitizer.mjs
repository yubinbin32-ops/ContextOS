/**
 * Sanitizes command output:
 * - Strips ANSI codes, control characters, progress bars
 * - Redacts secrets and credentials
 * - Extracts failure messages and stack traces
 * - Collapses success noise
 */

export function stripAnsi(text) {
  return text.replace(/\u001b\[[0-9;]*[a-zA-Z]/g, '').replace(/\r/g, '\n');
}

export function redactSecrets(text) {
  return text
    .replace(/(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36}/g, '[REDACTED_GITHUB_TOKEN]')
    .replace(/sk-[a-zA-Z0-9]{32,}/g, '[REDACTED_API_KEY]')
    .replace(/(?:password|token|secret|key|bearer)\s*[:=]\s*['"]?([a-zA-Z0-9_\-.~+]{8,})['"]?/gi, (match, val) =>
      match.replace(val, '[REDACTED]')
    );
}

export function sanitizeTerminalOutput(rawText, options = {}) {
  const maxChars = options.maxChars || 1500;
  const exitCode = options.exitCode !== undefined ? options.exitCode : 0;

  let cleaned = stripAnsi(rawText);
  cleaned = redactSecrets(cleaned);

  const lines = cleaned.split('\n').map((l) => l.trimEnd()).filter((l) => l.length > 0);

  // Filter out noise like compilation spinners / progress bars
  const nonNoiseLines = lines.filter((line) => {
    if (line.match(/^\[\d+\/\d+\]\s+Compiling/i)) return false;
    if (line.match(/^\s*\d+%\s+/)) return false;
    if (line.match(/^(=|-|\*){5,}$/)) return false;
    return true;
  });

  const errors = [];
  const warnings = [];

  for (const line of nonNoiseLines) {
    if (line.match(/error[:\s]|failed|failure|exception|fatal/i)) {
      errors.push(line);
    } else if (line.match(/warning[:\s]|warn[:\s]/i)) {
      warnings.push(line);
    }
  }

  let summary = '';
  if (exitCode === 0 && errors.length === 0) {
    summary = `Command succeeded (${lines.length} lines collapsed).`;
    if (warnings.length > 0) {
      summary += ` ${warnings.length} warning(s).`;
    }
  } else {
    summary = `Command failed with exit code ${exitCode}. Found ${errors.length} error(s).`;
  }

  // Construct compact text
  let resultText = '';
  if (exitCode === 0 && errors.length === 0) {
    resultText = summary;
    if (warnings.length > 0) {
      resultText += '\n\nWarnings:\n' + warnings.slice(0, 5).join('\n');
    }
  } else {
    resultText = `${summary}\n\nKey Failures & Errors:\n` + errors.slice(0, 15).join('\n');
    // If we have remaining space, include the tail of the output
    const remainingBudget = maxChars - resultText.length;
    if (remainingBudget > 200) {
      const tail = nonNoiseLines.slice(-10).join('\n');
      resultText += `\n\nTail Output:\n${tail}`;
    }
  }

  if (resultText.length > maxChars) {
    resultText = resultText.slice(0, maxChars - 30) + '\n...[output truncated]';
  }

  return {
    text: resultText,
    summary,
    exitCode,
    errors: errors.slice(0, 10),
    warnings: warnings.slice(0, 5),
  };
}

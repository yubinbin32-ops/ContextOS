/**
 * Sanitizes command output:
 * - Strips ANSI codes, control characters, progress bars
 * - Redacts secrets and credentials
 * - Extracts failure messages and stack traces
 * - Collapses success noise
 */

export function stripAnsi(text) {
  if (typeof text !== 'string') return '';
  return text.replace(/\u001b\[[0-9;]*[a-zA-Z]/g, '').replace(/\r/g, '\n');
}

export function redactSecrets(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36}/g, '[REDACTED_GITHUB_TOKEN]')
    .replace(/sk-[a-zA-Z0-9]{32,}/g, '[REDACTED_API_KEY]')
    .replace(/(?:password|token|secret|key|bearer)\s*[:=]\s*['"]?([a-zA-Z0-9_\-.~+]{8,})['"]?/gi, (match, val) =>
      match.replace(val, '[REDACTED]')
    );
}

export function extractDiagnosticBlocks(lines, maxBlocks = 3, maxLinesPerBlock = 16) {
  const blocks = [];
  const visited = new Set();

  for (let i = 0; i < lines.length; i++) {
    if (visited.has(i)) continue;
    const line = lines[i];

    const isAnchor =
      line.match(/^(?:not ok \d+|\s*✖\s+|FAIL\s+|FAILED\s+)/i) ||
      line.match(/(?:AssertionError|ERR_ASSERTION|expected .+ to|received .+)/i) ||
      line.match(/^(?:[A-Za-z0-9_]*Error|Exception|fatal error|panic):/i) ||
      line.match(/\b(SyntaxError|TypeError|ReferenceError|RangeError):/) ||
      line.match(/^.+:\d+:\d+:\s*(?:error|fatal error):/i);

    if (isAnchor) {
      let start = i;
      let lookback = 0;
      while (start > 0 && lookback < 4 && !visited.has(start - 1)) {
        const candidate = lines[start - 1];
        if (!candidate.trim() || candidate.match(/^(?:ok \d+|not ok \d+|# Subtest:|\s*✔\s+|PASS\s+)/i)) {
          if (candidate.match(/^# Subtest:/i)) {
            start -= 1;
          }
          break;
        }
        start -= 1;
        lookback += 1;
        if (candidate.match(/^[a-zA-Z0-9_\-./]+\.[a-zA-Z0-9]+:\d+/)) {
          break;
        }
      }

      let end = i + 1;
      let inYaml = false;

      while (end < lines.length && (end - start) < maxLinesPerBlock) {
        const curr = lines[end];
        if (curr.trim() === '---') inYaml = true;
        if (inYaml && curr.trim() === '...') {
          end += 1;
          break;
        }
        if (curr.match(/^(?:ok \d+|# Subtest:|\s*✔\s+|PASS\s+)/i)) {
          break;
        }
        if ((end - start) > 3 && (curr.match(/^(?:not ok \d+|\s*✖\s+|FAIL\s+|FAILED\s+)/i) || curr.match(/^# Subtest:/i))) {
          break;
        }
        end += 1;
      }

      for (let k = start; k < end; k++) visited.add(k);
      const blockLines = lines.slice(start, end);
      if (blockLines.length > 0) {
        blocks.push(blockLines.join('\n'));
      }
      if (blocks.length >= maxBlocks) break;
    }
  }

  return blocks;
}

export function sanitizeTerminalOutput(rawText, options = {}) {
  const maxChars = options.maxChars || 1500;
  const exitCode = options.exitCode !== undefined ? options.exitCode : 0;
  const raw = Boolean(options.raw);
  const command = String(options.command || '');
  const mode = options.mode || 'auto';

  let cleaned = stripAnsi(rawText);
  cleaned = redactSecrets(cleaned);

  if (raw) {
    const trimmed = cleaned.trimEnd();
    return {
      text: trimmed.length > maxChars ? trimmed.slice(0, maxChars - 30) + '\n...[output truncated]' : trimmed,
      summary: `Command executed with exit code ${exitCode} (${trimmed.length} chars).`,
      exitCode,
      errors: [],
      diagnostics: [],
      warnings: [],
      distinctFiles: [],
    };
  }

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

  for (let i = 0; i < nonNoiseLines.length; i++) {
    const line = nonNoiseLines[i];
    if (exitCode !== 0 && (line.match(/error[:\s]|failed|failure|exception|fatal|AssertionError|ERR_ASSERTION/i) || line.trim().startsWith('✖') || line.trim().startsWith('+') || line.trim().startsWith('-'))) {
      errors.push(line);
    } else if (line.match(/warning[:\s]|warn[:\s]/i)) {
      warnings.push(line);
    }
  }

  const diagnostics = exitCode !== 0 ? extractDiagnosticBlocks(nonNoiseLines, 3, 16) : [];

  // Determine if this is a query command (grep, rg, find, ls, cat, sed, git status, git diff, etc.)
  const isQuery = mode === 'query' || /^(rg|grep|find|cat|sed|ls|git\s+(status|diff|log|branch)|jq|awk)\b/i.test(command.trim());

  // Extract distinct files from output lines (e.g. path/to/file:line or paths)
  const distinctFiles = [];
  const fileSeen = new Set();
  for (const line of nonNoiseLines) {
    const m = line.match(/^([a-zA-Z0-9_./-]+\.[a-zA-Z0-9]+)(:\d+)?/);
    if (m) {
      const f = m[1];
      if (!fileSeen.has(f) && !f.startsWith('http')) {
        fileSeen.add(f);
        distinctFiles.push(f);
      }
    }
  }

  let summary = '';
  if (exitCode === 0) {
    const fileSuffix = distinctFiles.length > 0 ? `, ${distinctFiles.length} file(s)` : '';
    if (lines.length <= 15 && cleaned.length <= maxChars) {
      summary = `Command succeeded (${lines.length} lines${fileSuffix}).`;
    } else {
      summary = `Command succeeded (${lines.length} lines collapsed${fileSuffix}).`;
    }
    if (warnings.length > 0) {
      summary += ` ${warnings.length} warning(s).`;
    }
  } else {
    summary = `Command failed with exit code ${exitCode}. Found ${errors.length} error(s).`;
  }

  // Construct compact text
  let resultText = '';
  if (exitCode === 0) {
    if (lines.length <= 15 && cleaned.length <= maxChars) {
      resultText = lines.join('\n');
    } else if (isQuery) {
      // Query output: retain matched files catalog at top + top lines
      let queryBody = '';
      if (distinctFiles.length > 0) {
        queryBody += `Matched files (${distinctFiles.length}):\n` + distinctFiles.slice(0, 15).map((f) => `- ${f}`).join('\n') + (distinctFiles.length > 15 ? `\n... (+${distinctFiles.length - 15} more)` : '') + '\n\nTop matches:\n';
      }
      const topCount = Math.min(nonNoiseLines.length, 20);
      const topLines = nonNoiseLines.slice(0, topCount);
      queryBody += topLines.join('\n');
      if (nonNoiseLines.length > topCount) {
        queryBody += `\n... (${nonNoiseLines.length - topCount} more lines omitted, full output in receipt log)`;
      }
      resultText = `${summary}\n\n${queryBody}`;
    } else {
      resultText = summary;
      if (nonNoiseLines.length > 0) {
        const head = nonNoiseLines.slice(0, 5).join('\n');
        const tail = nonNoiseLines.slice(-5).join('\n');
        resultText += `\n\nOutput Preview:\n${head}\n...\n${tail}`;
      }
    }
    if (warnings.length > 0) {
      resultText += '\n\nWarnings:\n' + warnings.slice(0, 5).join('\n');
    }
  } else {
    resultText = `${summary}\n\nKey Failures & Errors:\n` + (diagnostics.length ? diagnostics.join('\n\n---\n\n') : errors.slice(0, 15).join('\n'));
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
    diagnostics,
    warnings: warnings.slice(0, 5),
    distinctFiles: distinctFiles.slice(0, 30),
  };
}

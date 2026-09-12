const HEADER_PATTERN = /^contextos\/(\d+)(?:\s+(.*))?$/;
const TARGET_PATTERN = /^(block|chain|link|plan|decision|checkpoint|plan_change|plan_step|plan_scope|source):([^@]+?)(?:@(\d+))?$/;

function tokenize(input, lineNumber) {
  const tokens = [];
  let token = "";
  let quote = null;
  let escaped = false;
  for (const character of input) {
    if (escaped) {
      token += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote) {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      else token += character;
      continue;
    }
    if (character === "\"" || character === "'") {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (token) {
        tokens.push(token);
        token = "";
      }
      continue;
    }
    token += character;
  }
  if (escaped) token += "\\";
  if (quote) throw new Error(`Compact patch line ${lineNumber} has an unterminated quote`);
  if (token) tokens.push(token);
  return tokens;
}

function parseValue(raw) {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null") return null;
  if (/^-?\d+(?:\.\d+)?$/.test(raw)) return Number(raw);
  if ((raw.startsWith("[") && raw.endsWith("]")) || (raw.startsWith("{") && raw.endsWith("}"))) {
    try {
      return JSON.parse(raw);
    } catch {
      // Keep malformed JSON as text so the service can report the field-specific error.
    }
  }
  return raw;
}

function parseKeyValue(token, lineNumber) {
  const separator = token.indexOf("=");
  if (separator <= 0) throw new Error(`Compact patch line ${lineNumber} expects key=value, got ${token}`);
  const key = token.slice(0, separator).trim();
  const raw = token.slice(separator + 1);
  if (!key) throw new Error(`Compact patch line ${lineNumber} has an empty field name`);
  return [key, parseValue(raw)];
}

function parseTarget(token, lineNumber) {
  const match = TARGET_PATTERN.exec(token);
  if (!match) throw new Error(`Compact patch line ${lineNumber} has invalid target ${token}`);
  return {
    targetType: match[1],
    targetId: match[2],
    expectedRevision: match[3] ? Number(match[3]) : undefined,
  };
}

function parseInlineFields(tokens, lineNumber) {
  const fields = {};
  let expectedRevision;
  for (const token of tokens) {
    const [key, value] = parseKeyValue(token, lineNumber);
    if (key === "expected" || key === "expectedRevision") {
      if (!Number.isInteger(value)) throw new Error(`Compact patch line ${lineNumber} expected revision must be an integer`);
      expectedRevision = value;
      continue;
    }
    fields[key] = value;
  }
  return { fields, expectedRevision };
}

function parseCommand(line, lineNumber) {
  const tokens = tokenize(line, lineNumber);
  if (tokens.length < 2) throw new Error(`Compact patch line ${lineNumber} requires an action and target`);
  const action = tokens.shift();
  if (!["create", "update", "checkpoint", "source", "delete"].includes(action)) {
    throw new Error(`Compact patch line ${lineNumber} has unsupported action ${action}`);
  }
  const target = parseTarget(tokens.shift(), lineNumber);
  const inline = parseInlineFields(tokens, lineNumber);
  return {
    action,
    ...target,
    expectedRevision: target.expectedRevision ?? inline.expectedRevision,
    fields: inline.fields,
    line: lineNumber,
  };
}

function parseFieldLine(line, lineNumber) {
  const value = line.startsWith("set ") ? line.slice(4).trim() : line;
  const scalar = /^(\w+)<<$/.exec(value);
  if (scalar) return { type: "scalar", key: scalar[1] };
  const tokens = tokenize(value, lineNumber);
  if (tokens.length !== 1) throw new Error(`Compact patch line ${lineNumber} expects one key=value field`);
  const [key, parsedValue] = parseKeyValue(tokens[0], lineNumber);
  return { type: "field", key, value: parsedValue };
}

function assignField(operation, parsed, scalarValue) {
  if (parsed.type === "scalar") operation.fields[parsed.key] = scalarValue;
  else operation.fields[parsed.key] = parsed.value;
}

function parseHeader(line, lineNumber) {
  const match = HEADER_PATTERN.exec(line.trim());
  if (!match) throw new Error(`Compact patch must start with contextos/1 (line ${lineNumber})`);
  const version = Number(match[1]);
  if (version !== 1) throw new Error(`Unsupported compact patch version contextos/${version}`);
  const inline = parseInlineFields(match[2] ? tokenize(match[2], lineNumber) : [], lineNumber);
  return { version, metadata: inline.fields };
}

/**
 * Parse the intentionally small, Markdown-like write format. The parser does
 * not know the graph schema; service.mjs resolves targets and validates fields
 * through the same mutation path as graph_mutate.
 */
export function parseGraphPatch(input) {
  if (typeof input !== "string" || !input.trim()) throw new Error("patch is required");
  const lines = input.replace(/\r\n?/g, "\n").split("\n");
  let headerIndex = 0;
  while (headerIndex < lines.length && (!lines[headerIndex].trim() || lines[headerIndex].trim().startsWith("#"))) headerIndex += 1;
  if (headerIndex >= lines.length) throw new Error("patch is required");
  const header = parseHeader(lines[headerIndex], headerIndex + 1);
  const operations = [];
  let current = null;
  const flush = () => {
    if (!current) return;
    if (Object.keys(current.fields).length === 0 && current.action !== "source" && current.action !== "delete") {
      throw new Error(`Compact patch line ${current.line} has no fields; add key=value or end the operation`);
    }
    operations.push(current);
    current = null;
  };

  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    const raw = lines[index];
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line === "end") {
      flush();
      continue;
    }
    if (/^flow[:\s]/.test(line)) {
      flush();
      const flowExpr = line.replace(/^flow[:\s]+/, "").trim();
      if (!flowExpr) throw new Error(`Compact patch line ${index + 1} has an empty flow expression`);
      operations.push({
        action: "flow",
        flow: flowExpr,
        line: index + 1,
      });
      continue;
    }
    if (/^(create|update|checkpoint|source|delete)\s/.test(line)) {
      flush();
      current = parseCommand(line, index + 1);
      continue;
    }
    if (!current) throw new Error(`Compact patch line ${index + 1} is not attached to an operation`);
    const parsed = parseFieldLine(line, index + 1);
    if (parsed.type === "scalar") {
      const scalarLines = [];
      let closed = false;
      for (index += 1; index < lines.length; index += 1) {
        if (lines[index].trim() === ">>") {
          closed = true;
          break;
        }
        scalarLines.push(lines[index]);
      }
      if (!closed) throw new Error(`Compact patch field ${parsed.key} starting on line ${index + 1} is missing >>`);
      assignField(current, parsed, scalarLines.join("\n"));
    } else {
      assignField(current, parsed);
    }
  }
  flush();
  if (operations.length === 0) throw new Error("patch contains no operations");
  return { ...header, operations };
}

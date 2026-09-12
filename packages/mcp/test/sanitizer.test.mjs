import test from "node:test";
import assert from "node:assert/strict";
import { cleanControlCharacters, sanitizeTerminalOutput } from "../src/sanitizer.mjs";

test("sanitizer: cleanControlCharacters strips ANSI codes and progress bars", () => {
  const raw = "\u001b[32m✔ Build complete\u001b[39m [=====>    ] 50%\rFinished";
  const cleaned = cleanControlCharacters(raw);
  assert.ok(!cleaned.includes("\u001b"));
  assert.ok(cleaned.includes("Build complete"));
  assert.ok(cleaned.includes("Finished"));
});

test("sanitizer: routine successful build collapses into concise summary", () => {
  const lines = [
    "Building target Release...",
    "Compile CSQLite/shim.c",
    ...Array.from({ length: 100 }, (_, i) => `Compile Swift file_${i + 1}.swift`),
    "Linking executable...",
    "Build complete! 0 errors, 0 warnings.",
  ];
  const raw = lines.join("\n");
  const res = sanitizeTerminalOutput(raw, { exitCode: 0 });

  assert.equal(res.hasErrors, false);
  assert.ok(res.sanitizedLength < res.originalLength * 0.3); // >70% compression
  assert.ok(res.text.includes("Building target Release"));
  assert.ok(res.text.includes("Build complete"));
  assert.ok(res.text.includes("routine build output collapsed"));
});

test("sanitizer: captures error context and collapses intermediate noise", () => {
  const lines = [
    "Starting test suite...",
    "Running test 1",
    ...Array.from({ length: 60 }, (_, i) => `info: test detail ${i}`),
    "AssertionError: Expected 200 OK but received 500 Internal Server Error",
    "    at Object.test (/app/test/api.test.js:45:12)",
    "    at processTicksAndRejections (node:internal/process/task_queues:95:5)",
    ...Array.from({ length: 60 }, (_, i) => `info: cleanup detail ${i}`),
    "Summary: 1 failed, 12 passed.",
  ];
  const raw = lines.join("\n");
  const res = sanitizeTerminalOutput(raw, { exitCode: 1 });

  assert.equal(res.hasErrors, true);
  assert.ok(res.text.includes("AssertionError"));
  assert.ok(res.text.includes("/app/test/api.test.js:45:12"));
  assert.ok(res.text.includes("Summary: 1 failed"));
  assert.ok(res.text.includes("non-error output collapsed"));
  assert.ok(parseFloat(res.reductionRatio) > 50);
});

test("sanitizer: redacts credentials and local paths before returning context", () => {
  const res = sanitizeTerminalOutput(
    "OPENAI_API_KEY=sk-proj-secret123\nAuthorization: Bearer eyJsecret\n/Users/tester/project/src/app.ts:12",
    { exitCode: 0, projectRoot: "/Users/tester/project", homeDirectory: "/Users/tester" },
  );

  assert.equal(res.hasErrors, false);
  assert.ok(!res.text.includes("sk-proj-secret123"));
  assert.ok(!res.text.includes("eyJsecret"));
  assert.ok(!res.text.includes("/Users/tester/project"));
  assert.ok(res.text.includes("[REDACTED]"));
  assert.ok(res.text.includes("$PROJECT"));
  assert.ok(res.redactions >= 3);
});

test("sanitizer: explicit success exit code overrides failure words and maxChars is enforced", () => {
  const res = sanitizeTerminalOutput("test error context\n".repeat(50), { exitCode: 0, maxChars: 100 });
  assert.equal(res.hasErrors, false);
  assert.ok(res.finalChars <= 100);
});

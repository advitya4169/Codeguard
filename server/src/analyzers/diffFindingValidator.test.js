import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_FINDING_DIFF_CONTEXT_LINE_LENGTH,
  MAX_FINDING_DIFF_CONTEXT_LINES,
  extractFindingDiffContext,
  validateFindingsAgainstDiff,
  validateFindingsForReview,
} from "./diffFindingValidator.js";

const testFileDiff = `diff --git a/review-test.js b/review-test.js
--- a/review-test.js
+++ b/review-test.js
@@ -0,0 +1,16 @@
+function renderComment(comment) {
+  document.getElementById("comments").innerHTML = comment;
+}
+
+function calculateExpression(input) {
+  return eval(input);
+}
+
+async function getUser(db, userId) {
+  return db.query("SELECT * FROM users WHERE id = " + userId);
+}
`;

const finding = (overrides = {}) => ({
  category: "security",
  severity: "high",
  filePath: "review-test.js",
  lineNumber: 2,
  explanation:
    'Evidence: `document.getElementById("comments").innerHTML = comment;` Untrusted input is inserted as HTML, which can cause XSS in this test code.',
  suggestedFix: "Use textContent for plain text.",
  ...overrides,
});

test("rejects unsupported findings at added imports and contradicted declarations", () => {
  const importDiff = `diff --git a/server/src/workers/reviewWorker.js b/server/src/workers/reviewWorker.js
--- a/server/src/workers/reviewWorker.js
+++ b/server/src/workers/reviewWorker.js
@@ -0,0 +1,2 @@
+import { cleanDiff } from "../analyzers/staticAnalyzer.js";
+const result = cleanDiff(diff);
`;
  assert.deepEqual(
    validateFindingsAgainstDiff(
      [finding({
        filePath: "server/src/workers/reviewWorker.js",
        lineNumber: 1,
        explanation: 'Evidence: `import { cleanDiff }` The imported function is broken.',
      })],
      importDiff
    ),
    []
  );

  const declarationDiff = `diff --git a/server/src/analyzers/staticAnalyzer.js b/server/src/analyzers/staticAnalyzer.js
--- a/server/src/analyzers/staticAnalyzer.js
+++ b/server/src/analyzers/staticAnalyzer.js
@@ -0,0 +1,2 @@
+const validFiles = files.filter(Boolean);
+return validFiles;
`;
  assert.deepEqual(
    validateFindingsAgainstDiff(
      [finding({
        filePath: "server/src/analyzers/staticAnalyzer.js",
        lineNumber: 1,
        explanation: "Evidence: `const validFiles = files.filter(Boolean);` `validFiles` is undefined.",
      })],
      declarationDiff
    ),
    []
  );
});

test("maps a finding on a closing brace to the quoted vulnerable statement", () => {
  const [validated] = validateFindingsAgainstDiff(
    [finding({ lineNumber: 3 })],
    testFileDiff
  );
  assert.equal(validated.lineNumber, 2);
  assert.match(validated.explanation, /test code/);
});

test("keeps a valid SQL injection finding on the query-construction line", () => {
  const [validated] = validateFindingsAgainstDiff(
    [finding({
      lineNumber: 10,
      explanation: 'Evidence: `return db.query("SELECT * FROM users WHERE id = " + userId);` The untrusted ID is concatenated into SQL.',
    })],
    testFileDiff
  );
  assert.equal(validated.lineNumber, 10);
  assert.equal(validated.filePath, "review-test.js");
});

test("keeps a valid password-exposure finding on the exposing property", () => {
  const passwordDiff = `diff --git a/buggy-function.js b/buggy-function.js
--- a/buggy-function.js
+++ b/buggy-function.js
@@ -0,0 +1,3 @@
+const profile = {
+  password: user.password,
+};
`;
  const [validated] = validateFindingsAgainstDiff(
    [finding({
      filePath: "buggy-function.js",
      lineNumber: 2,
      explanation: "Evidence: `password: user.password,` The returned profile exposes the user's password.",
    })],
    passwordDiff
  );
  assert.equal(validated.lineNumber, 2);
});

test("rejects missing evidence and paths absent from the diff", () => {
  assert.deepEqual(
    validateFindingsAgainstDiff(
      [finding({ filePath: "unrelated.js" })],
      testFileDiff
    ),
    []
  );
  assert.deepEqual(
    validateFindingsAgainstDiff(
      [finding({ explanation: "Untrusted input may cause XSS." })],
      testFileDiff
    ),
    []
  );
});

test("maps findings across multiple files and diff hunks to added lines only", () => {
  const multiHunkDiff = `diff --git a/a.js b/a.js
--- a/a.js
+++ b/a.js
@@ -1,2 +1,3 @@
 context();
-removed();
+const query = "SELECT " + userInput;
@@ -20,1 +21,2 @@
 existing();
+sendPassword(user.password);
diff --git a/b.js b/b.js
--- a/b.js
+++ b/b.js
@@ -2,1 +2,2 @@
 old();
+run(input);
`;
  const findings = [
    finding({ filePath: 'a.js', lineNumber: 3, explanation: 'Evidence: `const query = "SELECT " + userInput;` Untrusted input reaches SQL.' }),
    finding({ filePath: 'a.js', lineNumber: 22, explanation: 'Evidence: `sendPassword(user.password);` A password is sent.' }),
    finding({ filePath: 'b.js', lineNumber: 3, explanation: 'Evidence: `run(input);` Untrusted input is executed.' }),
    finding({ filePath: 'a.js', lineNumber: 1, explanation: 'Evidence: `context();` This context line is unsafe.' }),
    finding({ filePath: 'a.js', lineNumber: 2, explanation: 'Evidence: `removed();` This removed line is unsafe.' }),
  ];

  const mapped = validateFindingsAgainstDiff(findings, multiHunkDiff);
  assert.deepEqual(mapped.map(({ filePath, lineNumber }) => [filePath, lineNumber]), [
    ['a.js', 2],
    ['a.js', 22],
    ['b.js', 3],
  ]);
});

test("keeps supported findings without a reliable anchor for the dashboard only", () => {
  const diff = `diff --git a/example.js b/example.js
--- a/example.js
+++ b/example.js
@@ -1,1 +1,2 @@
 old();
+const value = source;
`;
  const result = validateFindingsForReview([
    finding({
      filePath: 'example.js',
      lineNumber: 100,
      explanation: 'Evidence: `const value = source;` The untrusted source is used without validation.',
    }),
    finding({
      filePath: 'example.js',
      lineNumber: null,
      explanation: 'Evidence: `const value = source;` A second unsupported line number.',
    }),
  ], diff);

  assert.equal(result.commentableFindings.length, 0);
  assert.equal(result.unanchoredFindings.length, 1);
  assert.equal(result.unanchoredFindings[0].lineNumber, undefined);
});

test('stores actual added, removed, and unchanged lines with old/new numbers', () => {
  const diff = `diff --git a/src/query.js b/src/query.js
--- a/src/query.js
+++ b/src/query.js
@@ -10,4 +10,4 @@
 before();
-oldQuery();
+const query = "SELECT " + userInput;
 after();
`;
  const [validated] = validateFindingsAgainstDiff([finding({
    filePath: 'src/query.js',
    lineNumber: 11,
    explanation: 'Evidence: `const query = "SELECT " + userInput;` User input changes the SQL statement.',
  })], diff);

  const context = extractFindingDiffContext(validated, diff);
  assert.deepEqual(context, [
    { lineType: 'context', oldLineNumber: 10, newLineNumber: 10, code: 'before();', isTarget: false },
    { lineType: 'removed', oldLineNumber: 11, code: 'oldQuery();', isTarget: false },
    { lineType: 'added', newLineNumber: 11, code: 'const query = "SELECT " + userInput;', isTarget: true },
    { lineType: 'context', oldLineNumber: 12, newLineNumber: 12, code: 'after();', isTarget: false },
  ]);
});

test('extracts context from the correct hunk and file', () => {
  const diff = `diff --git a/src/query.js b/src/query.js
--- a/src/query.js
+++ b/src/query.js
@@ -1,1 +1,2 @@
 start();
+safe();
@@ -50,1 +51,2 @@
 before();
+const query = "SELECT " + userInput;
diff --git a/src/other.js b/src/other.js
--- a/src/other.js
+++ b/src/other.js
@@ -1,1 +1,2 @@
 old();
+run(input);
`;
  const [validated] = validateFindingsAgainstDiff([finding({
    filePath: 'src/query.js',
    lineNumber: 52,
    explanation: 'Evidence: `const query = "SELECT " + userInput;` User input changes the SQL statement.',
  })], diff);

  const context = extractFindingDiffContext(validated, diff);
  assert.deepEqual(context.map(({ lineType, oldLineNumber, newLineNumber, isTarget }) => ({
    lineType, oldLineNumber, newLineNumber, isTarget,
  })), [
    { lineType: 'context', oldLineNumber: 50, newLineNumber: 51, isTarget: false },
    { lineType: 'added', oldLineNumber: undefined, newLineNumber: 52, isTarget: true },
  ]);
  assert.equal(context.some(({ code }) => code === 'run(input);'), false);
});

test('does not invent a target for an unanchored finding', () => {
  const diff = `diff --git a/example.js b/example.js
--- a/example.js
+++ b/example.js
@@ -1,1 +1,2 @@
 old();
+const value = source;
`;
  const [unanchored] = validateFindingsForReview([finding({
    filePath: 'example.js',
    lineNumber: 100,
    explanation: 'Evidence: `const value = source;` The untrusted source is used without validation.',
  })], diff).unanchoredFindings;

  const context = extractFindingDiffContext(unanchored, diff);
  assert.equal(context.find(({ code }) => code === 'const value = source;').isTarget, false);
  assert.equal(unanchored.lineNumber, undefined);
});

test('bounds line count and long source lines', () => {
  const lines = Array.from({ length: 30 }, (_, index) => `+line${index + 1}();`).join('\n');
  const diff = `diff --git a/large.js b/large.js\n--- a/large.js\n+++ b/large.js\n@@ -0,0 +1,30 @@\n${lines}\n`;
  const [validated] = validateFindingsAgainstDiff([finding({
    filePath: 'large.js',
    lineNumber: 15,
    explanation: 'Evidence: `line15();` This line has a reported issue.',
  })], diff);
  const bounded = extractFindingDiffContext(validated, diff);
  assert.ok(bounded.length <= MAX_FINDING_DIFF_CONTEXT_LINES);
  assert.equal(bounded.filter(({ isTarget }) => isTarget).length, 1);

  const longLine = `const value = source; // ${'x'.repeat(MAX_FINDING_DIFF_CONTEXT_LINE_LENGTH + 20)}`;
  const longDiff = `diff --git a/long.js b/long.js\n--- a/long.js\n+++ b/long.js\n@@ -0,0 +1,1 @@\n+${longLine}\n`;
  const [longFinding] = validateFindingsAgainstDiff([finding({
    filePath: 'long.js',
    lineNumber: 1,
    explanation: 'Evidence: `const value = source;` This line has a reported issue.',
  })], longDiff);
  const [longContext] = extractFindingDiffContext(longFinding, longDiff);
  assert.equal(longContext.code.length, MAX_FINDING_DIFF_CONTEXT_LINE_LENGTH);
  assert.equal(longContext.truncated, true);
});

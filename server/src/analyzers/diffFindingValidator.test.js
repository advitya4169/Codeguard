import test from "node:test";
import assert from "node:assert/strict";

import { validateFindingsAgainstDiff } from "./diffFindingValidator.js";

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

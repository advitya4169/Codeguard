import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import Finding from './Finding.js';

const validFinding = (fields = {}) => new Finding({
  reviewJobId: new mongoose.Types.ObjectId(),
  category: 'security',
  severity: 'high',
  filePath: 'src/query.js',
  lineNumber: 12,
  explanation: 'Evidence: `query(input)` — User input reaches the query.',
  ...fields,
});

test('Finding title is optional for existing title-less documents', async () => {
  const finding = validFinding();

  assert.equal(Finding.schema.path('title').instance, 'String');
  assert.equal(Boolean(Finding.schema.path('title').isRequired), false);
  await assert.doesNotReject(finding.validate());
  assert.equal(finding.title, undefined);
});

test('Finding model retains and trims an optional title', async () => {
  const finding = validFinding({ title: ' SQL injection in query ' });

  await finding.validate();

  assert.equal(finding.title, 'SQL injection in query');
});

test('Finding model stores bounded structured diff context for a review revision', async () => {
  const finding = validFinding({
    diffContext: [
      { lineType: 'removed', oldLineNumber: 11, code: 'oldQuery();' },
      { lineType: 'added', newLineNumber: 11, code: 'query(userInput);', isTarget: true },
    ],
  });

  await finding.validate();

  assert.equal(finding.diffContext[0].oldLineNumber, 11);
  assert.equal(finding.diffContext[0].newLineNumber, undefined);
  assert.equal(finding.diffContext[1].newLineNumber, 11);
  assert.equal(finding.diffContext[1].isTarget, true);
});

test('old findings without diff context remain valid', async () => {
  const finding = validFinding();

  await finding.validate();

  assert.equal(finding.diffContext, undefined);
});

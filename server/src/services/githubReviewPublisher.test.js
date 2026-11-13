import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createCodeGuardMarker,
  createGitHubReviewPublisher,
} from './githubReviewPublisher.js';

const baseInput = {
  repositoryId: 'repo-1',
  repoFullName: 'owner/repo',
  prNumber: 12,
  commitSha: 'commit-abc',
  accessToken: 'test-token',
  commentableFindings: [
    { category: 'security', severity: 'high', filePath: 'src/a.js', lineNumber: 9, explanation: 'Evidence: `query(userInput)` — SQL injection.', suggestedFix: 'Use a parameterized query.' },
    { category: 'bug', severity: 'medium', filePath: 'src/b.js', lineNumber: 4, explanation: 'Evidence: `return null` — unexpected null result.' },
  ],
  unanchoredFindings: [
    { category: 'security', severity: 'low', filePath: 'src/c.js', explanation: 'Evidence: `source()` — unsafe behavior.', suggestedFix: 'Validate input.' },
  ],
};

const publisherWith = (overrides = {}) => createGitHubReviewPublisher({
  getPRHeadShaFn: async () => baseInput.commitSha,
  listPRReviewsFn: async () => [],
  listPRCommentsFn: async () => [],
  createPRReviewFn: async () => ({ data: { id: 10, html_url: 'review-url' }, status: 201 }),
  postPRCommentFn: async () => ({ data: { id: 20, html_url: 'comment-url' }, status: 201 }),
  ...overrides,
});

test('creates one grouped review with exact commit and modern line/side fields', async () => {
  let payload;
  const publisher = publisherWith({
    createPRReviewFn: async (_repo, _number, _token, body) => {
      payload = body;
      return { data: { id: 10 }, status: 201 };
    },
  });

  const result = await publisher(baseInput);
  assert.equal(result.status, 'published');
  assert.equal(result.responseStatus, 201);
  assert.equal(payload.commit_id, baseInput.commitSha);
  assert.equal(payload.event, 'COMMENT');
  assert.equal(payload.comments.length, 2);
  assert.deepEqual(payload.comments.map(({ path, line, side }) => ({ path, line, side })), [
    { path: 'src/a.js', line: 9, side: 'RIGHT' },
    { path: 'src/b.js', line: 4, side: 'RIGHT' },
  ]);
  assert.match(payload.comments[0].body, /Category:\*\* security/);
  assert.match(payload.comments[0].body, /Suggested fix/);
  assert.match(payload.body, /2 inline comments are attached/);
  assert.match(payload.body, /without a reliable changed-line location/);
  assert.match(payload.body, /codeguard-review:v1:/);
});

test('review body does not claim inline comments when there are no commentable findings', async () => {
  let payload;
  const publisher = publisherWith({
    createPRReviewFn: async (_repo, _number, _token, body) => {
      payload = body;
      return { data: { id: 11 }, status: 201 };
    },
  });

  const result = await publisher({
    ...baseInput,
    commentableFindings: [],
    unanchoredFindings: [baseInput.unanchoredFindings[0]],
  });

  assert.equal(result.status, 'published');
  assert.equal(result.inlineCount, 0);
  assert.match(payload.body, /No inline comments were attached/);
  assert.match(payload.body, /Findings without a reliable changed-line location/);
  assert.doesNotMatch(payload.body, /inline comments are attached/i);
  assert.match(payload.body, /codeguard-review:v1:/);
});

test('skips publication when the PR head is stale before publication', async () => {
  let created = false;
  const publisher = publisherWith({
    getPRHeadShaFn: async () => 'newer-commit',
    createPRReviewFn: async () => { created = true; },
  });
  const result = await publisher(baseInput);
  assert.equal(result.status, 'stale');
  assert.equal(created, false);
});

test('rechecks the head after marker lookup immediately before creating a review', async () => {
  let headCalls = 0;
  let created = false;
  const publisher = publisherWith({
    getPRHeadShaFn: async () => (headCalls++ === 0 ? baseInput.commitSha : 'newer-commit'),
    createPRReviewFn: async () => { created = true; },
  });
  const result = await publisher(baseInput);
  assert.equal(result.status, 'stale');
  assert.equal(headCalls, 2);
  assert.equal(created, false);
});

test('finds an existing marker before publishing a duplicate', async () => {
  const marker = createCodeGuardMarker(baseInput.repositoryId, baseInput.prNumber, baseInput.commitSha);
  let created = false;
  const publisher = publisherWith({
    listPRReviewsFn: async () => [{ id: 7, body: `previous\n${marker}`, commit_id: baseInput.commitSha }],
    createPRReviewFn: async () => { created = true; },
  });
  const result = await publisher(baseInput);
  assert.equal(result.status, 'duplicate');
  assert.equal(result.id, 7);
  assert.equal(created, false);
});

test('ambiguous review write checks for acceptance and never blindly falls back', async () => {
  let reviewLookups = 0;
  let fallbackCalls = 0;
  const publisher = publisherWith({
    listPRReviewsFn: async () => {
      reviewLookups += 1;
      return [];
    },
    createPRReviewFn: async () => {
      const error = new Error('network error');
      error.ambiguous = true;
      throw error;
    },
    postPRCommentFn: async () => { fallbackCalls += 1; },
  });
  const result = await publisher(baseInput);
  assert.equal(result.status, 'uncertain');
  assert.equal(reviewLookups, 2);
  assert.equal(fallbackCalls, 0);
});

test('a retry after GitHub accepted a review finds the marker and skips a second write', async () => {
  const marker = createCodeGuardMarker(baseInput.repositoryId, baseInput.prNumber, baseInput.commitSha);
  let accepted = false;
  let creates = 0;
  const publisher = publisherWith({
    listPRReviewsFn: async () => accepted
      ? [{ id: 88, body: marker, commit_id: baseInput.commitSha }]
      : [],
    createPRReviewFn: async () => {
      creates += 1;
      accepted = true;
      return { data: { id: 88 }, status: 201 };
    },
  });

  assert.equal((await publisher(baseInput)).status, 'published');
  assert.equal((await publisher(baseInput)).status, 'duplicate');
  assert.equal(creates, 1);
});

test('falls back to one general comment only after a definitive review rejection and marker recheck', async () => {
  let fallbackBody;
  let lookupCount = 0;
  const publisher = publisherWith({
    listPRReviewsFn: async () => { lookupCount += 1; return []; },
    createPRReviewFn: async () => {
      const error = new Error('position invalid');
      error.status = 422;
      throw error;
    },
    postPRCommentFn: async (_repo, _number, _token, body) => {
      fallbackBody = body;
      return { data: { id: 20 }, status: 201 };
    },
  });

  const result = await publisher(baseInput);
  assert.equal(result.status, 'published');
  assert.equal(result.type, 'comment');
  assert.equal(result.responseStatus, 201);
  assert.equal(lookupCount, 2);
  assert.match(fallbackBody, /src\/a.js/);
  assert.match(fallbackBody, /src\/c.js/);
});

test('uses the existing general-comment route after a permission rejection', async () => {
  let fallbackCalls = 0;
  const publisher = publisherWith({
    createPRReviewFn: async () => {
      const error = new Error('write permission missing');
      error.status = 403;
      throw error;
    },
    postPRCommentFn: async () => {
      fallbackCalls += 1;
      return { data: { id: 20 }, status: 201 };
    },
  });

  const result = await publisher(baseInput);
  assert.equal(result.status, 'published');
  assert.equal(result.type, 'comment');
  assert.equal(fallbackCalls, 1);
});


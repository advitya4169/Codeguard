import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { Backoffs } from 'bullmq';
import { redisConnection } from '../config/redis.js';
import { calculateReviewBackoff } from '../services/groqService.js';

process.env.GROQ_API_KEY ||= 'test-only-key';
const { createReviewProcessor, MAX_REVIEW_DIFF_BYTES, parseReviewResponse, startReviewWorker } = await import('./reviewWorker.js');
after(() => redisConnection.disconnect());

const commitSha = 'a'.repeat(40);
const userId = '507f1f77bcf86cd799439011';
const diff = `diff --git a/src/query.js b/src/query.js
--- a/src/query.js
+++ b/src/query.js
@@ -1,1 +1,2 @@
 const connection = connect();
+const result = db.query("SELECT * FROM users WHERE id = " + userInput);
diff --git a/src/profile.js b/src/profile.js
--- a/src/profile.js
+++ b/src/profile.js
@@ -2,1 +2,2 @@
 const profile = {};
+profile.password = user.password;
`;

const aiFindings = [
  {
    title: 'SQL injection in search query',
    category: 'security',
    severity: 'high',
    filePath: 'src/query.js',
    lineNumber: 2,
    explanation: 'Evidence: `const result = db.query("SELECT * FROM users WHERE id = " + userInput);` Untrusted input is concatenated into SQL.',
    suggestedFix: 'Use a parameterized query.',
  },
  {
    category: 'security',
    severity: 'medium',
    filePath: 'src/profile.js',
    lineNumber: 3,
    explanation: 'Evidence: `profile.password = user.password;` The password is exposed in a profile response.',
    suggestedFix: 'Omit the password field.',
  },
];

const reviewResponse = (finding) => JSON.stringify({ findings: [
  {
    title: 'SQL injection in query',
    category: 'security',
    severity: 'high',
    filePath: 'src/query.js',
    lineNumber: 2,
    explanation: 'Evidence: `query(input)` — User input reaches the query.',
    suggestedFix: 'Use a parameterized query.',
    ...finding,
  },
] });

test('parses a valid finding title', () => {
  const [finding] = parseReviewResponse(reviewResponse({ title: '  SQL injection in query  ' }));
  assert.equal(finding.title, 'SQL injection in query');
});

test('accepts a finding without a title for frontend fallback', () => {
  const response = JSON.parse(reviewResponse({}));
  delete response.findings[0].title;
  const [finding] = parseReviewResponse(JSON.stringify(response));
  assert.equal(Object.hasOwn(finding, 'title'), false);
  assert.equal(finding.filePath, 'src/query.js');
});

test('omits empty and malformed titles without rejecting otherwise valid findings', () => {
  for (const title of ['', '   ', null, 42, 'one two three four five six seven eight nine', 'x'.repeat(121)]) {
    const [finding] = parseReviewResponse(reviewResponse({ title }));
    assert.equal(Object.hasOwn(finding, 'title'), false);
    assert.equal(finding.category, 'security');
  }
});

test('still rejects findings with invalid established fields', () => {
  assert.throws(
    () => parseReviewResponse(reviewResponse({ category: 'unknown' })),
    /invalid fields/,
  );
});

const createHarness = ({
  appBacked = false,
  heads = [commitSha, commitSha, commitSha],
  findings = aiFindings,
  overrides = {},
} = {}) => {
  const reviewDocument = {
    _id: 'review-db-id',
    status: 'queued',
    save: async () => {},
  };
  const persistedFindings = [];
  const calls = { analyze: 0, diff: 0, createReview: 0, generalComment: 0, token: 0, head: 0 };
  const repository = {
    _id: 'repository-db-id',
    userId,
    githubRepoId: 123,
    fullName: 'owner/repo',
    isConnected: true,
    installationId: appBacked ? '777' : null,
    isHookActive: true,
  };
  const processor = createReviewProcessor({
    ReviewJobModel: {
      findOneAndUpdate: async () => reviewDocument,
    },
    FindingModel: {
      deleteMany: async () => {},
      insertMany: async (documents) => { persistedFindings.push(...documents); },
    },
    RepositoryModel: {
      findOne: async () => repository,
    },
    InstallationModel: {
      findOne: async () => appBacked ? { installationId: '777', userId, status: 'active' } : null,
    },
    getInstallationAccessTokenFn: async () => {
      calls.token += 1;
      return { token: 'installation-token', expiresAt: new Date(Date.now() + 60_000).toISOString() };
    },
    getPRHeadShaFn: async () => heads[Math.min(calls.head++, heads.length - 1)],
    getPRDiffFn: async (_name, _number, token) => {
      calls.diff += 1;
      calls.diffToken = token;
      return diff;
    },
    analyzeDiffFn: async () => {
      calls.analyze += 1;
      return findings;
    },
    listPRReviewsFn: async () => [],
    listPRCommentsFn: async () => [],
    createPRReviewFn: async (_name, _number, _token, payload) => {
      calls.createReview += 1;
      calls.payload = payload;
      return { data: { id: 99, html_url: 'review-url' }, status: 201 };
    },
    postPRCommentFn: async () => {
      calls.generalComment += 1;
      return { data: { id: 100 }, status: 201 };
    },
    logger: { log() {}, error() {} },
    ...overrides,
  });
  const job = {
    data: {
      prNumber: 14,
      repoFullName: 'owner/repo',
      commitSha,
      userId,
      githubRepoId: 123,
      ...(appBacked ? { installationId: '777' } : { accessToken: 'oauth-token' }),
    },
    opts: { attempts: 3 },
    attemptsMade: 0,
    updateProgress: async () => {},
  };
  return { processor, job, calls, persistedFindings, reviewDocument };
};

test('publishes validated findings as grouped inline comments on exact changed lines', async () => {
  const harness = createHarness();
  const result = await harness.processor(harness.job);

  assert.equal(result.status, 'success');
  assert.equal(harness.persistedFindings.length, 2);
  assert.equal(harness.persistedFindings[0].title, 'SQL injection in search query');
  assert.deepEqual(harness.persistedFindings[0].diffContext, [
    {
      lineType: 'context',
      oldLineNumber: 1,
      newLineNumber: 1,
      code: 'const connection = connect();',
      isTarget: false,
    },
    {
      lineType: 'added',
      newLineNumber: 2,
      code: 'const result = db.query("SELECT * FROM users WHERE id = " + userInput);',
      isTarget: true,
    },
  ]);
  assert.equal(harness.calls.createReview, 1);
  assert.equal(harness.calls.payload.commit_id, commitSha);
  assert.equal(harness.calls.payload.event, 'COMMENT');
  assert.deepEqual(harness.calls.payload.comments.map(({ path, line, side }) => ({ path, line, side })), [
    { path: 'src/query.js', line: 2, side: 'RIGHT' },
    { path: 'src/profile.js', line: 3, side: 'RIGHT' },
  ]);
});

test('normal-sized diff proceeds through analysis and publication', async () => {
  const harness = createHarness();

  assert.ok(Buffer.byteLength(diff, 'utf8') < MAX_REVIEW_DIFF_BYTES);
  const result = await harness.processor(harness.job);

  assert.equal(result.status, 'success');
  assert.equal(harness.calls.analyze, 1);
  assert.equal(harness.calls.createReview, 1);
});

test('oversized cleaned diff fails visibly without Groq or GitHub publication', async () => {
  const oversizedDiff = `diff --git a/large.js b/large.js\n--- a/large.js\n+++ b/large.js\n${'x'.repeat(MAX_REVIEW_DIFF_BYTES + 1)}`;
  const harness = createHarness({
    overrides: {
      getPRDiffFn: async () => oversizedDiff,
    },
  });
  harness.job.opts.attempts = 1;

  await assert.rejects(harness.processor(harness.job), /too large for a reliable AI review/);

  assert.equal(harness.calls.analyze, 0);
  assert.equal(harness.calls.createReview, 0);
  assert.equal(harness.calls.generalComment, 0);
  assert.equal(harness.reviewDocument.status, 'failed');
  assert.match(harness.reviewDocument.summary, /maximum 96000 UTF-8 bytes/);
  assert.match(harness.reviewDocument.summary, /split the changes into smaller pull requests/);
});

test('marks a queued stale commit before diff retrieval or AI analysis', async () => {
  const harness = createHarness({ heads: ['newer-commit'] });
  const result = await harness.processor(harness.job);
  assert.equal(result.status, 'stale');
  assert.equal(harness.calls.diff, 0);
  assert.equal(harness.calls.analyze, 0);
  assert.equal(harness.reviewDocument.status, 'stale');
});

test('keeps saved findings but skips GitHub publication if the head changes before publishing', async () => {
  const harness = createHarness({ heads: [commitSha, commitSha, 'newer-commit'] });
  const result = await harness.processor(harness.job);
  assert.equal(result.status, 'success');
  assert.equal(harness.persistedFindings.length, 2);
  assert.equal(harness.calls.createReview, 0);
  assert.equal(harness.reviewDocument.status, 'completed');
  assert.equal(harness.reviewDocument.githubPublicationStatus, 'stale');
});

test('legacy OAuth repositories continue using their queued OAuth token', async () => {
  const harness = createHarness();
  const result = await harness.processor(harness.job);
  assert.equal(result.status, 'success');
  assert.equal(harness.calls.diffToken, 'oauth-token');
  assert.equal(harness.calls.token, 0);
  assert.equal(harness.calls.createReview, 1);
});

test('App-backed jobs use an in-memory installation token without changing job data', async () => {
  const harness = createHarness({ appBacked: true });
  const originalJobData = structuredClone(harness.job.data);
  await harness.processor(harness.job);
  assert.equal(harness.calls.diffToken, 'installation-token');
  assert.equal(harness.calls.token, 1);
  assert.deepEqual(harness.job.data, originalJobData);
});

test('zero findings are saved as complete without calling GitHub write endpoints', async () => {
  const harness = createHarness({ findings: [] });
  const result = await harness.processor(harness.job);
  assert.equal(result.findingsCount, 0);
  assert.equal(harness.calls.createReview, 0);
  assert.equal(harness.calls.generalComment, 0);
  assert.equal(harness.reviewDocument.githubPublicationStatus, 'not_needed');
});

test('GitHub publishing failures keep persisted analysis complete and do not repeat Groq analysis', async () => {
  const harness = createHarness({
    overrides: {
      createPRReviewFn: async () => {
        const error = new Error('permission denied');
        error.status = 403;
        throw error;
      },
      postPRCommentFn: async () => {
        const error = new Error('comment network failure');
        error.ambiguous = true;
        throw error;
      },
    },
  });

  const result = await harness.processor(harness.job);
  assert.equal(result.status, 'success');
  assert.equal(harness.calls.analyze, 1);
  assert.equal(harness.persistedFindings.length, 2);
  assert.equal(harness.reviewDocument.status, 'completed');
  assert.equal(harness.reviewDocument.githubPublicationStatus, 'uncertain');
});

test('parseReviewResponse throws GroqTruncatedResponseError when finish_reason is length', () => {
  assert.throws(
    () => parseReviewResponse('{"findings": [{"title": "Truncated', { finish_reason: 'length' }),
    (err) => {
      assert.equal(err.name, 'GroqTruncatedResponseError');
      assert.equal(err.finishReason, 'length');
      assert.match(err.message, /token limit was reached/);
      return true;
    },
  );
});

test('handles rate-limit 429 response by switching backoff to custom and reporting scheduled retry in summary', async () => {
  const rateLimitError = new Error('Rate limit reached');
  rateLimitError.status = 429;
  rateLimitError.headers = { 'retry-after': '30' };

  const harness = createHarness({
    overrides: {
      analyzeDiffFn: async () => {
        throw rateLimitError;
      },
    },
  });

  harness.job.opts.attempts = 3;
  harness.job.attemptsMade = 0;
  harness.job.opts.backoff = { type: 'exponential', delay: 5000 };

  await assert.rejects(harness.processor(harness.job), /Rate limit reached/);
  assert.equal(harness.reviewDocument.status, 'queued');
  assert.match(harness.reviewDocument.summary, /Rate limit reached\. Automatic retry scheduled in 30s\./);
  assert.equal(harness.job.opts.backoff.type, 'custom');
});

test('marks permanent error as unrecoverable without automatic retries', async () => {
  const authError = new Error('Invalid API Key');
  authError.status = 401;

  const harness = createHarness({
    overrides: {
      analyzeDiffFn: async () => {
        throw authError;
      },
    },
  });

  harness.job.opts.attempts = 3;
  harness.job.attemptsMade = 0;

  await assert.rejects(
    harness.processor(harness.job),
    (err) => {
      assert.equal(err.name, 'UnrecoverableError');
      return true;
    },
  );
  assert.equal(harness.reviewDocument.status, 'failed');
  assert.match(harness.reviewDocument.summary, /Invalid API Key/);
});

test('startReviewWorker registers calculateReviewBackoff under settings.backoffStrategy while preserving concurrency', async () => {
  const worker = startReviewWorker({
    autorun: false,
    connection: { host: '127.0.0.1', port: 6379, lazyConnect: true },
  });
  try {
    assert.equal(worker.opts.concurrency, 5);
    assert.equal(worker.opts.settings?.backoffStrategy, calculateReviewBackoff);
  } finally {
    await worker.close();
  }
});

test('registered worker backoffStrategy calculates custom delayed retry for HTTP 429 rate-limit errors', async () => {
  const worker = startReviewWorker({
    autorun: false,
    connection: { host: '127.0.0.1', port: 6379, lazyConnect: true },
  });

  try {
    const registeredStrategy = worker.opts.settings?.backoffStrategy;
    assert.equal(typeof registeredStrategy, 'function');

    const rateLimitError = new Error('Rate limit reached');
    rateLimitError.status = 429;
    rateLimitError.headers = { 'retry-after': '45' };

    const job = {
      attemptsMade: 1,
      opts: {
        backoff: { type: 'custom', delay: 5000 },
      },
    };

    // Verify registered strategy directly
    const directDelay = registeredStrategy(job.attemptsMade, 'custom', rateLimitError, job);
    assert.equal(directDelay, 45_000);

    // Verify with BullMQ Backoffs.calculate using the worker's registered strategy
    const calculatedDelay = Backoffs.calculate(
      job.opts.backoff,
      job.attemptsMade,
      rateLimitError,
      job,
      registeredStrategy,
    );
    assert.equal(calculatedDelay, 45_000);
  } finally {
    await worker.close();
  }
});

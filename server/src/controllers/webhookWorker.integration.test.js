import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';

const originalGroqApiKey = process.env.GROQ_API_KEY;
const originalRedisUrl = process.env.REDIS_URL;
process.env.GROQ_API_KEY = 'integration-test-only-key';
// Keep module-level BullMQ clients away from any configured deployment Redis.
process.env.REDIS_URL = 'redis://127.0.0.1:6379/15';
const testSecret = 'webhook-integration-test-secret';
const originalWebhookSecret = process.env.WEBHOOK_SECRET;
process.env.WEBHOOK_SECRET = testSecret;

const [{ createGithubWebhookHandler }, { createWebhookRouter }, { createReviewProcessor }, { redisConnection }, { reviewQueue }] = await Promise.all([
  import('../controllers/webhookController.js'),
  import('../routes/webhookRoutes.js'),
  import('../workers/reviewWorker.js'),
  import('../config/redis.js'),
  import('../config/queue.js'),
]);

after(async () => {
  if (originalWebhookSecret === undefined) delete process.env.WEBHOOK_SECRET;
  else process.env.WEBHOOK_SECRET = originalWebhookSecret;
  await reviewQueue.close();
  await redisConnection.disconnect();
  if (originalGroqApiKey === undefined) delete process.env.GROQ_API_KEY;
  else process.env.GROQ_API_KEY = originalGroqApiKey;
  if (originalRedisUrl === undefined) delete process.env.REDIS_URL;
  else process.env.REDIS_URL = originalRedisUrl;
});

const userId = '507f1f77bcf86cd799439011';
const repository = {
  _id: 'repository-db-id',
  userId,
  githubRepoId: 1234,
  fullName: 'owner/repo',
  isConnected: true,
  installationId: null,
};
const diff = `diff --git a/src/query.js b/src/query.js
--- a/src/query.js
+++ b/src/query.js
@@ -1,1 +1,2 @@
 const connection = connect();
+const result = db.query("SELECT * FROM users WHERE id = " + userInput);
`;
const findings = [{
  category: 'security',
  severity: 'high',
  filePath: 'src/query.js',
  lineNumber: 2,
  explanation: 'Evidence: `const result = db.query("SELECT * FROM users WHERE id = " + userInput);` Untrusted input is concatenated into SQL.',
  suggestedFix: 'Use a parameterized query.',
}];

const identityKey = ({ repositoryId, prNumber, commitSha }) => `${repositoryId}:${prNumber}:${commitSha}`;
const createWebhookPayload = (action, commitSha) => ({
  action,
  repository: { id: repository.githubRepoId },
  pull_request: { number: 14, head: { sha: commitSha } },
});

const createHarness = async ({ diffFetchError, analysisError, headShaFor } = {}) => {
  const jobsById = new Map();
  const reviews = new Map();
  const persistedFindings = new Map();
  const githubReviews = [];
  const calls = { queueAdd: 0, jobCreated: 0, diff: 0, analyze: 0, publish: 0 };

  const queue = {
    add: async (name, data, opts) => {
      calls.queueAdd += 1;
      if (jobsById.has(opts.jobId)) return jobsById.get(opts.jobId);
      const job = {
        id: opts.jobId,
        name,
        data,
        opts,
        attemptsMade: 0,
        updateProgress: async () => {},
      };
      calls.jobCreated += 1;
      jobsById.set(opts.jobId, job);
      return job;
    },
  };

  const ReviewJobModel = {
    updateOne: async (identity, update) => {
      const key = identityKey(identity);
      if (!reviews.has(key)) {
        reviews.set(key, {
          _id: `review-${identity.prNumber}-${identity.commitSha}`,
          ...identity,
          ...update.$setOnInsert,
          async save() { reviews.set(key, this); },
        });
      }
      return { acknowledged: true };
    },
    findOneAndUpdate: async (identity, update) => {
      const key = identityKey(identity);
      let review = reviews.get(key);
      if (!review) {
        review = {
          _id: `review-${identity.prNumber}-${identity.commitSha}`,
          ...identity,
          status: 'queued',
          async save() { reviews.set(key, this); },
        };
      }
      Object.assign(review, update.$set || {});
      for (const field of Object.keys(update.$unset || {})) delete review[field];
      reviews.set(key, review);
      return review;
    },
  };

  const webhookHandler = createGithubWebhookHandler({
    UserModel: { findById: async () => ({ _id: userId, accessToken: 'mock-oauth-token' }) },
    InstallationModel: { findOne: async () => null },
    RepositoryModel: { findOne: async () => repository },
    ReviewJobModel,
    queue,
    logger: { log() {}, error() {} },
  });

  const app = express();
  app.use(express.json({
    verify: (req, res, buffer) => {
      if (req.path === '/api/webhooks/github') req.rawBody = Buffer.from(buffer);
    },
  }));
  app.use('/api/webhooks', createWebhookRouter(webhookHandler));
  const server = await new Promise((resolve) => {
    const listeningServer = app.listen(0, '127.0.0.1', () => resolve(listeningServer));
  });
  const address = server.address();

  const sendWebhook = async ({ event = 'pull_request', payload, signature } = {}) => {
    const rawBody = Buffer.from(JSON.stringify(payload));
    const validSignature = `sha256=${crypto.createHmac('sha256', testSecret).update(rawBody).digest('hex')}`;
    const response = await fetch(`http://127.0.0.1:${address.port}/api/webhooks/github`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': event,
        'X-Hub-Signature-256': signature ?? validSignature,
      },
      body: rawBody,
    });
    return { status: response.status, body: await response.text() };
  };

  const processor = createReviewProcessor({
    ReviewJobModel,
    FindingModel: {
      deleteMany: async ({ reviewJobId }) => persistedFindings.delete(reviewJobId),
      insertMany: async (documents) => persistedFindings.set(documents[0].reviewJobId, documents),
    },
    RepositoryModel: { findOne: async () => repository },
    InstallationModel: { findOne: async () => null },
    getPRHeadShaFn: async (_repo, _pr, _token, job) => headShaFor?.(job) ?? activeHeadSha,
    getPRDiffFn: async () => {
      calls.diff += 1;
      if (diffFetchError) throw diffFetchError;
      return diff;
    },
    analyzeDiffFn: async () => {
      calls.analyze += 1;
      if (analysisError) throw analysisError;
      return findings;
    },
    listPRReviewsFn: async () => githubReviews,
    listPRCommentsFn: async () => [],
    createPRReviewFn: async (_repo, _pr, _token, body) => {
      calls.publish += 1;
      const created = {
        id: calls.publish,
        html_url: `https://github.com/owner/repo/pull/14#review-${calls.publish}`,
        body: body.body,
        commit_id: body.commit_id,
      };
      githubReviews.push(created);
      return { data: created, status: 201 };
    },
    postPRCommentFn: async () => {
      throw new Error('Unexpected fallback comment in integration test.');
    },
    logger: { log() {}, error() {} },
  });

  let activeHeadSha = null;
  const processQueuedJob = async (job, attemptsMade = 0) => {
    activeHeadSha = job.data.commitSha;
    job.attemptsMade = attemptsMade;
    return processor(job);
  };

  return {
    calls,
    githubReviews,
    jobsById,
    processQueuedJob,
    reviews,
    sendWebhook,
    async close() {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
};

test('valid opened webhook queues the expected job and the worker persists findings and publication', async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const sha = 'a'.repeat(40);

  const response = await harness.sendWebhook({ payload: createWebhookPayload('opened', sha) });
  assert.equal(response.status, 200);
  assert.equal(response.body, 'Webhook received');
  assert.equal(harness.calls.jobCreated, 1);

  const job = harness.jobsById.get(`pr-1234-14-${sha}`);
  assert.equal(job.name, 'process-pr-review');
  assert.deepEqual(job.opts, {
    jobId: `pr-1234-14-${sha}`,
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
  });
  assert.deepEqual(job.data, {
    prNumber: 14,
    repoFullName: 'owner/repo',
    commitSha: sha,
    action: 'opened',
    userId,
    githubRepoId: 1234,
    accessToken: 'mock-oauth-token',
  });

  await harness.processQueuedJob(job);
  const savedReview = [...harness.reviews.values()][0];
  assert.equal(savedReview.status, 'completed');
  assert.equal(savedReview.summary, 'Processed 1 findings.');
  assert.equal(savedReview.githubPublicationStatus, 'published');
  assert.equal(harness.calls.analyze, 1);
  assert.equal(harness.calls.publish, 1);
});

test('synchronize webhook creates and processes a new revision while retaining the previous one', async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const firstSha = 'b'.repeat(40);
  const nextSha = 'c'.repeat(40);

  await harness.sendWebhook({ payload: createWebhookPayload('opened', firstSha) });
  await harness.processQueuedJob(harness.jobsById.get(`pr-1234-14-${firstSha}`));
  await harness.sendWebhook({ payload: createWebhookPayload('synchronize', nextSha) });
  await harness.processQueuedJob(harness.jobsById.get(`pr-1234-14-${nextSha}`));

  assert.equal(harness.reviews.size, 2);
  assert.equal(harness.reviews.get(identityKey({ repositoryId: repository._id, prNumber: 14, commitSha: firstSha })).status, 'completed');
  assert.equal(harness.reviews.get(identityKey({ repositoryId: repository._id, prNumber: 14, commitSha: nextSha })).status, 'completed');
  assert.equal(harness.calls.jobCreated, 2);
  assert.equal(harness.calls.publish, 2);
});

test('duplicate webhook delivery reuses one deterministic job and publication marker prevents a second write', async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const sha = 'd'.repeat(40);
  const payload = createWebhookPayload('opened', sha);

  assert.equal((await harness.sendWebhook({ payload })).status, 200);
  assert.equal((await harness.sendWebhook({ payload })).status, 200);
  assert.equal(harness.calls.queueAdd, 2);
  assert.equal(harness.calls.jobCreated, 1);

  const job = harness.jobsById.get(`pr-1234-14-${sha}`);
  await harness.processQueuedJob(job);
  assert.equal(harness.calls.analyze, 1);
  assert.equal(harness.calls.publish, 1);

  // Simulate an unexpected processor replay after GitHub accepted the first write.
  await harness.processQueuedJob(job);
  assert.equal(harness.calls.publish, 1);
  assert.equal(harness.reviews.get(identityKey({ repositoryId: repository._id, prNumber: 14, commitSha: sha })).githubPublicationStatus, 'duplicate');
});

test('unsupported webhook event types and pull request actions do not enqueue jobs', async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());

  const actionResponse = await harness.sendWebhook({ payload: createWebhookPayload('closed', 'e'.repeat(40)) });
  const eventResponse = await harness.sendWebhook({
    event: 'issues',
    payload: { action: 'opened', repository: { id: repository.githubRepoId } },
  });

  assert.equal(actionResponse.status, 200);
  assert.equal(eventResponse.status, 200);
  assert.equal(harness.calls.queueAdd, 0);
  assert.equal(harness.calls.jobCreated, 0);
});

test('invalid raw-body webhook signature is rejected without queue insertion', async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());

  const response = await harness.sendWebhook({
    payload: createWebhookPayload('opened', 'f'.repeat(40)),
    signature: `sha256=${'0'.repeat(64)}`,
  });

  assert.equal(response.status, 401);
  assert.equal(response.body, 'Unauthorized');
  assert.equal(harness.calls.queueAdd, 0);
});

test('diff and AI failures follow BullMQ retry attempts and persist terminal failure', async (t) => {
  await t.test('GitHub diff failure', async (st) => {
    const harness = await createHarness({ diffFetchError: new Error('mocked GitHub diff failure') });
    st.after(() => harness.close());
    const sha = '1'.repeat(40);
    await harness.sendWebhook({ payload: createWebhookPayload('opened', sha) });
    const job = harness.jobsById.get(`pr-1234-14-${sha}`);

    for (const attempt of [0, 1]) {
      await assert.rejects(harness.processQueuedJob(job, attempt), /mocked GitHub diff failure/);
      assert.equal(harness.reviews.get(identityKey({ repositoryId: repository._id, prNumber: 14, commitSha: sha })).status, 'queued');
    }
    await assert.rejects(harness.processQueuedJob(job, 2), /mocked GitHub diff failure/);

    const failedReview = harness.reviews.get(identityKey({ repositoryId: repository._id, prNumber: 14, commitSha: sha }));
    assert.equal(failedReview.status, 'failed');
    assert.equal(failedReview.summary, 'mocked GitHub diff failure');
    assert.equal(harness.calls.analyze, 0);
    assert.equal(harness.calls.publish, 0);
  });

  await t.test('Groq analysis failure', async (st) => {
    const harness = await createHarness({ analysisError: new Error('mocked Groq failure') });
    st.after(() => harness.close());
    const sha = '2'.repeat(40);
    await harness.sendWebhook({ payload: createWebhookPayload('opened', sha) });
    const job = harness.jobsById.get(`pr-1234-14-${sha}`);

    for (const attempt of [0, 1]) {
      await assert.rejects(harness.processQueuedJob(job, attempt), /mocked Groq failure/);
      assert.equal(harness.reviews.get(identityKey({ repositoryId: repository._id, prNumber: 14, commitSha: sha })).status, 'queued');
    }
    await assert.rejects(harness.processQueuedJob(job, 2), /mocked Groq failure/);

    const failedReview = harness.reviews.get(identityKey({ repositoryId: repository._id, prNumber: 14, commitSha: sha }));
    assert.equal(failedReview.status, 'failed');
    assert.equal(failedReview.summary, 'mocked Groq failure');
    assert.equal(harness.calls.publish, 0);
  });
});

test('a queued stale commit is marked stale without analysis or publication', async (t) => {
  const harness = await createHarness({ headShaFor: () => '9'.repeat(40) });
  t.after(() => harness.close());
  const oldSha = '8'.repeat(40);

  assert.equal((await harness.sendWebhook({ payload: createWebhookPayload('opened', oldSha) })).status, 200);
  const job = harness.jobsById.get(`pr-1234-14-${oldSha}`);
  const result = await harness.processQueuedJob(job);

  const review = harness.reviews.get(identityKey({ repositoryId: repository._id, prNumber: 14, commitSha: oldSha }));
  assert.equal(result.status, 'stale');
  assert.equal(review.status, 'stale');
  assert.equal(harness.calls.diff, 0);
  assert.equal(harness.calls.analyze, 0);
  assert.equal(harness.calls.publish, 0);
});

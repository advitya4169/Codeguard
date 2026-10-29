import test from 'node:test';
import assert from 'node:assert/strict';
import { createRetryReviewHandler } from './reviewRetryController.js';

const reviewId = '65f000000000000000000001';
const userId = '65f000000000000000000002';
const repo = {
  _id: '65f000000000000000000003',
  githubRepoId: 1234,
  userId,
  installationId: '9876',
  isConnected: true,
};
const review = {
  _id: reviewId,
  repositoryId: repo._id,
  prNumber: 14,
  commitSha: 'abc123',
  status: 'failed',
  summary: 'Temporary provider failure',
};
const queueJob = () => ({
  id: 'pr-1234-14-abc123',
  name: 'process-pr-review',
  data: {
    githubRepoId: 1234,
    prNumber: 14,
    commitSha: 'abc123',
    userId,
    installationId: '9876',
  },
  getState: async () => 'failed',
  retry: async () => {},
});
const response = () => ({
  statusCode: null,
  body: null,
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
});
const request = () => ({
  user: { userId },
  params: { githubRepoId: '1234', reviewId },
});

test('retries an owned failed review using the existing BullMQ job', async () => {
  const job = queueJob();
  const updateCalls = [];
  let retryArgs;
  job.retry = async (...args) => { retryArgs = args; };
  const handler = createRetryReviewHandler({
    RepositoryModel: { findOne: async () => repo },
    ReviewJobModel: {
      findOne: async () => review,
      findOneAndUpdate: async (...args) => { updateCalls.push(args); return review; },
    },
    queue: { getJob: async (id) => { assert.equal(id, job.id); return job; } },
    logger: { error() {} },
  });
  const res = response();

  await handler(request(), res);

  assert.equal(res.statusCode, 202);
  assert.equal(res.body.reviewId, reviewId);
  assert.equal(updateCalls.length, 1);
  assert.equal(updateCalls[0][0].status, 'failed');
  assert.deepEqual(updateCalls[0][1].$set, { status: 'queued', summary: 'Review retry queued.' });
  assert.deepEqual(retryArgs, ['failed', { resetAttemptsMade: true, resetAttemptsStarted: true }]);
});

test('rejects a repository not owned by the authenticated user', async () => {
  const handler = createRetryReviewHandler({
    RepositoryModel: { findOne: async (filter) => {
      assert.equal(filter.userId, userId);
      return null;
    } },
    logger: { error() {} },
  });
  const res = response();

  await handler(request(), res);

  assert.equal(res.statusCode, 404);
  assert.equal(res.body.error, 'Repository not found');
});

test('requires authentication and preserves legacy OAuth job retry support', async (t) => {
  await t.test('missing authenticated user is rejected', async () => {
    const handler = createRetryReviewHandler({ logger: { error() {} } });
    const res = response();
    await handler({ params: { githubRepoId: '1234', reviewId } }, res);
    assert.equal(res.statusCode, 401);
  });

  await t.test('validates the existing legacy OAuth payload', async () => {
    const oauthRepo = { ...repo, installationId: undefined };
    const job = queueJob();
    job.data = {
      githubRepoId: 1234,
      prNumber: 14,
      commitSha: 'abc123',
      userId,
      accessToken: 'opaque-test-token',
    };
    const handler = createRetryReviewHandler({
      RepositoryModel: { findOne: async () => oauthRepo },
      ReviewJobModel: {
        findOne: async () => review,
        findOneAndUpdate: async () => review,
      },
      queue: { getJob: async () => job },
      logger: { error() {} },
    });
    const res = response();
    await handler(request(), res);
    assert.equal(res.statusCode, 202);
  });
});

test('does not retry a completed review or a non-failed BullMQ job', async (t) => {
  await t.test('persisted review is completed', async () => {
    const handler = createRetryReviewHandler({
      RepositoryModel: { findOne: async () => repo },
      ReviewJobModel: { findOne: async () => ({ ...review, status: 'completed' }) },
      queue: { getJob: async () => { throw new Error('must not inspect completed review'); } },
      logger: { error() {} },
    });
    const res = response();
    await handler(request(), res);
    assert.equal(res.statusCode, 409);
  });

  await t.test('queue job is active', async () => {
    const job = queueJob();
    job.getState = async () => 'active';
    job.retry = async () => { throw new Error('must not retry active job'); };
    const handler = createRetryReviewHandler({
      RepositoryModel: { findOne: async () => repo },
      ReviewJobModel: { findOne: async () => review, findOneAndUpdate: async () => { throw new Error('must not claim active job'); } },
      queue: { getJob: async () => job },
      logger: { error() {} },
    });
    const res = response();
    await handler(request(), res);
    assert.equal(res.statusCode, 409);
    assert.match(res.body.error, /already queued or running/);
  });

  await t.test('queue job is completed', async () => {
    const job = queueJob();
    job.getState = async () => 'completed';
    const handler = createRetryReviewHandler({
      RepositoryModel: { findOne: async () => repo },
      ReviewJobModel: { findOne: async () => review, findOneAndUpdate: async () => { throw new Error('must not claim completed job'); } },
      queue: { getJob: async () => job },
      logger: { error() {} },
    });
    const res = response();
    await handler(request(), res);
    assert.equal(res.statusCode, 409);
    assert.match(res.body.error, /already completed/);
  });

  await t.test('queue job is missing', async () => {
    const handler = createRetryReviewHandler({
      RepositoryModel: { findOne: async () => repo },
      ReviewJobModel: { findOne: async () => review },
      queue: { getJob: async () => null },
      logger: { error() {} },
    });
    const res = response();
    await handler(request(), res);
    assert.equal(res.statusCode, 409);
    assert.match(res.body.error, /no longer available/);
  });
});

test('rejects a retry when another request already claimed the review', async () => {
  const job = queueJob();
  job.retry = async () => { throw new Error('must not retry unclaimed review'); };
  const handler = createRetryReviewHandler({
    RepositoryModel: { findOne: async () => repo },
    ReviewJobModel: {
      findOne: async () => review,
      findOneAndUpdate: async () => null,
    },
    queue: { getJob: async () => job },
    logger: { error() {} },
  });
  const res = response();

  await handler(request(), res);

  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /already queued or running/);
});

test('restores the persisted failed state if BullMQ rejects the retry', async () => {
  const updates = [];
  const job = queueJob();
  job.retry = async () => { throw new Error('Redis unavailable'); };
  const handler = createRetryReviewHandler({
    RepositoryModel: { findOne: async () => repo },
    ReviewJobModel: {
      findOne: async () => review,
      findOneAndUpdate: async (...args) => { updates.push(args); return review; },
    },
    queue: { getJob: async () => job },
    logger: { error() {} },
  });
  const res = response();

  await handler(request(), res);

  assert.equal(res.statusCode, 503);
  assert.equal(updates.length, 2);
  assert.deepEqual(updates[1][1].$set, { status: 'failed', summary: review.summary });
});

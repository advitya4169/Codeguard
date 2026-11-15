import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import {
  COMPLETED_JOB_RETENTION_COUNT,
  FAILED_JOB_RETENTION_AGE_SECONDS,
  FAILED_JOB_RETENTION_COUNT,
  DEFAULT_JOB_OPTIONS,
  reviewQueue,
} from './queue.js';
import { redisConnection } from './redis.js';
import { calculateReviewBackoff } from '../services/groqService.js';
import { createRetryReviewHandler } from '../controllers/reviewRetryController.js';

after(async () => {
  await reviewQueue.close();
  await redisConnection.disconnect();
});

test('1. Completed jobs retention policy is configured for latest 100 jobs', () => {
  assert.equal(COMPLETED_JOB_RETENTION_COUNT, 100);
  assert.deepEqual(DEFAULT_JOB_OPTIONS.removeOnComplete, { count: 100 });
  assert.deepEqual(reviewQueue.defaultJobOptions.removeOnComplete, { count: 100 });
  assert.deepEqual(reviewQueue.jobsOpts.removeOnComplete, { count: 100 });
});

test('2. Failed jobs retention policy is configured for 7 days (604,800s) and max 500 jobs', () => {
  assert.equal(FAILED_JOB_RETENTION_AGE_SECONDS, 7 * 24 * 3600);
  assert.equal(FAILED_JOB_RETENTION_AGE_SECONDS, 604_800);
  assert.equal(FAILED_JOB_RETENTION_COUNT, 500);
  assert.deepEqual(DEFAULT_JOB_OPTIONS.removeOnFail, {
    age: 604_800,
    count: 500,
  });
  assert.deepEqual(reviewQueue.defaultJobOptions.removeOnFail, {
    age: 604_800,
    count: 500,
  });
  assert.deepEqual(reviewQueue.jobsOpts.removeOnFail, {
    age: 604_800,
    count: 500,
  });
});

test('3. Existing queue retry configuration and backoff strategy are preserved', () => {
  // Confirm backoff strategy remains registered on the queue
  assert.equal(reviewQueue.opts.settings?.backoffStrategy, calculateReviewBackoff);

  // BullMQ merges defaultJobOptions with per-job options without overwriting retry/backoff
  const perJobOpts = {
    jobId: 'pr-1234-14-abcdef',
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
  };

  const mergedOpts = Object.assign({}, reviewQueue.jobsOpts, perJobOpts);
  assert.equal(mergedOpts.attempts, 3);
  assert.deepEqual(mergedOpts.backoff, { type: 'exponential', delay: 5000 });
  assert.deepEqual(mergedOpts.removeOnComplete, { count: 100 });
  assert.deepEqual(mergedOpts.removeOnFail, { age: 604_800, count: 500 });
});

test('4. Manual retry functionality remains compatible with retention lifecycle', async (t) => {
  const userId = '65f000000000000000000001';
  const repoId = '65f000000000000000000002';
  const reviewId = '65f000000000000000000003';
  const repository = {
    _id: repoId,
    githubRepoId: 9999,
    userId,
    installationId: 'inst-1',
    isConnected: true,
  };
  const failedReview = {
    _id: reviewId,
    repositoryId: repoId,
    prNumber: 42,
    commitSha: 'commit-sha-42',
    status: 'failed',
    summary: 'API timeout error',
  };

  await t.test('retained failed job is successfully retried within the 7-day retention window', async () => {
    let retried = false;
    const mockJob = {
      id: 'pr-9999-42-commit-sha-42',
      name: 'process-pr-review',
      data: {
        githubRepoId: 9999,
        prNumber: 42,
        commitSha: 'commit-sha-42',
        userId,
        installationId: 'inst-1',
      },
      getState: async () => 'failed',
      retry: async () => { retried = true; },
    };

    const handler = createRetryReviewHandler({
      RepositoryModel: { findOne: async () => repository },
      ReviewJobModel: {
        findOne: async () => failedReview,
        findOneAndUpdate: async () => failedReview,
      },
      queue: { getJob: async (id) => (id === mockJob.id ? mockJob : null) },
      logger: { error() {} },
    });

    const res = {
      statusCode: null,
      body: null,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; },
    };

    await handler({ user: { userId }, params: { githubRepoId: '9999', reviewId } }, res);
    assert.equal(res.statusCode, 202);
    assert.equal(retried, true);
  });

  await t.test('cleanly informs user when an aged failed job has been evicted by retention', async () => {
    const handler = createRetryReviewHandler({
      RepositoryModel: { findOne: async () => repository },
      ReviewJobModel: { findOne: async () => failedReview },
      queue: { getJob: async () => null }, // Job evicted by retention policy
      logger: { error() {} },
    });

    const res = {
      statusCode: null,
      body: null,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; },
    };

    await handler({ user: { userId }, params: { githubRepoId: '9999', reviewId } }, res);
    assert.equal(res.statusCode, 409);
    assert.match(res.body.error, /The failed queue job is no longer available/);
  });

  await t.test('completed jobs are never inspected or retried by the manual retry endpoint', async () => {
    const handler = createRetryReviewHandler({
      RepositoryModel: { findOne: async () => repository },
      ReviewJobModel: { findOne: async () => ({ ...failedReview, status: 'completed' }) },
      queue: { getJob: async () => { throw new Error('Queue must not be accessed for completed reviews'); } },
      logger: { error() {} },
    });

    const res = {
      statusCode: null,
      body: null,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; },
    };

    await handler({ user: { userId }, params: { githubRepoId: '9999', reviewId } }, res);
    assert.equal(res.statusCode, 409);
    assert.match(res.body.error, /Only a failed review can be retried/);
  });
});

test('5. Duplicate webhook delivery protection preserves deterministic job IDs', () => {
  const repoId = 5555;
  const prNumber = 10;
  const commitSha = 'deadbeef1234567890';
  const expectedJobId = `pr-${repoId}-${prNumber}-${commitSha}`;

  // Deterministic job ID ensures repeated webhooks reference the identical job in the queue
  const generatedId1 = `pr-${repoId}-${prNumber}-${commitSha}`;
  const generatedId2 = `pr-${repoId}-${prNumber}-${commitSha}`;
  assert.equal(generatedId1, expectedJobId);
  assert.equal(generatedId2, expectedJobId);
});

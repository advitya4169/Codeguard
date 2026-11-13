import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCodeGuardMarker,
  createGitHubReviewPublisher,
} from '../services/githubReviewPublisher.js';
import { createGitHubPublicationRetryHandler } from './githubPublicationRetryController.js';

const userId = '65f000000000000000000002';
const baseRepository = {
  _id: '65f000000000000000000003',
  githubRepoId: 1234,
  fullName: 'owner/repo',
  userId,
  installationId: '9876',
  isConnected: true,
  isHookActive: true,
};
const baseReview = {
  _id: '65f000000000000000000001',
  repositoryId: baseRepository._id,
  prNumber: 14,
  commitSha: 'abc123',
  status: 'completed',
  githubPublicationStatus: 'failed',
};
const baseFindings = [
  { category: 'security', severity: 'high', filePath: 'src/query.js', lineNumber: 12, explanation: 'Evidence: `query(input)` — unsafe query.', suggestedFix: 'Use a parameterized query.' },
  { category: 'bug', severity: 'low', filePath: 'src/other.js', explanation: 'Evidence: `return null` — unexpected result.' },
];

const createResponse = () => ({
  statusCode: null,
  body: null,
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
});

const createHarness = ({
  publishReviewFn = async () => ({ status: 'published', id: 77, url: 'https://github.com/owner/repo/pull/14#pullrequestreview-77', inlineCount: 1 }),
  repository: repositoryValue = { ...baseRepository },
  review: reviewValue = { ...baseReview },
  findings: findingsValue = [...baseFindings],
  appBacked = true,
  overrides = {},
} = {}) => {
  const storedReview = { ...reviewValue };
  const updateCalls = [];
  const tokenCalls = [];
  const handler = createGitHubPublicationRetryHandler({
    RepositoryModel: { findOne: async (filter) => {
      assert.equal(filter.userId, userId);
      return repositoryValue;
    } },
    ReviewJobModel: {
      findOne: async () => reviewValue,
      findOneAndUpdate: async (filter, update) => {
        updateCalls.push({ filter, update });
        if (filter.githubPublicationStatus !== storedReview.githubPublicationStatus) return null;
        if (update.$set) Object.assign(storedReview, update.$set);
        if (update.$unset) {
          for (const key of Object.keys(update.$unset)) delete storedReview[key];
        }
        return { ...storedReview };
      },
    },
    FindingModel: { find: () => ({ lean: async () => findingsValue }) },
    UserModel: { findById: async () => ({ accessToken: 'oauth-token' }) },
    InstallationModel: { findOne: async () => appBacked ? { status: 'active' } : null },
    getInstallationAccessTokenFn: async (installationId) => {
      tokenCalls.push(installationId);
      return { token: 'short-lived-test-token' };
    },
    publishReviewFn,
    logger: { log() {}, error() {} },
    ...overrides,
  });
  return {
    handler,
    storedReview,
    updateCalls,
    tokenCalls,
    req: { user: { userId }, params: { githubRepoId: '1234', reviewId: reviewValue._id } },
  };
};

test('retries publication from saved findings without invoking a review processor', async () => {
  let publishedInput;
  const harness = createHarness({
    publishReviewFn: async (input) => {
      publishedInput = input;
      return { status: 'published', id: 77, url: 'https://github.com/owner/repo/pull/14#pullrequestreview-77', inlineCount: 1 };
    },
  });
  const res = createResponse();

  await harness.handler(harness.req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.githubPublicationStatus, 'published');
  assert.equal(harness.storedReview.status, 'completed');
  assert.equal(harness.storedReview.githubPublicationStatus, 'published');
  assert.equal(harness.storedReview.githubPublicationId, 77);
  assert.equal(publishedInput.commentableFindings.length, 1);
  assert.equal(publishedInput.unanchoredFindings.length, 1);
  assert.deepEqual(harness.tokenCalls, ['9876']);
  assert.equal(harness.updateCalls[0].filter.githubPublicationStatus, 'failed');
});

test('legacy OAuth repositories retry with the authenticated user token', async () => {
  let publicationToken;
  const harness = createHarness({
    repository: { ...baseRepository, installationId: undefined },
    appBacked: false,
    publishReviewFn: async ({ accessToken }) => {
      publicationToken = accessToken;
      return { status: 'published' };
    },
  });
  const res = createResponse();

  await harness.handler(harness.req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(publicationToken, 'oauth-token');
  assert.equal(harness.tokenCalls.length, 0);
});

test('a publication marker already present is recorded without another GitHub write', async () => {
  const marker = createCodeGuardMarker(baseRepository._id, baseReview.prNumber, baseReview.commitSha);
  let writes = 0;
  const publishReviewFn = createGitHubReviewPublisher({
    getPRHeadShaFn: async () => baseReview.commitSha,
    listPRReviewsFn: async () => [{ id: 77, html_url: 'https://github.com/owner/repo/pull/14#pullrequestreview-77', body: marker, commit_id: baseReview.commitSha }],
    listPRCommentsFn: async () => [],
    createPRReviewFn: async () => { writes += 1; throw new Error('must not duplicate'); },
  });
  const harness = createHarness({ publishReviewFn });
  const res = createResponse();

  await harness.handler(harness.req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.githubPublicationStatus, 'duplicate');
  assert.equal(harness.storedReview.githubPublicationUrl, 'https://github.com/owner/repo/pull/14#pullrequestreview-77');
  assert.equal(writes, 0);
});

test('stale PR head records stale publication without writing', async () => {
  let writes = 0;
  const publisher = createGitHubReviewPublisher({
    getPRHeadShaFn: async () => 'newer-commit',
    createPRReviewFn: async () => { writes += 1; },
  });
  const harness = createHarness({ publishReviewFn: publisher });
  const res = createResponse();

  await harness.handler(harness.req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.githubPublicationStatus, 'stale');
  assert.equal(harness.storedReview.status, 'completed');
  assert.equal(writes, 0);
});

test('ambiguous accepted publication is reconciled by marker and is not written twice', async () => {
  const marker = createCodeGuardMarker(baseRepository._id, baseReview.prNumber, baseReview.commitSha);
  let lookups = 0;
  let writes = 0;
  const publisher = createGitHubReviewPublisher({
    getPRHeadShaFn: async () => baseReview.commitSha,
    listPRReviewsFn: async () => {
      lookups += 1;
      return lookups > 1
        ? [{ id: 77, html_url: 'https://github.com/owner/repo/pull/14#pullrequestreview-77', body: marker, commit_id: baseReview.commitSha }]
        : [];
    },
    listPRCommentsFn: async () => [],
    createPRReviewFn: async () => {
      writes += 1;
      const error = new Error('connection reset after request');
      error.ambiguous = true;
      throw error;
    },
  });
  const harness = createHarness({ publishReviewFn: publisher });
  const res = createResponse();

  await harness.handler(harness.req, res);

  assert.equal(res.body.githubPublicationStatus, 'published');
  assert.equal(harness.storedReview.githubPublicationUrl, 'https://github.com/owner/repo/pull/14#pullrequestreview-77');
  assert.equal(writes, 1);
  assert.equal(lookups, 2);
});

test('ambiguous unconfirmed publication remains uncertain and cannot be retried as a definite failure', async () => {
  const publisher = createGitHubReviewPublisher({
    getPRHeadShaFn: async () => baseReview.commitSha,
    listPRReviewsFn: async () => [],
    listPRCommentsFn: async () => [],
    createPRReviewFn: async () => {
      const error = new Error('network timeout');
      error.ambiguous = true;
      throw error;
    },
  });
  const harness = createHarness({ publishReviewFn: publisher });
  const res = createResponse();

  await harness.handler(harness.req, res);

  assert.equal(res.body.githubPublicationStatus, 'uncertain');
  assert.equal(harness.storedReview.githubPublicationStatus, 'uncertain');
  const secondResponse = createResponse();
  await harness.handler(harness.req, secondResponse);
  assert.equal(secondResponse.statusCode, 409);
});

test('rejects unowned repositories and non-completed or non-failed publications', async (t) => {
  await t.test('unowned repository', async () => {
    const harness = createHarness({ overrides: { RepositoryModel: { findOne: async () => null } } });
    const res = createResponse();
    await harness.handler(harness.req, res);
    assert.equal(res.statusCode, 404);
  });

  await t.test('analysis did not complete', async () => {
    const harness = createHarness({ review: { ...baseReview, status: 'failed' } });
    const res = createResponse();
    await harness.handler(harness.req, res);
    assert.equal(res.statusCode, 409);
  });

  await t.test('publication is uncertain', async () => {
    const harness = createHarness({ review: { ...baseReview, githubPublicationStatus: 'uncertain' } });
    const res = createResponse();
    await harness.handler(harness.req, res);
    assert.equal(res.statusCode, 409);
  });
});

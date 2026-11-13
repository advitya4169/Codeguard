import test from 'node:test';
import assert from 'node:assert/strict';
import { createPullRequestMetadataHandler } from './pullRequestMetadataController.js';

const response = () => ({
  statusCode: null,
  body: null,
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
});

const request = (pullRequestNumbers = [12]) => ({
  user: { userId: 'user-id' },
  params: { githubRepoId: '1234' },
  body: { pullRequestNumbers },
});

const reviewQuery = (numbers = [12]) => ({
  select: () => ({ lean: async () => numbers.map((prNumber) => ({ prNumber })) }),
});

const dependencies = (overrides = {}) => ({
  RepositoryModel: {
    findOne: async () => ({
      _id: 'repository-id',
      githubRepoId: 1234,
      fullName: 'owner/repo',
      userId: 'user-id',
      installationId: '55',
      isHookActive: true,
    }),
  },
  ReviewJobModel: { find: () => reviewQuery() },
  InstallationModel: { findOne: async () => ({ status: 'active' }) },
  UserModel: { findById: async () => ({ accessToken: 'oauth-token' }) },
  getInstallationAccessTokenFn: async () => ({ token: 'installation-token' }),
  getPullRequestMetadataFn: async (_fullName, number, token) => ({
    number,
    baseRepositoryId: 1234,
    title: 'Fix query validation',
    author: 'octocat',
    sourceBranch: 'fix/query',
    targetBranch: 'main',
    updatedAt: '2026-10-25T12:00:00.000Z',
    token,
  }),
  logger: { warn() {}, error() {} },
  ...overrides,
});

test('retrieves metadata only through the owned active App installation and strips internal fields', async () => {
  const handler = createPullRequestMetadataHandler(dependencies());
  const res = response();

  await handler(request(), res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {
    pullRequests: [{
      number: 12,
      title: 'Fix query validation',
      author: 'octocat',
      sourceBranch: 'fix/query',
      targetBranch: 'main',
      updatedAt: '2026-10-25T12:00:00.000Z',
    }],
    unavailable: [],
  });
});

test('rejects invalid input, unowned repositories, and PR numbers absent from history', async () => {
  const invalid = response();
  await createPullRequestMetadataHandler(dependencies())({
    ...request([0]),
  }, invalid);
  assert.equal(invalid.statusCode, 400);

  const unowned = response();
  await createPullRequestMetadataHandler(dependencies({
    RepositoryModel: { findOne: async () => null },
  }))(request(), unowned);
  assert.equal(unowned.statusCode, 404);

  const missingHistory = response();
  await createPullRequestMetadataHandler(dependencies({
    ReviewJobModel: { find: () => reviewQuery([]) },
  }))(request(), missingHistory);
  assert.equal(missingHistory.statusCode, 404);
});

test('does not use an inactive or differently owned App installation', async () => {
  let tokenRequested = false;
  const handler = createPullRequestMetadataHandler(dependencies({
    InstallationModel: { findOne: async () => null },
    getInstallationAccessTokenFn: async () => {
      tokenRequested = true;
      return { token: 'must-not-be-requested' };
    },
  }));
  const res = response();

  await handler(request(), res);

  assert.equal(res.statusCode, 503);
  assert.equal(tokenRequested, false);
  assert.doesNotMatch(JSON.stringify(res.body), /must-not-be-requested/);
});

test('does not return metadata for a PR associated with a different repository', async () => {
  const handler = createPullRequestMetadataHandler(dependencies({
    getPullRequestMetadataFn: async () => ({
      number: 12,
      baseRepositoryId: 9999,
      title: 'Wrong repository',
    }),
  }));
  const res = response();

  await handler(request(), res);

  assert.deepEqual(res.body, { pullRequests: [], unavailable: [12] });
});

test('reports missing, inaccessible, and rate-limited PRs as partial metadata without failing history', async () => {
  const handler = createPullRequestMetadataHandler(dependencies({
    getPullRequestMetadataFn: async (_name, number) => {
      if (number < 15) {
        const error = new Error('provider detail must not be returned');
        error.status = number === 12 ? 403 : number === 13 ? 429 : 404;
        throw error;
      }
      return {
        number,
        baseRepositoryId: 1234,
        title: 'Available PR',
      };
    },
    ReviewJobModel: { find: () => reviewQuery([12, 13, 14, 15]) },
  }));
  const res = response();

  await handler(request([12, 13, 14, 15]), res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.pullRequests, [{
    number: 15,
    title: 'Available PR',
    author: null,
    sourceBranch: null,
    targetBranch: null,
    updatedAt: null,
  }]);
  assert.deepEqual(res.body.unavailable, [12, 13, 14]);
  assert.doesNotMatch(JSON.stringify(res.body), /provider detail/);
});

test('uses the linked CodeGuard user token for legacy OAuth-connected repositories', async () => {
  let usedToken;
  const handler = createPullRequestMetadataHandler(dependencies({
    RepositoryModel: {
      findOne: async () => ({
        _id: 'repository-id', githubRepoId: 1234, fullName: 'owner/repo',
        userId: 'user-id', installationId: null, isConnected: true,
      }),
    },
    getPullRequestMetadataFn: async (_name, number, token) => {
      usedToken = token;
      return { number, baseRepositoryId: 1234, title: 'OAuth repository PR' };
    },
  }));
  const res = response();

  await handler(request(), res);

  assert.equal(res.statusCode, 200);
  assert.equal(usedToken, 'oauth-token');
});

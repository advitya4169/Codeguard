import test from 'node:test';
import assert from 'node:assert/strict';
import { createGetRepositoryReviewsHandler } from './dashboardController.js';

const response = () => ({
  statusCode: null,
  body: null,
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
});

test('review history returns persisted GitHub publication status and URL', async () => {
  const review = {
    _id: 'review-id',
    repositoryId: 'repository-id',
    status: 'completed',
    githubPublicationStatus: 'published',
    githubPublicationUrl: 'https://github.com/owner/repo/pull/14#pullrequestreview-1',
  };
  const handler = createGetRepositoryReviewsHandler({
    RepositoryModel: { findOne: async () => ({ _id: 'repository-id' }) },
    ReviewJobModel: {
      find: () => ({
        sort: () => ({ lean: async () => [review] }),
      }),
    },
    FindingModel: { find: () => ({ lean: async () => [] }) },
  });
  const res = response();

  await handler({ params: { githubRepoId: '123' }, user: { userId: 'user-id' } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.reviews[0].githubPublicationStatus, 'published');
  assert.equal(res.body.reviews[0].githubPublicationUrl, review.githubPublicationUrl);
});

test('review history returns saved finding titles and remains compatible with older title-less findings', async () => {
  const savedFindings = [
    {
      _id: 'finding-with-title',
      title: 'SQL injection in query',
      filePath: 'src/query.js',
      diffContext: [{ lineType: 'added', newLineNumber: 12, code: 'db.query(query)', isTarget: true }],
    },
    { _id: 'legacy-finding', filePath: 'src/legacy.js' },
  ];
  const handler = createGetRepositoryReviewsHandler({
    RepositoryModel: { findOne: async () => ({ _id: 'repository-id' }) },
    ReviewJobModel: {
      find: () => ({
        sort: () => ({ lean: async () => [{ _id: 'review-id', status: 'completed' }] }),
      }),
    },
    FindingModel: {
      find: ({ reviewJobId }) => ({
        lean: async () => reviewJobId === 'review-id' ? savedFindings : [],
      }),
    },
  });
  const res = response();

  await handler({ params: { githubRepoId: '123' }, user: { userId: 'user-id' } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.reviews[0].findings[0].title, 'SQL injection in query');
  assert.deepEqual(res.body.reviews[0].findings[0].diffContext, savedFindings[0].diffContext);
  assert.equal(Object.hasOwn(res.body.reviews[0].findings[1], 'title'), false);
});

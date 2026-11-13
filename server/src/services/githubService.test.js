import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createPRReview,
  getPRHeadSha,
  getPullRequestMetadata,
  listPRComments,
  listPRReviews,
} from './githubService.js';

const jsonResponse = (data, { status = 200, headers = {} } = {}) => new Response(
  JSON.stringify(data),
  { status, headers },
);

test('creates a grouped PR review with current modern inline comment fields', async () => {
  let request;
  const response = await createPRReview('owner/repo', 12, 'test-token', {
    commit_id: 'abc123',
    event: 'COMMENT',
    body: 'CodeGuard summary',
    comments: [{ path: 'src/a.js', line: 8, side: 'RIGHT', body: 'Finding' }],
  }, {
    fetchImpl: async (url, options) => {
      request = { url, options };
      return jsonResponse({ id: 45, html_url: 'https://github.com/owner/repo/pull/12#pullrequestreview-45' }, { status: 201 });
    },
  });

  assert.equal(request.url, 'https://api.github.com/repos/owner/repo/pulls/12/reviews');
  assert.equal(request.options.method, 'POST');
  assert.deepEqual(JSON.parse(request.options.body), {
    commit_id: 'abc123',
    event: 'COMMENT',
    body: 'CodeGuard summary',
    comments: [{ path: 'src/a.js', line: 8, side: 'RIGHT', body: 'Finding' }],
  });
  assert.equal(response.status, 201);
  assert.equal(response.data.id, 45);
});

test('fetches the current PR head SHA', async () => {
  const sha = await getPRHeadSha('owner/repo', 12, 'test-token', {
    fetchImpl: async (url) => {
      assert.equal(url, 'https://api.github.com/repos/owner/repo/pulls/12');
      return jsonResponse({ head: { sha: 'current-sha' } });
    },
  });
  assert.equal(sha, 'current-sha');
});

test('fetches only real PR metadata and verifies the base repository identity', async () => {
  let request;
  const metadata = await getPullRequestMetadata('owner/repo', 12, 'test-token', {
    fetchImpl: async (url, options) => {
      request = { url, options };
      return jsonResponse({
        number: 12,
        title: 'Validate user input',
        user: { login: 'octocat' },
        head: { ref: 'feature/search' },
        base: { ref: 'main', repo: { id: 1234 } },
        updated_at: '2026-10-25T12:00:00Z',
      });
    },
  });

  assert.equal(request.url, 'https://api.github.com/repos/owner/repo/pulls/12');
  assert.equal(request.options.headers.Authorization, 'Bearer test-token');
  assert.deepEqual(metadata, {
    number: 12,
    baseRepositoryId: 1234,
    title: 'Validate user input',
    author: 'octocat',
    sourceBranch: 'feature/search',
    targetBranch: 'main',
    updatedAt: '2026-10-25T12:00:00.000Z',
  });
});

test('handles unavailable optional PR metadata fields without inventing values', async () => {
  const metadata = await getPullRequestMetadata('owner/repo', 12, 'test-token', {
    fetchImpl: async () => jsonResponse({
      number: 12,
      base: { repo: { id: 1234 } },
    }),
  });

  assert.equal(metadata.title, null);
  assert.equal(metadata.author, null);
  assert.equal(metadata.sourceBranch, null);
  assert.equal(metadata.targetBranch, null);
  assert.equal(metadata.updatedAt, null);
});

test('preserves GitHub errors for missing or inaccessible PR metadata', async () => {
  await assert.rejects(
    getPullRequestMetadata('owner/repo', 12, 'test-token', {
      fetchImpl: async () => jsonResponse({ message: 'Not Found' }, { status: 404 }),
    }),
    (error) => error.status === 404 && error.endpoint.endsWith('/pulls/12'),
  );
  await assert.rejects(
    getPullRequestMetadata('owner/repo', 12, 'test-token', {
      fetchImpl: async () => jsonResponse({ message: 'API rate limit exceeded' }, { status: 403 }),
    }),
    (error) => error.status === 403,
  );
});

test('follows paginated existing-review results', async () => {
  const calls = [];
  const reviews = await listPRReviews('owner/repo', 12, 'test-token', {
    fetchImpl: async (url) => {
      calls.push(url);
      if (calls.length === 1) {
        return jsonResponse([{ id: 1 }], {
          headers: { link: '<https://api.github.com/repos/owner/repo/pulls/12/reviews?per_page=100&page=2>; rel="next"' },
        });
      }
      return jsonResponse([{ id: 2 }]);
    },
  });

  assert.equal(calls.length, 2);
  assert.deepEqual(reviews.map(({ id }) => id), [1, 2]);
});

test('lists PR conversation comments with pagination for fallback marker checks', async () => {
  const calls = [];
  const comments = await listPRComments('owner/repo', 12, 'test-token', {
    fetchImpl: async (url) => {
      calls.push(url);
      return jsonResponse(calls.length === 1 ? [{ id: 1 }] : [{ id: 2 }], {
        headers: calls.length === 1
          ? { link: '<https://api.github.com/repos/owner/repo/issues/12/comments?per_page=100&page=2>; rel="next"' }
          : {},
      });
    },
  });

  assert.match(calls[0], /\/repos\/owner\/repo\/issues\/12\/comments/);
  assert.equal(calls.length, 2);
  assert.deepEqual(comments.map(({ id }) => id), [1, 2]);
});

test('preserves sanitized GitHub permission errors and marks write network errors ambiguous', async () => {
  await assert.rejects(
    createPRReview('owner/repo', 12, 'test-token', { event: 'COMMENT', comments: [] }, {
      fetchImpl: async () => jsonResponse({ message: 'Resource not accessible by integration' }, {
        status: 403,
        headers: { 'x-accepted-github-permissions': 'pull_requests=write' },
      }),
    }),
    (error) => error.status === 403 &&
      error.responseMessage === 'Resource not accessible by integration' &&
      error.acceptedPermissions === 'pull_requests=write' &&
      error.endpoint.endsWith('/pulls/12/reviews'),
  );

  await assert.rejects(
    createPRReview('owner/repo', 12, 'test-token', { event: 'COMMENT', comments: [] }, {
      fetchImpl: async () => { throw new Error('network disconnected'); },
    }),
    (error) => error.ambiguous === true && error.endpoint.endsWith('/pulls/12/reviews'),
  );
});

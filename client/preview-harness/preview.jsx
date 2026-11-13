import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import Dashboard from '../src/pages/Dashboard.jsx';
import '../src/index.css';

const localApiOrigin = 'http://localhost:5000';
const status = document.getElementById('preview-request-status');
let interceptedRequestCount = 0;

const repositories = [
  {
    id: 314159265,
    name: 'CodeGuard',
    fullName: 'advitya4169/Codeguard',
    private: false,
    url: 'https://github.com/advitya4169/Codeguard',
    ownedByAuthenticatedUser: true,
    connected: true,
    connectionType: 'github_app',
    installationId: 'preview-install-2026',
  },
  {
    id: 271828182,
    name: 'CodeBooth',
    fullName: 'advitya4169/CodeBooth',
    private: true,
    url: 'https://github.com/advitya4169/CodeBooth',
    ownedByAuthenticatedUser: true,
    connected: true,
    connectionType: 'github_app',
    installationId: 'preview-install-2026',
  },
  {
    id: 161803398,
    name: 'PeerPush',
    fullName: 'advitya4169/PeerPush',
    private: false,
    url: 'https://github.com/advitya4169/PeerPush',
    ownedByAuthenticatedUser: true,
    connected: true,
    connectionType: 'oauth',
  },
  {
    id: 141421356,
    name: 'ReviewSandbox',
    fullName: 'advitya4169/ReviewSandbox',
    private: false,
    url: 'https://github.com/advitya4169/ReviewSandbox',
    ownedByAuthenticatedUser: true,
    connected: false,
    connectionType: null,
  },
];

const findings = [
  {
    _id: 'preview-finding-1',
    category: 'security',
    severity: 'critical',
    filePath: 'server/src/controllers/searchController.js',
    lineNumber: 83,
    diffContext: [
      { lineType: 'context', oldLineNumber: 82, newLineNumber: 82, code: 'const search = req.query.q;', isTarget: false },
      { lineType: 'removed', oldLineNumber: 83, code: 'const query = buildSearch(search);', isTarget: false },
      { lineType: 'added', newLineNumber: 83, code: 'const query = "SELECT * FROM records WHERE name = " + search;', isTarget: true },
      { lineType: 'context', oldLineNumber: 84, newLineNumber: 84, code: 'return db.query(query);', isTarget: false },
    ],
    explanation: 'Evidence: `query = "SELECT * FROM records WHERE name = " + search` — User-controlled search text is concatenated into a SQL statement, allowing input to change the query structure.',
    suggestedFix: 'Use a parameterized query and pass the search text as a bound value.',
  },
  {
    _id: 'preview-finding-2',
    category: 'bug',
    severity: 'high',
    filePath: 'client/src/components/RepositorySearch.jsx',
    lineNumber: 51,
    diffContext: [
      { lineType: 'context', oldLineNumber: 50, newLineNumber: 50, code: 'function renderResult(repository) {', isTarget: false },
      { lineType: 'removed', oldLineNumber: 51, code: 'label.textContent = repository.name;', isTarget: false },
      { lineType: 'added', newLineNumber: 51, code: 'container.innerHTML = repositoryLabel;', isTarget: true },
      { lineType: 'context', oldLineNumber: 52, newLineNumber: 52, code: 'return container;', isTarget: false },
    ],
    explanation: 'Evidence: `container.innerHTML = repositoryLabel` — The result label is rendered as HTML without escaping, so repository metadata could inject markup.',
    suggestedFix: 'Render the value as text or sanitize it with a trusted HTML sanitizer.',
  },
  {
    _id: 'preview-finding-3',
    category: 'performance',
    severity: 'medium',
    filePath: 'server/src/services/repositoryService.js',
    lineNumber: 127,
    explanation: 'Evidence: `const result = await lookup(item)` — The loop awaits each independent lookup in sequence, extending response time as the repository list grows.',
    suggestedFix: 'Consider running independent lookups concurrently with Promise.all.',
  },
];

const reviewHistory = [
  {
    _id: 'preview-review-42-previous',
    repositoryId: '314159265',
    prNumber: 42,
    commitSha: '5ab56cd002a790149b45d1adfd91d7d5265d04fb',
    status: 'completed',
    githubPublicationStatus: 'published',
    githubPublicationId: 4200,
    githubPublicationUrl: 'https://github.com/advitya4169/Codeguard/pull/42#pullrequestreview-4200',
    summary: 'Processed 2 findings.',
    createdAt: '2026-11-01T13:10:00.000Z',
    findings: findings.slice(0, 2).map((finding) => ({ ...finding, _id: `${finding._id}-previous` })),
  },
  {
    _id: 'preview-review-42',
    repositoryId: '314159265',
    prNumber: 42,
    commitSha: '8d2b19f3a8e043b9f14e3cf6b0a5d4bb197a6021',
    status: 'completed',
    githubPublicationStatus: 'published',
    githubPublicationId: 4242,
    githubPublicationUrl: 'https://github.com/advitya4169/Codeguard/pull/42#pullrequestreview-4242',
    summary: 'Processed 3 findings.',
    createdAt: '2026-11-05T16:20:00.000Z',
    findings,
  },
  {
    _id: 'preview-review-41',
    repositoryId: '314159265',
    prNumber: 41,
    commitSha: '2a7e11cd9140e20f1255f10296a17eb39a21ff80',
    status: 'completed',
    githubPublicationStatus: 'failed',
    summary: 'Processed 1 findings.',
    createdAt: '2026-11-02T10:05:00.000Z',
    findings: [
      {
        _id: 'preview-finding-4',
        category: 'maintainability',
        severity: 'suggestion',
        filePath: 'client/src/utils/formatDate.js',
        lineNumber: 18,
        explanation: 'Evidence: `new Date(value).toLocaleDateString()` — The date formatting logic is repeated in multiple components and could be shared.',
        suggestedFix: 'Reuse a shared date-formatting helper.',
      },
    ],
  },
  {
    _id: 'preview-review-40',
    repositoryId: '314159265',
    prNumber: 40,
    commitSha: 'cc3129a48f05dc431b81ac4d0bc850c8f08c6243',
    status: 'failed',
    summary: 'GitHub could not provide the pull request diff. Check repository access and retry the review.',
    createdAt: '2026-10-29T08:44:00.000Z',
    findings: [],
  },
  {
    _id: 'preview-review-39',
    repositoryId: '314159265',
    prNumber: 39,
    commitSha: '6f4050710a4c7014bfa00d958150301311041fe3',
    status: 'completed',
    githubPublicationStatus: 'not_needed',
    summary: 'Processed 0 findings.',
    createdAt: '2026-10-20T14:12:00.000Z',
    findings: [],
  },
];

const jsonResponse = (payload, statusCode = 200) => new Response(
  JSON.stringify(payload),
  { status: statusCode, headers: { 'Content-Type': 'application/json' } },
);

const parseBody = (options) => {
  try { return JSON.parse(options?.body || '{}'); } catch { return {}; }
};

const mockApiFetch = async (input, options = {}) => {
  const requestUrl = input instanceof Request ? input.url : String(input);
  const url = new URL(requestUrl, window.location.href);

  // Fail closed: this preview never falls through to a real network request.
  if (url.origin !== localApiOrigin || !url.pathname.startsWith('/api/')) {
    document.body.dataset.previewNetworkBlocked = 'true';
    status.textContent = `Blocked non-local request · ${url.origin}`;
    throw new Error('Isolated preview blocked a request outside its local mock API.');
  }

  interceptedRequestCount += 1;
  status.textContent = `${interceptedRequestCount} mocked API request${interceptedRequestCount === 1 ? '' : 's'} · no network calls`;

  if (url.pathname === '/api/github/app/installations' && options.method !== 'POST') {
    return jsonResponse({
      installations: [{
        installationId: 'preview-install-2026',
        accountId: 'preview-account-16',
        accountLogin: 'advitya4169',
        accountType: 'User',
        status: 'active',
      }],
    });
  }

  if (url.pathname === '/api/github/repos') {
    return jsonResponse({ repositories, pagination: { page: 1, perPage: 30, hasNextPage: false } });
  }

  if (/^\/api\/github\/app\/installations\/[^/]+\/repos$/.test(url.pathname)) {
    return jsonResponse({ repositories, pagination: { page: 1, perPage: 30, hasNextPage: false } });
  }

  if (url.pathname === '/api/github/app/installations/start') {
    return jsonResponse({ error: 'GitHub App navigation is disabled in this isolated preview.' }, 503);
  }

  const repoReviewsMatch = url.pathname.match(/^\/api\/dashboard\/repos\/(\d+)\/reviews$/);
  if (repoReviewsMatch && options.method !== 'POST') {
    return jsonResponse({ reviews: reviewHistory.map((review) => ({ ...review, findings: [...review.findings] })) });
  }

  const pullRequestMetadataMatch = url.pathname.match(/^\/api\/dashboard\/repos\/(\d+)\/pull-request-metadata$/);
  if (pullRequestMetadataMatch && options.method === 'POST') {
    const { pullRequestNumbers = [] } = parseBody(options);
    const metadata = {
      42: {
        number: 42,
        title: 'Prevent unsafe search query construction',
        author: 'advitya4169',
        sourceBranch: 'fix/search-query',
        targetBranch: 'main',
        updatedAt: '2026-11-05T16:20:00.000Z',
      },
      41: {
        number: 41,
        title: 'Share date formatting helper',
        author: 'octocat',
        sourceBranch: 'refactor/date-helper',
        targetBranch: 'main',
        updatedAt: '2026-11-02T10:05:00.000Z',
      },
      39: {
        number: 39,
        title: 'Update repository documentation',
        author: 'advitya4169',
        sourceBranch: 'docs/repository-guide',
        targetBranch: 'main',
        updatedAt: '2026-10-20T14:12:00.000Z',
      },
    };
    return jsonResponse({
      pullRequests: pullRequestNumbers.filter(number => metadata[number]).map(number => metadata[number]),
      unavailable: pullRequestNumbers.filter(number => !metadata[number]),
    });
  }

  const publicationRetryMatch = url.pathname.match(/^\/api\/dashboard\/repos\/(\d+)\/reviews\/([^/]+)\/retry-publication$/);
  if (publicationRetryMatch && options.method === 'POST') {
    const review = reviewHistory.find((item) => item._id === publicationRetryMatch[2]);
    if (!review) return jsonResponse({ error: 'Preview review not found.' }, 404);
    if (review.status !== 'completed' || review.githubPublicationStatus !== 'failed') {
      return jsonResponse({ error: 'Preview publication is not retryable.' }, 409);
    }
    review.githubPublicationStatus = 'published';
    review.githubPublicationUrl = 'https://github.com/advitya4169/Codeguard/pull/41#pullrequestreview-4141';
    return jsonResponse({
      reviewId: review._id,
      githubPublicationStatus: review.githubPublicationStatus,
      githubPublicationUrl: review.githubPublicationUrl,
    });
  }

  const retryMatch = url.pathname.match(/^\/api\/dashboard\/repos\/(\d+)\/reviews\/([^/]+)\/retry$/);
  if (retryMatch && options.method === 'POST') {
    const review = reviewHistory.find((item) => item._id === retryMatch[2]);
    if (!review) return jsonResponse({ error: 'Preview review not found.' }, 404);
    review.status = 'queued';
    review.summary = 'Preview retry queued. Mock analysis will complete shortly.';
    setTimeout(() => {
      review.status = 'completed';
      review.summary = 'Preview analysis completed after retry. This result is mock data.';
    }, 2200);
    return jsonResponse({ reviewId: review._id, status: 'queued' });
  }

  if (/^\/api\/github\/app\/installations\/[^/]+\/repos\/connect$/.test(url.pathname) && options.method === 'POST') {
    const { repositoryId } = parseBody(options);
    const repository = repositories.find((item) => item.id === repositoryId);
    if (!repository) return jsonResponse({ error: 'Preview repository not found.' }, 404);
    repository.connected = true;
    repository.connectionType = 'github_app';
    repository.installationId = 'preview-install-2026';
    return jsonResponse({ repository });
  }

  return jsonResponse({ error: 'No mock response is configured for this preview route.' }, 501);
};

window.fetch = mockApiFetch;

createRoot(document.getElementById('preview-root')).render(
  <BrowserRouter>
    <Dashboard />
  </BrowserRouter>,
);

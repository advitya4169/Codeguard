const GITHUB_API_URL = 'https://api.github.com';
const GITHUB_API_VERSION = '2022-11-28';

const getHeaders = (accessToken) => ({
  Authorization: `Bearer ${accessToken}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': GITHUB_API_VERSION,
});

const sanitizeGitHubErrorMessage = (message) => {
  if (typeof message !== 'string') return undefined;

  return message
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/gi, '[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED]')
    .replace(/\b(token|secret|authorization)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .trim()
    .slice(0, 300);
};

const getAcceptedGitHubPermissions = (headers) => {
  const value = headers?.get?.('x-accepted-github-permissions');
  if (typeof value !== 'string') return undefined;

  return value.replace(/[^A-Za-z0-9_,=\s-]/g, '').slice(0, 200);
};

const createGitHubError = async (response, endpoint, action, ambiguous = false) => {
  const error = new Error(`${action} (HTTP ${response.status})`);
  error.status = response.status;
  error.endpoint = endpoint;
  error.acceptedPermissions = getAcceptedGitHubPermissions(response.headers);
  error.ambiguous = ambiguous && response.status >= 500;

  try {
    const responseBody = await response.json();
    error.responseMessage = sanitizeGitHubErrorMessage(responseBody?.message);
  } catch {
    // Keep the status and endpoint when GitHub does not return JSON.
  }

  return error;
};

const requestGitHubJson = async (
  endpoint,
  accessToken,
  { fetchImpl = globalThis.fetch, method = 'GET', body, action, ambiguousNetwork = false, includeStatus = false } = {},
) => {
  let response;
  try {
    response = await fetchImpl(`${GITHUB_API_URL}${endpoint}`, {
      method,
      headers: {
        ...getHeaders(accessToken),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    const error = new Error(`${action} failed due to a network error.`);
    error.endpoint = `${GITHUB_API_URL}${endpoint}`;
    error.ambiguous = ambiguousNetwork;
    throw error;
  }

  if (!response.ok) {
    throw await createGitHubError(response, `${GITHUB_API_URL}${endpoint}`, action, method === 'POST');
  }

  try {
    const data = await response.json();
    return includeStatus ? { data, status: response.status } : data;
  } catch {
    const error = new Error(`${action} returned an invalid response.`);
    error.endpoint = `${GITHUB_API_URL}${endpoint}`;
    error.status = response.status;
    error.ambiguous = method === 'POST';
    throw error;
  }
};

const getNextPageUrl = (response, currentUrl) => {
  const linkHeader = response.headers?.get?.('link');
  if (typeof linkHeader !== 'string') return null;

  const nextLink = linkHeader
    .split(',')
    .map((link) => link.trim())
    .find((link) => /;\s*rel="?next"?(?:;|$)/i.test(link));
  const nextUrl = nextLink?.match(/<([^>]+)>/)?.[1];
  if (!nextUrl) return null;

  const parsedUrl = new URL(nextUrl, currentUrl);
  if (parsedUrl.origin !== GITHUB_API_URL) {
    throw new Error('GitHub returned an invalid pagination URL.');
  }

  return parsedUrl.toString();
};

const listPullRequestResource = async (
  repoFullName,
  prNumber,
  accessToken,
  resource,
  action,
  { fetchImpl = globalThis.fetch } = {},
) => {
  let nextUrl = `${GITHUB_API_URL}/repos/${repoFullName}/${resource}/${prNumber}/${resource === 'pulls' ? 'reviews' : 'comments'}?per_page=100`;
  const items = [];

  while (nextUrl) {
    let response;
    try {
      response = await fetchImpl(nextUrl, { headers: getHeaders(accessToken) });
    } catch {
      const error = new Error(`${action} failed due to a network error.`);
      error.endpoint = nextUrl;
      throw error;
    }

    if (!response.ok) {
      throw await createGitHubError(response, nextUrl, action);
    }

    let page;
    try {
      page = await response.json();
    } catch {
      throw new Error(`${action} returned an invalid response.`);
    }
    if (!Array.isArray(page)) {
      throw new Error(`${action} returned an invalid response.`);
    }

    items.push(...page);
    nextUrl = getNextPageUrl(response, nextUrl);
  }

  return items;
};

export const getPRDiff = async (repoFullName, prNumber, accessToken) => {
  const url = `${GITHUB_API_URL}/repos/${repoFullName}/pulls/${prNumber}`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/vnd.github.v3.diff',
    },
  });

  if (!response.ok) {
    const error = new Error(`Failed to fetch PR diff: ${response.status}`);
    error.status = response.status;
    error.endpoint = url;
    error.acceptedPermissions = getAcceptedGitHubPermissions(response.headers);
    throw error;
  }

  return await response.text();
};

export const getPRHeadSha = async (
  repoFullName,
  prNumber,
  accessToken,
  options = {},
) => {
  const pullRequest = await requestGitHubJson(
    `/repos/${repoFullName}/pulls/${prNumber}`,
    accessToken,
    { ...options, action: 'Failed to fetch pull request head' },
  );
  const headSha = pullRequest?.head?.sha;
  if (typeof headSha !== 'string' || !headSha.trim()) {
    throw new Error('GitHub returned an invalid pull request head.');
  }

  return headSha;
};

export const getPullRequestMetadata = async (
  repoFullName,
  prNumber,
  accessToken,
  options = {},
) => {
  if (typeof repoFullName !== 'string' || !/^[^/]+\/[^/]+$/.test(repoFullName)) {
    throw new Error('A valid repository name is required.');
  }
  if (!Number.isSafeInteger(prNumber) || prNumber < 1) {
    throw new Error('A valid pull request number is required.');
  }
  if (typeof accessToken !== 'string' || !accessToken) {
    throw new Error('GitHub authorization is unavailable.');
  }

  const [owner, repo] = repoFullName.split('/');
  const pullRequest = await requestGitHubJson(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${prNumber}`,
    accessToken,
    { ...options, action: 'Failed to fetch pull request metadata' },
  );
  const baseRepositoryId = pullRequest?.base?.repo?.id;
  if (
    pullRequest?.number !== prNumber ||
    !Number.isSafeInteger(baseRepositoryId) ||
    baseRepositoryId < 1
  ) {
    throw new Error('GitHub returned invalid pull request metadata.');
  }

  const updatedAt = typeof pullRequest.updated_at === 'string' &&
    Number.isFinite(Date.parse(pullRequest.updated_at))
    ? new Date(pullRequest.updated_at).toISOString()
    : null;

  return {
    number: prNumber,
    baseRepositoryId,
    title: typeof pullRequest.title === 'string' ? pullRequest.title : null,
    author: typeof pullRequest.user?.login === 'string' ? pullRequest.user.login : null,
    sourceBranch: typeof pullRequest.head?.ref === 'string' ? pullRequest.head.ref : null,
    targetBranch: typeof pullRequest.base?.ref === 'string' ? pullRequest.base.ref : null,
    updatedAt,
  };
};

export const listPRReviews = (repoFullName, prNumber, accessToken, options = {}) => (
  listPullRequestResource(
    repoFullName,
    prNumber,
    accessToken,
    'pulls',
    'Failed to list pull request reviews',
    options,
  )
);

export const listPRComments = (repoFullName, prNumber, accessToken, options = {}) => (
  listPullRequestResource(
    repoFullName,
    prNumber,
    accessToken,
    'issues',
    'Failed to list pull request conversation comments',
    options,
  )
);

export const createPRReview = (
  repoFullName,
  prNumber,
  accessToken,
  review,
  options = {},
) => requestGitHubJson(
  `/repos/${repoFullName}/pulls/${prNumber}/reviews`,
  accessToken,
  {
    ...options,
    method: 'POST',
    body: review,
    action: 'Failed to create pull request review',
    ambiguousNetwork: true,
    includeStatus: true,
  },
);

export const postPRComment = async (
  repoFullName,
  prNumber,
  accessToken,
  markdownBody,
  options = {},
) => requestGitHubJson(
  `/repos/${repoFullName}/issues/${prNumber}/comments`,
  accessToken,
  {
    ...options,
    method: 'POST',
    body: { body: markdownBody },
    action: 'Failed to post PR comment',
    ambiguousNetwork: true,
    includeStatus: options.includeStatus === true,
  },
);

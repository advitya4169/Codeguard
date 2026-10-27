export const getPRDiff = async (repoFullName, prNumber, accessToken) => {
  // We use the exact URL for the Pull Request
  const url = `https://api.github.com/repos/${repoFullName}/pulls/${prNumber}`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      // This special header tells GitHub: "Don't send me JSON metadata. Send me the raw Git Diff."
      Accept: 'application/vnd.github.v3.diff',
    },
  });

  if (!response.ok) {
    const error = new Error(`Failed to fetch PR diff: ${response.status}`);
    error.status = response.status;
    throw error;
  }

  // A diff is plain text, not JSON
  const diffText = await response.text();
  return diffText;
};

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

export const postPRComment = async (
  repoFullName,
  prNumber,
  accessToken,
  markdownBody
) => {
  const url = `https://api.github.com/repos/${repoFullName}/issues/${prNumber}/comments`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ body: markdownBody }),
  });

  if (!response.ok) {
    const error = new Error(`Failed to post PR comment: HTTP ${response.status}`);
    error.status = response.status;
    error.endpoint = url;
    error.acceptedPermissions = getAcceptedGitHubPermissions(response.headers);

    try {
      const responseBody = await response.json();
      error.responseMessage = sanitizeGitHubErrorMessage(responseBody?.message);
    } catch {
      // Keep the status and endpoint if GitHub did not return a JSON error body.
    }

    throw error;
  }

  return await response.json();
};

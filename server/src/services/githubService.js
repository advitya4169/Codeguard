//Fetches the PR diff from GitHub

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
  throw new Error(`Failed to fetch PR diff: ${response.status}`);
}

  // A diff is plain text, not JSON
  const diffText = await response.text();
  return diffText;
};
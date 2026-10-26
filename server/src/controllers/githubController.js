import User from '../models/User.js';
import Repository from '../models/Repository.js';

const formatRepository = (repository) => ({
  id: repository.id,
  name: repository.name,
  fullName: repository.full_name,
  private: repository.private,
  url: repository.html_url,
});

const hasNextGitHubPage = (response) => /<[^>]+>;\s*rel="next"/.test(response.headers.get('link') || '');

export const getUserRepositories = async (req, res) => {
  const page = req.query.page === undefined ? 1 : Number(req.query.page);
  const perPage = 30;
  if (!Number.isSafeInteger(page) || page < 1) {
    return res.status(400).json({ error: 'Page must be a positive integer' });
  }

  try {
    // 1. Get the user from the database using the ID attached by our middleware
    const user = await User.findById(req.user.userId);
    
    if (!user || !user.accessToken) {
      return res.status(404).json({ error: 'User or GitHub token not found' });
    }

    // 2. Fetch the user's repositories from GitHub
    let response;
    try {
      const repositoriesUrl = new URL('https://api.github.com/user/repos');
      repositoriesUrl.searchParams.set('sort', 'updated');
      repositoriesUrl.searchParams.set('per_page', String(perPage));
      repositoriesUrl.searchParams.set('page', String(page));
      response = await fetch(repositoriesUrl, {
        headers: {
          Authorization: `Bearer ${user.accessToken}`,
          Accept: 'application/vnd.github.v3+json', // Standard GitHub API header
        },
      });
    } catch {
      return res.status(503).json({
        error: 'GitHub is temporarily unavailable. Please retry loading repositories.',
        code: 'GITHUB_TEMPORARY_ERROR',
      });
    }

    if (!response.ok) {
      if (response.status === 401) {
        return res.status(401).json({
          error: 'GitHub authorization has expired or been revoked. Reconnect your GitHub account.',
          code: 'GITHUB_REAUTH_REQUIRED',
        });
      }
      const githubRateLimited = response.status === 429 || (
        response.status === 403 && (
          response.headers.get('x-ratelimit-remaining') === '0' ||
          response.headers.has('retry-after')
        )
      );
      if (response.status === 403 && !githubRateLimited) {
        return res.status(403).json({
          error: 'GitHub denied repository access. Reconnect GitHub or retry if this is temporary.',
          code: 'GITHUB_ACCESS_DENIED',
        });
      }
      if (githubRateLimited || response.status >= 500) {
        return res.status(503).json({
          error: 'GitHub is temporarily unavailable or rate limited. Please retry loading repositories.',
          code: 'GITHUB_TEMPORARY_ERROR',
        });
      }
      return res.status(502).json({
        error: 'GitHub could not return your repositories. Please retry.',
        code: 'GITHUB_API_ERROR',
      });
    }

    const repos = await response.json();
    
    // 3. Filter down the massive GitHub response payload to just what we need
    const repositoryIds = repos.map((repo) => repo.id);
    const connected = await Repository.find({
      userId: user._id,
      githubRepoId: { $in: repositoryIds },
      isConnected: true,
    }).select('githubRepoId installationId').lean();
    const connectionTypes = new Map(connected.map((repo) => [
      repo.githubRepoId,
      repo.installationId ? 'github_app' : 'oauth',
    ]));
    const formattedRepos = repos.map((repo) => ({
      ...formatRepository(repo),
      connected: connectionTypes.has(repo.id),
      connectionType: connectionTypes.get(repo.id) || null,
    }));

    const hasNextPage = hasNextGitHubPage(response);

    res.status(200).json({
      repositories: formattedRepos,
      pagination: { page, perPage, hasNextPage },
    });
  } catch (error) {
    console.error('Error fetching repositories:', error.message);
    res.status(500).json({ error: 'Could not load repositories. Please retry.' });
  }
};

export const connectRepository = async (req, res) => {
  const repositoryId = req.body?.repositoryId;
  if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0) {
    return res.status(400).json({ error: 'A valid repositoryId is required' });
  }

  try {
    const user = await User.findById(req.user.userId);
    if (!user || !user.accessToken) {
      return res.status(404).json({ error: 'User or GitHub token not found' });
    }

    // Treat the client ID only as a lookup hint. Search every page of GitHub's
    // authenticated repository list before accepting the association.
    let verified;
    let page = 1;
    while (!verified) {
      const repositoriesUrl = new URL('https://api.github.com/user/repos');
      repositoriesUrl.searchParams.set('sort', 'updated');
      repositoriesUrl.searchParams.set('per_page', '100');
      repositoriesUrl.searchParams.set('page', String(page));
      const response = await fetch(repositoriesUrl, {
        headers: {
          Authorization: `Bearer ${user.accessToken}`,
          Accept: 'application/vnd.github.v3+json',
        },
      });
      if (!response.ok) {
        console.error('GitHub repository verification failed:', response.status);
        return res.status(502).json({ error: 'Could not verify repository access with GitHub' });
      }

      const accessibleRepositories = await response.json();
      verified = accessibleRepositories.find((repo) => repo.id === repositoryId);
      if (verified || !hasNextGitHubPage(response)) break;
      page += 1;
    }

    if (!verified) {
      return res.status(403).json({ error: 'Repository is not accessible to this GitHub account' });
    }
    if (!verified.name || !verified.full_name || !verified.owner?.login) {
      return res.status(502).json({ error: 'GitHub returned invalid repository details' });
    }

    let repository = await Repository.findOne({ githubRepoId: verified.id });
    if (repository && String(repository.userId) !== String(user._id)) {
      return res.status(409).json({
        error: 'An existing repository connection must be reviewed before it can be changed',
      });
    }

    if (repository) {
      // This also provides a safe re-connection path for legacy records owned
      // by this same user, after access has been verified again with GitHub.
      repository.owner = verified.owner.login;
      repository.name = verified.name;
      repository.fullName = verified.full_name;
      repository.isConnected = true;
      await repository.save();
    } else {
      try {
        repository = await Repository.create({
          githubRepoId: verified.id,
          owner: verified.owner.login,
          name: verified.name,
          fullName: verified.full_name,
          userId: user._id,
          isConnected: true,
        });
      } catch (error) {
        // A concurrent connect may have created the unique repository record.
        if (error?.code !== 11000) throw error;
        repository = await Repository.findOne({ githubRepoId: verified.id });
        if (!repository || String(repository.userId) !== String(user._id)) {
          return res.status(409).json({
            error: 'An existing repository connection must be reviewed before it can be changed',
          });
        }
        repository.owner = verified.owner.login;
        repository.name = verified.name;
        repository.fullName = verified.full_name;
        repository.isConnected = true;
        await repository.save();
      }
    }

    return res.status(200).json({ repository: formatRepository(verified) });
  } catch (error) {
    console.error('Error connecting GitHub repository:', error.message);
    return res.status(500).json({ error: 'Failed to connect repository' });
  }
};

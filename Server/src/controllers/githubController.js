import User from '../models/User.js';

export const getUserRepositories = async (req, res) => {
  try {
    // 1. Get the user from the database using the ID attached by our middleware
    const user = await User.findById(req.user.userId);
    
    if (!user || !user.accessToken) {
      return res.status(404).json({ error: 'User or GitHub token not found' });
    }

    // 2. Fetch the user's repositories from GitHub
    const response = await fetch('https://api.github.com/user/repos?sort=updated&per_page=20', {
      headers: {
        Authorization: `Bearer ${user.accessToken}`,
        Accept: 'application/vnd.github.v3+json', // Standard GitHub API header
      },
    });

    if (!response.ok) {
      throw new Error(`GitHub API error: ${response.status}`);
    }

    const repos = await response.json();
    
    // 3. Filter down the massive GitHub response payload to just what we need
    const formattedRepos = repos.map(repo => ({
      id: repo.id,
      name: repo.name,
      fullName: repo.full_name,
      private: repo.private,
      url: repo.html_url,
    }));

    res.status(200).json({ repositories: formattedRepos });
  } catch (error) {
    console.error('Error fetching repositories:', error);
    res.status(500).json({ error: 'Failed to fetch repositories from GitHub' });
  }
};
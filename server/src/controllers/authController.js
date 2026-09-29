import jwt from 'jsonwebtoken';
import User from '../models/User.js';

export const githubLogin = (req, res) => {
  // We request 'repo' scope to read their code, and 'read:user' for their profile
  const githubAuthUrl = `https://github.com/login/oauth/authorize?client_id=${process.env.GITHUB_CLIENT_ID}&scope=repo,read:user`;
  res.redirect(githubAuthUrl);
};

export const githubCallback = async (req, res) => {
  const { code } = req.query;

  try {
    // 1. Exchange the temporary code for a persistent access token
    const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        client_id: process.env.GITHUB_CLIENT_ID,
        client_secret: process.env.GITHUB_CLIENT_SECRET,
        code,
      }),
    });

    const tokenData = await tokenResponse.json();
    const accessToken = tokenData.access_token;

    if (!accessToken) {
      throw new Error('Failed to retrieve access token from GitHub');
    }

    // 2. Use the access token to fetch the user's GitHub profile
    const userResponse = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    const userData = await userResponse.json();

    // 3. Upsert the user in MongoDB (Create if new, update if exists)
    let user = await User.findOne({ githubId: userData.id.toString() });

    if (!user) {
      user = new User({
        githubId: userData.id.toString(),
        username: userData.login,
        email: userData.email,
        avatarUrl: userData.avatar_url,
        accessToken: accessToken,
      });
    } else {
      user.accessToken = accessToken; // Always update token in case it expired/changed
      user.username = userData.login;
      user.avatarUrl = userData.avatar_url;
    }

    await user.save();

    // 4. Create a JWT session token for our React frontend
    const sessionToken = jwt.sign(
      { userId: user._id, username: user.username },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    // 5. Redirect back to React, passing the token in the URL
    res.redirect(`http://localhost:5173/login/success?token=${sessionToken}`);

  } catch (error) {
    console.error('GitHub Auth Error:', error);
    res.redirect('http://localhost:5173/login?error=auth_failed');
  }
};
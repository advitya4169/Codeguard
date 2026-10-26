import jwt from 'jsonwebtoken';
import User from '../models/User.js';

const getFrontendUrl = () => (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/+$/, '');

// Redirect user to GitHub login
export const githubLogin = (req, res) => {
  const githubAuthUrl =
    `https://github.com/login/oauth/authorize?client_id=${process.env.GITHUB_CLIENT_ID}&scope=repo,read:user`;

  res.redirect(githubAuthUrl);
};

// Handle GitHub callback
export const githubCallback = async (req, res) => {
  const { code, error: oauthError } = req.query;

  if (oauthError === 'access_denied') {
    return res.redirect(`${getFrontendUrl()}/login?error=access_denied`);
  }
  if (!code) {
    return res.redirect(`${getFrontendUrl()}/login?error=auth_failed`);
  }

  try {
    // Exchange code for GitHub access token
    const tokenResponse = await fetch(
      'https://github.com/login/oauth/access_token',
      {
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
      }
    );

    const tokenData = await tokenResponse.json();
    const accessToken = tokenData.access_token;
    if (!accessToken) {
      throw new Error('Failed to get GitHub access token');
    }

    // Get GitHub user information
    const userResponse = await fetch(
      'https://api.github.com/user',
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );

    const userData = await userResponse.json();

    // Find user in database
    let user = await User.findOne({
      githubId: userData.id.toString(),
    });

    // Create new user if not found
    if (!user) {
      user = new User({
        githubId: userData.id.toString(),
        username: userData.login,
        email: userData.email,
        avatarUrl: userData.avatar_url,
        accessToken: accessToken,
      });
    } else {
      // Update existing user
      user.accessToken = accessToken;
      user.username = userData.login;
      user.avatarUrl = userData.avatar_url;
    }

    await user.save();
    

    // Create our JWT
    const sessionToken = jwt.sign(
      {
        userId: user._id,
        username: user.username,
      },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    // Send JWT back to React
    res.redirect(
      `${getFrontendUrl()}/login/success?token=${sessionToken}`
    );

  } catch (error) {
    console.error('GitHub Auth Error:', error);

    // Redirect if login fails
    res.redirect(
      `${getFrontendUrl()}/login?error=auth_failed`
    );
  }
};

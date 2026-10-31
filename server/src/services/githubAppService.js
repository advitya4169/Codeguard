import jwt from 'jsonwebtoken';
import { readFileSync } from 'node:fs';

const GITHUB_API_URL = 'https://api.github.com';
const GITHUB_API_VERSION = '2022-11-28';
const APP_JWT_LIFETIME_SECONDS = 9 * 60;

const getAppHeaders = (token) => ({
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': GITHUB_API_VERSION,
});

const getAppOAuthConfiguration = () => {
  const clientId = process.env.GITHUB_APP_CLIENT_ID?.trim();
  const clientSecret = process.env.GITHUB_APP_CLIENT_SECRET;
  const callbackUrl = process.env.GITHUB_APP_CALLBACK_URL?.trim();

  if (!clientId || !clientSecret || !callbackUrl) {
    throw new Error('GitHub App authorization is not configured.');
  }

  let parsedCallbackUrl;
  try {
    parsedCallbackUrl = new URL(callbackUrl);
  } catch {
    throw new Error('GitHub App authorization configuration is invalid.');
  }

  const isLocalHttp = parsedCallbackUrl.protocol === 'http:' &&
    ['localhost', '127.0.0.1'].includes(parsedCallbackUrl.hostname);
  if (parsedCallbackUrl.protocol !== 'https:' && !isLocalHttp) {
    throw new Error('GitHub App authorization configuration is invalid.');
  }

  return { clientId, clientSecret, callbackUrl: parsedCallbackUrl.toString() };
};

const parseGitHubJson = async (response, errorMessage) => {
  if (!response?.ok) {
    const status = Number.isInteger(response?.status) ? response.status : 'unknown';
    throw new Error(`${errorMessage} (HTTP ${status}).`);
  }

  try {
    return await response.json();
  } catch {
    throw new Error(`${errorMessage} (invalid response).`);
  }
};

const getAppConfiguration = () => {
  const appId = process.env.GITHUB_APP_ID?.trim();
  const configuredPrivateKeyPath = process.env.GITHUB_APP_PRIVATE_KEY_PATH?.trim();
  let configuredPrivateKey = process.env.GITHUB_APP_PRIVATE_KEY;

  if (!appId || (!configuredPrivateKeyPath && !configuredPrivateKey)) {
    throw new Error('GitHub App authentication is not configured.');
  }

  if (!/^\d+$/.test(appId)) {
    throw new Error('GitHub App authentication configuration is invalid.');
  }

  if (configuredPrivateKeyPath) {
    try {
      configuredPrivateKey = readFileSync(configuredPrivateKeyPath, 'utf8');
    } catch {
      throw new Error('GitHub App private key file could not be read.');
    }
  }

  return {
    appId,
    // File-based PEM is preferred when configured; inline PEM supports literal escaped newlines.
    privateKey: configuredPrivateKey.replace(/\\n/g, '\n'),
  };
};

export const generateGitHubAppJWT = () => {
  const { appId, privateKey } = getAppConfiguration();
  const now = Math.floor(Date.now() / 1000);

  try {
    return jwt.sign(
      {
        iat: now - 60,
        exp: now + APP_JWT_LIFETIME_SECONDS,
      },
      privateKey,
      {
        algorithm: 'RS256',
        issuer: appId,
      },
    );
  } catch {
    throw new Error('GitHub App authentication configuration is invalid.');
  }
};

const normalizeInstallationId = (installationId) => {
  const value = String(installationId ?? '');
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error('A valid GitHub App installation ID is required.');
  }

  return value;
};

/**
 * Requests a short-lived installation token. The token is returned to the caller
 * in memory and is never logged or persisted by this helper.
 */
export const getInstallationAccessToken = async (
  installationId,
  { fetchImpl = globalThis.fetch } = {},
) => {
  const normalizedInstallationId = normalizeInstallationId(installationId);
  const appJwt = generateGitHubAppJWT();

  if (typeof fetchImpl !== 'function') {
    throw new Error('GitHub App token request could not be completed.');
  }

  let response;
  try {
    response = await fetchImpl(
      `${GITHUB_API_URL}/app/installations/${normalizedInstallationId}/access_tokens`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${appJwt}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': GITHUB_API_VERSION,
        },
      },
    );
  } catch {
    throw new Error('GitHub App installation token request failed due to a network error.');
  }

  if (!response?.ok) {
    const status = Number.isInteger(response?.status) ? response.status : 'unknown';
    const error = new Error(`GitHub App installation token request failed (HTTP ${status}).`);
    error.status = status;
    throw error;
  }

  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error('GitHub returned an invalid installation token response.');
  }

  if (
    typeof result?.token !== 'string' ||
    result.token.length === 0 ||
    typeof result.expires_at !== 'string' ||
    !Number.isFinite(Date.parse(result.expires_at))
  ) {
    throw new Error('GitHub returned an invalid installation token response.');
  }

  return {
    token: result.token,
    expiresAt: result.expires_at,
  };
};

/** Fetches and validates the GitHub App installation metadata using an App JWT. */
export const getGitHubAppInstallation = async (
  installationId,
  { fetchImpl = globalThis.fetch } = {},
) => {
  const normalizedInstallationId = normalizeInstallationId(installationId);
  const appJwt = generateGitHubAppJWT();
  let response;

  try {
    response = await fetchImpl(
      `${GITHUB_API_URL}/app/installations/${normalizedInstallationId}`,
      { headers: getAppHeaders(appJwt) },
    );
  } catch {
    throw new Error('GitHub App installation validation failed due to a network error.');
  }

  const result = await parseGitHubJson(response, 'GitHub App installation validation failed');
  if (
    String(result?.id) !== normalizedInstallationId ||
    (typeof result?.account?.id !== 'number' && typeof result?.account?.id !== 'string') ||
    typeof result?.account?.login !== 'string' ||
    typeof result?.account?.type !== 'string'
  ) {
    throw new Error('GitHub returned invalid installation details.');
  }

  return {
    id: normalizedInstallationId,
    accountId: String(result.account.id),
    accountLogin: result.account.login,
    accountName: typeof result.account.name === 'string' ? result.account.name : undefined,
    accountType: result.account.type,
    suspendedAt: typeof result.suspended_at === 'string' ? result.suspended_at : null,
  };
};

/** Exchanges a GitHub App authorization code for a user token held only in memory. */
export const exchangeGitHubAppAuthorizationCode = async (
  code,
  { fetchImpl = globalThis.fetch } = {},
) => {
  if (typeof code !== 'string' || code.length < 1 || code.length > 512) {
    throw new Error('GitHub App authorization code is invalid.');
  }

  const { clientId, clientSecret, callbackUrl } = getAppOAuthConfiguration();
  let response;
  try {
    response = await fetchImpl('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: callbackUrl,
      }),
    });
  } catch {
    throw new Error('GitHub App authorization failed due to a network error.');
  }

  const result = await parseGitHubJson(response, 'GitHub App authorization failed');
  if (typeof result?.access_token !== 'string' || result.access_token.length === 0) {
    throw new Error('GitHub App authorization failed.');
  }

  return result.access_token;
};

/** Returns only the GitHub user ID and login; never returns provider payloads. */
export const getGitHubAppAuthorizedUser = async (
  accessToken,
  { fetchImpl = globalThis.fetch } = {},
) => {
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    throw new Error('GitHub App user authorization is invalid.');
  }

  let response;
  try {
    response = await fetchImpl(`${GITHUB_API_URL}/user`, {
      headers: getAppHeaders(accessToken),
    });
  } catch {
    throw new Error('GitHub App user verification failed due to a network error.');
  }

  const result = await parseGitHubJson(response, 'GitHub App user verification failed');
  if (
    (typeof result?.id !== 'number' && typeof result?.id !== 'string') ||
    typeof result?.login !== 'string'
  ) {
    throw new Error('GitHub returned invalid user details.');
  }

  return { id: String(result.id), login: result.login };
};

/** Confirms the App user token can access the given installation. */
export const getGitHubAppUserInstallation = async (
  accessToken,
  installationId,
  { fetchImpl = globalThis.fetch } = {},
) => {
  const normalizedInstallationId = normalizeInstallationId(installationId);
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    throw new Error('GitHub App user authorization is invalid.');
  }

  let fetchedCount = 0;
  let page = 1;
  let totalCount = null;
  while (totalCount === null || fetchedCount < totalCount) {
    let response;
    try {
      response = await fetchImpl(
        `${GITHUB_API_URL}/user/installations?per_page=100&page=${page}`,
        { headers: getAppHeaders(accessToken) },
      );
    } catch {
      throw new Error('GitHub App installation verification failed due to a network error.');
    }

    const result = await parseGitHubJson(response, 'GitHub App installation verification failed');
    if (
      !Number.isSafeInteger(result?.total_count) ||
      result.total_count < 0 ||
      !Array.isArray(result.installations)
    ) {
      throw new Error('GitHub returned invalid installation details.');
    }

    if (totalCount === null) totalCount = result.total_count;
    fetchedCount += result.installations.length;

    const match = result.installations.find(
      (installation) => String(installation?.id) === normalizedInstallationId,
    );
    if (match) {
      if (
        (typeof match.account?.id !== 'number' && typeof match.account?.id !== 'string') ||
        typeof match.account?.login !== 'string' ||
        typeof match.account?.type !== 'string'
      ) {
        throw new Error('GitHub returned invalid installation details.');
      }

      return {
        id: normalizedInstallationId,
        accountId: String(match.account.id),
        accountLogin: match.account.login,
        accountType: match.account.type,
      };
    }

    if (result.installations.length === 0 || fetchedCount >= totalCount) break;
    page += 1;
  }

  throw new Error('The GitHub account is not authorized for this installation.');
};

export const getGitHubAppAuthorizationUrl = (state) => {
  if (typeof state !== 'string' || state.length === 0) {
    throw new Error('GitHub App authorization state is required.');
  }

  const { clientId, callbackUrl } = getAppOAuthConfiguration();
  const url = new URL('https://github.com/login/oauth/authorize');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', callbackUrl);
  url.searchParams.set('state', state);
  url.searchParams.set('allow_signup', 'false');
  return url.toString();
};

const normalizeInstallationRepository = (repository) => {
  if (
    !Number.isSafeInteger(repository?.id) ||
    repository.id <= 0 ||
    typeof repository.full_name !== 'string' ||
    typeof repository.private !== 'boolean' ||
    typeof repository.html_url !== 'string' ||
    typeof repository.owner?.login !== 'string' ||
    (typeof repository.owner?.id !== 'number' && typeof repository.owner?.id !== 'string')
  ) {
    throw new Error('GitHub returned invalid installation repository details.');
  }

  const name = typeof repository.name === 'string'
    ? repository.name
    : repository.full_name.slice(repository.full_name.lastIndexOf('/') + 1);

  return {
    id: repository.id,
    name,
    owner: repository.owner.login,
    ownerId: String(repository.owner.id),
    fullName: repository.full_name,
    private: repository.private,
    url: repository.html_url,
  };
};

/** Lists one page of repositories available to an installation access token. */
export const getInstallationRepositoriesPage = async (
  installationAccessToken,
  page = 1,
  { fetchImpl = globalThis.fetch } = {},
) => {
  if (typeof installationAccessToken !== 'string' || installationAccessToken.length === 0) {
    throw new Error('A GitHub App installation token is required.');
  }
  if (!Number.isSafeInteger(page) || page < 1) {
    throw new Error('A valid repository page is required.');
  }

  const perPage = 100;
  const url = new URL(`${GITHUB_API_URL}/installation/repositories`);
  url.searchParams.set('per_page', String(perPage));
  url.searchParams.set('page', String(page));

  let response;
  try {
    response = await fetchImpl(url, { headers: getAppHeaders(installationAccessToken) });
  } catch {
    const error = new Error('GitHub repository discovery failed due to a network error.');
    error.status = 503;
    throw error;
  }

  if (!response?.ok) {
    const status = Number.isInteger(response?.status) ? response.status : 502;
    const error = new Error(`GitHub repository discovery failed (HTTP ${status}).`);
    error.status = status;
    throw error;
  }

  let result;
  try {
    result = await response.json();
  } catch {
    const error = new Error('GitHub returned an invalid repository response.');
    error.status = 502;
    throw error;
  }

  if (
    !Number.isSafeInteger(result?.total_count) ||
    result.total_count < 0 ||
    !Array.isArray(result.repositories)
  ) {
    const error = new Error('GitHub returned an invalid repository response.');
    error.status = 502;
    throw error;
  }

  const repositories = result.repositories.map(normalizeInstallationRepository);
  const hasNextLink = /<[^>]+>;\s*rel="?next"?/.test(response.headers?.get?.('link') || '');
  const hasNextPage = hasNextLink || result.total_count > page * perPage;

  return {
    repositories,
    pagination: { page, perPage, hasNextPage },
  };
};

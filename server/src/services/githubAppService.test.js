import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  clearInstallationTokenCache,
  getInstallationAccessToken,
  TOKEN_EXPIRATION_BUFFER_MS,
} from './githubAppService.js';

const mockJwt = () => 'mock-app-jwt';

const createJsonResponse = (data, { status = 200 } = {}) => new Response(
  JSON.stringify(data),
  {
    status,
    headers: { 'Content-Type': 'application/json' },
  },
);

beforeEach(() => {
  clearInstallationTokenCache();
});

test('first request generates a token from GitHub', async () => {
  let callCount = 0;
  let requestDetails;
  const initialTime = 1_700_000_000_000;
  const expiresAt = new Date(initialTime + 60 * 60 * 1000).toISOString();

  const fetchImpl = async (url, options) => {
    callCount += 1;
    requestDetails = { url, options };
    return createJsonResponse({
      token: 'ghs_token_first_request',
      expires_at: expiresAt,
    });
  };

  const result = await getInstallationAccessToken('12345', {
    fetchImpl,
    generateJwtFn: mockJwt,
    nowFn: () => initialTime,
  });

  assert.equal(callCount, 1);
  assert.equal(result.token, 'ghs_token_first_request');
  assert.equal(result.expiresAt, expiresAt);
  assert.equal(requestDetails.url, 'https://api.github.com/app/installations/12345/access_tokens');
  assert.equal(requestDetails.options.method, 'POST');
  assert.equal(requestDetails.options.headers.Authorization, 'Bearer mock-app-jwt');
});

test('subsequent request for the same installation reuses the cached token', async () => {
  let callCount = 0;
  let currentTime = 1_700_000_000_000;
  const expiresAt = new Date(currentTime + 60 * 60 * 1000).toISOString();

  const fetchImpl = async () => {
    callCount += 1;
    return createJsonResponse({
      token: 'ghs_token_cached',
      expires_at: expiresAt,
    });
  };

  const firstResult = await getInstallationAccessToken('12345', {
    fetchImpl,
    generateJwtFn: mockJwt,
    nowFn: () => currentTime,
  });

  // Advance time by 10 minutes (token still has 50m remaining > 5m safety buffer)
  currentTime += 10 * 60 * 1000;

  const secondResult = await getInstallationAccessToken('12345', {
    fetchImpl,
    generateJwtFn: mockJwt,
    nowFn: () => currentTime,
  });

  assert.equal(callCount, 1, 'GitHub API must be called only once');
  assert.equal(secondResult.token, firstResult.token);
  assert.equal(secondResult.expiresAt, firstResult.expiresAt);
});

test('different installation IDs receive separate tokens', async () => {
  const callsByInstallation = [];
  const currentTime = 1_700_000_000_000;
  const expiresAt = new Date(currentTime + 60 * 60 * 1000).toISOString();

  const fetchImpl = async (url) => {
    const installationId = url.split('/installations/')[1]?.split('/')[0];
    callsByInstallation.push(installationId);
    return createJsonResponse({
      token: `ghs_token_for_${installationId}`,
      expires_at: expiresAt,
    });
  };

  const tokenA = await getInstallationAccessToken('1001', {
    fetchImpl,
    generateJwtFn: mockJwt,
    nowFn: () => currentTime,
  });

  const tokenB = await getInstallationAccessToken('2002', {
    fetchImpl,
    generateJwtFn: mockJwt,
    nowFn: () => currentTime,
  });

  assert.equal(tokenA.token, 'ghs_token_for_1001');
  assert.equal(tokenB.token, 'ghs_token_for_2002');
  assert.deepEqual(callsByInstallation, ['1001', '2002']);

  // Re-reading both installations reuses their respective cached entries
  const cachedA = await getInstallationAccessToken('1001', {
    fetchImpl,
    generateJwtFn: mockJwt,
    nowFn: () => currentTime,
  });
  const cachedB = await getInstallationAccessToken('2002', {
    fetchImpl,
    generateJwtFn: mockJwt,
    nowFn: () => currentTime,
  });

  assert.equal(cachedA.token, 'ghs_token_for_1001');
  assert.equal(cachedB.token, 'ghs_token_for_2002');
  assert.equal(callsByInstallation.length, 2, 'No additional calls should be made');
});

test('token refresh occurs inside the 5-minute safety window', async () => {
  let callCount = 0;
  let currentTime = 1_700_000_000_000;
  const firstExpiresAt = new Date(currentTime + 60 * 60 * 1000).toISOString(); // 60 minutes
  const refreshedExpiresAt = new Date(currentTime + 115 * 60 * 1000).toISOString();

  const fetchImpl = async () => {
    callCount += 1;
    return createJsonResponse({
      token: callCount === 1 ? 'ghs_initial_token' : 'ghs_refreshed_token',
      expires_at: callCount === 1 ? firstExpiresAt : refreshedExpiresAt,
    });
  };

  const initialToken = await getInstallationAccessToken('12345', {
    fetchImpl,
    generateJwtFn: mockJwt,
    nowFn: () => currentTime,
  });
  assert.equal(initialToken.token, 'ghs_initial_token');
  assert.equal(callCount, 1);

  // At 54 minutes: 6 minutes remaining (> 5m buffer) -> cache must be reused
  currentTime += 54 * 60 * 1000;
  const stillCachedToken = await getInstallationAccessToken('12345', {
    fetchImpl,
    generateJwtFn: mockJwt,
    nowFn: () => currentTime,
  });
  assert.equal(stillCachedToken.token, 'ghs_initial_token');
  assert.equal(callCount, 1);

  // At 55 minutes and 1 second: 4m 59s remaining (<= 5m buffer) -> must refresh
  currentTime += (1 * 60 + 1) * 1000;
  const refreshedToken = await getInstallationAccessToken('12345', {
    fetchImpl,
    generateJwtFn: mockJwt,
    nowFn: () => currentTime,
  });
  assert.equal(refreshedToken.token, 'ghs_refreshed_token');
  assert.equal(callCount, 2);
  assert.equal(refreshedToken.expiresAt, refreshedExpiresAt);
});

test('concurrent requests for the same installation trigger only one GitHub API request', async () => {
  let callCount = 0;
  const currentTime = 1_700_000_000_000;
  const expiresAt = new Date(currentTime + 60 * 60 * 1000).toISOString();

  const fetchImpl = async () => {
    callCount += 1;
    // Simulate network delay
    await new Promise((resolve) => setTimeout(resolve, 25));
    return createJsonResponse({
      token: 'ghs_concurrent_token',
      expires_at: expiresAt,
    });
  };

  // Launch 5 concurrent calls simultaneously
  const results = await Promise.all([
    getInstallationAccessToken('99999', { fetchImpl, generateJwtFn: mockJwt, nowFn: () => currentTime }),
    getInstallationAccessToken('99999', { fetchImpl, generateJwtFn: mockJwt, nowFn: () => currentTime }),
    getInstallationAccessToken('99999', { fetchImpl, generateJwtFn: mockJwt, nowFn: () => currentTime }),
    getInstallationAccessToken('99999', { fetchImpl, generateJwtFn: mockJwt, nowFn: () => currentTime }),
    getInstallationAccessToken('99999', { fetchImpl, generateJwtFn: mockJwt, nowFn: () => currentTime }),
  ]);

  assert.equal(callCount, 1, 'Only one API request should be triggered for in-flight calls');
  for (const res of results) {
    assert.equal(res.token, 'ghs_concurrent_token');
    assert.equal(res.expiresAt, expiresAt);
  }
});

test('concurrent requests for different installations remain independent', async () => {
  const startedInstallations = [];
  const currentTime = 1_700_000_000_000;

  const fetchImpl = async (url) => {
    const id = url.split('/installations/')[1]?.split('/')[0];
    startedInstallations.push(id);
    await new Promise((resolve) => setTimeout(resolve, 20));
    return createJsonResponse({
      token: `token_${id}`,
      expires_at: new Date(currentTime + 60 * 60 * 1000).toISOString(),
    });
  };

  const [res1, res2] = await Promise.all([
    getInstallationAccessToken('11111', { fetchImpl, generateJwtFn: mockJwt, nowFn: () => currentTime }),
    getInstallationAccessToken('22222', { fetchImpl, generateJwtFn: mockJwt, nowFn: () => currentTime }),
  ]);

  assert.equal(res1.token, 'token_11111');
  assert.equal(res2.token, 'token_22222');
  assert.equal(startedInstallations.length, 2);
  assert.ok(startedInstallations.includes('11111'));
  assert.ok(startedInstallations.includes('22222'));
});

test('failed token generation is not cached and a subsequent request can succeed', async () => {
  let callCount = 0;
  const currentTime = 1_700_000_000_000;
  const expiresAt = new Date(currentTime + 60 * 60 * 1000).toISOString();

  const fetchImpl = async () => {
    callCount += 1;
    if (callCount === 1) {
      return createJsonResponse({ message: 'Internal Server Error' }, { status: 500 });
    }
    return createJsonResponse({
      token: 'ghs_recovered_token',
      expires_at: expiresAt,
    });
  };

  // First request fails with HTTP 500
  await assert.rejects(
    async () => {
      await getInstallationAccessToken('12345', {
        fetchImpl,
        generateJwtFn: mockJwt,
        nowFn: () => currentTime,
      });
    },
    (error) => {
      assert.equal(error.status, 500);
      assert.match(error.message, /HTTP 500/);
      return true;
    },
  );

  assert.equal(callCount, 1);

  // Subsequent request must NOT find a cached failure and must succeed
  const recoveredResult = await getInstallationAccessToken('12345', {
    fetchImpl,
    generateJwtFn: mockJwt,
    nowFn: () => currentTime,
  });

  assert.equal(callCount, 2);
  assert.equal(recoveredResult.token, 'ghs_recovered_token');

  // Next request reuses the newly cached valid token
  const cachedResult = await getInstallationAccessToken('12345', {
    fetchImpl,
    generateJwtFn: mockJwt,
    nowFn: () => currentTime,
  });

  assert.equal(callCount, 2, 'Subsequent call must reuse the successfully recovered token');
  assert.equal(cachedResult.token, 'ghs_recovered_token');
});

test('expired tokens are never reused', async () => {
  let callCount = 0;
  let currentTime = 1_700_000_000_000;

  const fetchImpl = async () => {
    callCount += 1;
    return createJsonResponse({
      token: `ghs_token_attempt_${callCount}`,
      expires_at: new Date(currentTime + 30 * 60 * 1000).toISOString(), // 30 minutes
    });
  };

  const firstResult = await getInstallationAccessToken('12345', {
    fetchImpl,
    generateJwtFn: mockJwt,
    nowFn: () => currentTime,
  });
  assert.equal(firstResult.token, 'ghs_token_attempt_1');
  assert.equal(callCount, 1);

  // Advance time past the expiration timestamp (35 minutes later)
  currentTime += 35 * 60 * 1000;

  const secondResult = await getInstallationAccessToken('12345', {
    fetchImpl,
    generateJwtFn: mockJwt,
    nowFn: () => currentTime,
  });

  assert.equal(callCount, 2, 'Expired token must trigger a fresh request');
  assert.equal(secondResult.token, 'ghs_token_attempt_2');
});

test('rejects invalid installation IDs before attempting network calls', async () => {
  let networkCalled = false;
  const fetchImpl = async () => {
    networkCalled = true;
    return createJsonResponse({});
  };

  await assert.rejects(
    () => getInstallationAccessToken('', { fetchImpl }),
    /A valid GitHub App installation ID is required/,
  );
  await assert.rejects(
    () => getInstallationAccessToken('abc', { fetchImpl }),
    /A valid GitHub App installation ID is required/,
  );
  await assert.rejects(
    () => getInstallationAccessToken('-1', { fetchImpl }),
    /A valid GitHub App installation ID is required/,
  );

  assert.equal(networkCalled, false);
});

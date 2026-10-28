import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertAnyRequiredEnv,
  assertRequiredEnv,
  getTrustProxySetting,
} from './env.js';

test('required environment validation reports missing variable names', () => {
  const previous = process.env.CODEGUARD_TEST_REQUIRED;
  delete process.env.CODEGUARD_TEST_REQUIRED;
  try {
    assert.throws(
      () => assertRequiredEnv(['CODEGUARD_TEST_REQUIRED'], 'Test service'),
      /Test service is missing required environment variables: CODEGUARD_TEST_REQUIRED/,
    );
  } finally {
    if (previous === undefined) delete process.env.CODEGUARD_TEST_REQUIRED;
    else process.env.CODEGUARD_TEST_REQUIRED = previous;
  }
});

test('alternative environment validation accepts either configured key source', () => {
  const previous = process.env.CODEGUARD_TEST_KEY_PATH;
  process.env.CODEGUARD_TEST_KEY_PATH = 'test-key-path';
  try {
    assert.doesNotThrow(() =>
      assertAnyRequiredEnv(['CODEGUARD_TEST_KEY_PATH', 'CODEGUARD_TEST_KEY'], 'Test service'),
    );
  } finally {
    if (previous === undefined) delete process.env.CODEGUARD_TEST_KEY_PATH;
    else process.env.CODEGUARD_TEST_KEY_PATH = previous;
  }
});

test('proxy trust accepts loopback or an explicit hop count only', () => {
  const previous = process.env.TRUST_PROXY_HOPS;
  try {
    delete process.env.TRUST_PROXY_HOPS;
    assert.equal(getTrustProxySetting(), 'loopback');
    process.env.TRUST_PROXY_HOPS = '2';
    assert.equal(getTrustProxySetting(), 2);
    process.env.TRUST_PROXY_HOPS = 'true';
    assert.throws(() => getTrustProxySetting(), /TRUST_PROXY_HOPS must be/);
  } finally {
    if (previous === undefined) delete process.env.TRUST_PROXY_HOPS;
    else process.env.TRUST_PROXY_HOPS = previous;
  }
});

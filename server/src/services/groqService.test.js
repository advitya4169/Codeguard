import test from 'node:test';
import assert from 'node:assert/strict';

import {
  analyzeDiffWithGroq,
  calculateReviewBackoff,
  extractRateLimitRetryMs,
  isPermanentError,
  parseDurationToMs,
  parseTimeoutMs,
  sanitizeErrorMessage,
  DEFAULT_GROQ_TIMEOUT_MS,
  MIN_RETRY_DELAY_MS,
  MAX_RETRY_DELAY_MS,
  GroqTimeoutError,
  GroqTruncatedResponseError,
} from './groqService.js';

const sampleFindings = [
  {
    title: 'SQL injection',
    category: 'security',
    severity: 'high',
    filePath: 'src/db.js',
    lineNumber: 10,
    explanation: 'Evidence: `query(input)` — SQL injection.',
    suggestedFix: 'Use parameterized query.',
  },
];

test('1. successful Groq response parses and returns structured findings', async () => {
  let requestOptions;
  const mockClient = {
    chat: {
      completions: {
        create: async (body, options) => {
          requestOptions = options;
          return {
            model: 'openai/gpt-oss-20b',
            choices: [
              {
                finish_reason: 'stop',
                message: {
                  content: JSON.stringify({ findings: sampleFindings }),
                },
              },
            ],
            usage: { total_tokens: 150 },
          };
        },
      },
    },
  };

  const result = await analyzeDiffWithGroq('diff --git a/src/db.js b/src/db.js', {
    client: mockClient,
    timeoutMs: 45_000,
    parseResponseFn: (text) => JSON.parse(text).findings,
  });

  assert.equal(requestOptions.timeout, 45_000);
  assert.equal(result.length, 1);
  assert.equal(result[0].title, 'SQL injection');
});

test('2. request timeout throws GroqTimeoutError and classifies as transient', async () => {
  const timeoutError = new Error('Request timed out.');
  timeoutError.name = 'APIConnectionTimeoutError';

  const mockClient = {
    chat: {
      completions: {
        create: async () => {
          throw timeoutError;
        },
      },
    },
  };

  await assert.rejects(
    () => analyzeDiffWithGroq('diff --git ...', { client: mockClient, timeoutMs: 30_000 }),
    (err) => {
      assert.ok(err instanceof GroqTimeoutError);
      assert.equal(err.status, 408);
      assert.equal(err.timeoutMs, 30_000);
      assert.match(err.message, /timed out after 30000ms/);
      return true;
    },
  );

  // Verify timeout error is retriable and not considered permanent
  assert.equal(isPermanentError(new GroqTimeoutError(30_000)), false);
  const backoff = calculateReviewBackoff(1, 'exponential', new GroqTimeoutError(30_000), {
    opts: { backoff: { delay: 5_000 } },
  });
  assert.equal(backoff, 5_000);
});

test('3. HTTP 429 with Retry-After header respects suggested recovery delay', () => {
  const rateLimitError = new Error('Rate limit reached');
  rateLimitError.status = 429;
  rateLimitError.headers = {
    'retry-after': '18',
  };

  assert.equal(isPermanentError(rateLimitError), false);
  const delayMs = extractRateLimitRetryMs(rateLimitError);
  assert.equal(delayMs, 18_000);

  const backoff = calculateReviewBackoff(1, 'custom', rateLimitError);
  assert.equal(backoff, 18_000);
});

test('4. HTTP 429 with rate-limit reset headers extracts the most conservative delay', () => {
  const rateLimitError = new Error('Rate limit reached');
  rateLimitError.status = 429;
  rateLimitError.headers = {
    'x-ratelimit-reset-requests': '2s',
    'x-ratelimit-reset-tokens': '25s',
  };

  const delayMs = extractRateLimitRetryMs(rateLimitError);
  assert.equal(delayMs, 25_000, 'Must choose the longer token reset interval');

  const backoff = calculateReviewBackoff(1, 'custom', rateLimitError);
  assert.equal(backoff, 25_000);

  // Test various duration formats
  assert.equal(parseDurationToMs('500ms'), 500);
  assert.equal(parseDurationToMs('1.5s'), 1500);
  assert.equal(parseDurationToMs('1m30s'), 90000);
  assert.equal(parseDurationToMs('2m'), 120000);

  // Clamps short delays to MIN_RETRY_DELAY_MS (1000ms)
  const shortError = { status: 429, headers: { 'retry-after': '0.2' } };
  assert.equal(calculateReviewBackoff(1, 'custom', shortError), MIN_RETRY_DELAY_MS);
});

test('5. transient HTTP 5xx responses are retried with exponential backoff', () => {
  for (const status of [500, 502, 503, 504]) {
    const error5xx = new Error(`Server error HTTP ${status}`);
    error5xx.status = status;

    assert.equal(isPermanentError(error5xx), false, `HTTP ${status} should be transient`);
    const backoff = calculateReviewBackoff(2, 'exponential', error5xx, {
      opts: { backoff: { delay: 5_000 } },
    });
    assert.equal(backoff, 10_000, 'Attempt 2 must use 10000ms delay');
  }
});

test('6. permanent errors are not retried and return -1 from backoff strategy', () => {
  for (const status of [400, 401, 403, 404, 422]) {
    const permError = new Error(`Client error HTTP ${status}`);
    permError.status = status;

    assert.equal(isPermanentError(permError), true, `HTTP ${status} should be permanent`);
    const backoff = calculateReviewBackoff(1, 'custom', permError);
    assert.equal(backoff, -1, `Permanent error HTTP ${status} must return -1 to abort retries`);
  }

  // Model refusal is permanent
  const refusalError = new Error('Groq refused the review: Safety violation');
  refusalError.isRefusal = true;
  assert.equal(isPermanentError(refusalError), true);
  assert.equal(calculateReviewBackoff(1, 'custom', refusalError), -1);

  // Oversized diff error is permanent
  const oversizedError = new Error('This pull request diff is too large for a reliable AI review');
  assert.equal(isPermanentError(oversizedError), true);
  assert.equal(calculateReviewBackoff(1, 'custom', oversizedError), -1);
});

test('7. fallback exponential backoff applies correctly when no rate-limit headers exist', () => {
  const genericError = new Error('Transient socket disconnect');
  const job = { opts: { backoff: { delay: 5_000 } } };

  // Attempt 1: 5000 * 2^0 = 5000ms
  assert.equal(calculateReviewBackoff(1, 'exponential', genericError, job), 5_000);

  // Attempt 2: 5000 * 2^1 = 10000ms
  assert.equal(calculateReviewBackoff(2, 'exponential', genericError, job), 10_000);

  // Attempt 3: 5000 * 2^2 = 20000ms
  assert.equal(calculateReviewBackoff(3, 'exponential', genericError, job), 20_000);

  // Large attempts are bounded by MAX_RETRY_DELAY_MS (120000ms)
  assert.equal(calculateReviewBackoff(10, 'exponential', genericError, job), MAX_RETRY_DELAY_MS);
});

test('8. truncated response (finish_reason === "length") throws GroqTruncatedResponseError', async () => {
  const mockClient = {
    chat: {
      completions: {
        create: async () => ({
          model: 'openai/gpt-oss-20b',
          choices: [
            {
              finish_reason: 'length',
              message: {
                content: '{"findings": [{"title": "Cut off mid-way',
              },
            },
          ],
        }),
      },
    },
  };

  await assert.rejects(
    () => analyzeDiffWithGroq('diff --git ...', { client: mockClient }),
    (err) => {
      assert.ok(err instanceof GroqTruncatedResponseError);
      assert.equal(err.finishReason, 'length');
      assert.equal(err.isTruncated, true);
      assert.match(err.message, /token limit was reached/);
      assert.doesNotMatch(err.message, /invalid JSON/);
      return true;
    },
  );
});

test('sanitizes error messages to prevent leaking API keys or Bearer tokens', () => {
  const secretMsg = 'Error communicating with Groq: gsk_abcdef1234567890 key rejected by Bearer eyJhbGciOi...';
  const sanitized = sanitizeErrorMessage(secretMsg);

  assert.doesNotMatch(sanitized, /gsk_abcdef1234567890/);
  assert.doesNotMatch(sanitized, /Bearer eyJ/);
  assert.match(sanitized, /\[REDACTED\]/);
});

test('parseTimeoutMs handles environment variables and defaults sensibly', () => {
  assert.equal(parseTimeoutMs(undefined, 60_000), 60_000);
  assert.equal(parseTimeoutMs('', 60_000), 60_000);
  assert.equal(parseTimeoutMs('30000', 60_000), 30_000);
  assert.equal(parseTimeoutMs(45_000, 60_000), 45_000);
  assert.equal(parseTimeoutMs('-500', 60_000), 60_000);
  assert.equal(parseTimeoutMs('invalid', 60_000), 60_000);
});

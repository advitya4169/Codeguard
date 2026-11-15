import Groq from 'groq-sdk';
import dotenv from 'dotenv';

dotenv.config({ quiet: true });

export const parseTimeoutMs = (value, defaultMs = 60_000) => {
  if (value === undefined || value === null || value === '') return defaultMs;
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  return defaultMs;
};

export const DEFAULT_GROQ_TIMEOUT_MS = parseTimeoutMs(process.env.GROQ_TIMEOUT_MS, 60_000);
export const MIN_RETRY_DELAY_MS = 1_000;
export const MAX_RETRY_DELAY_MS = 120_000;
export const GROQ_MODEL = 'openai/gpt-oss-20b';

export class GroqTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`Groq review request timed out after ${timeoutMs}ms.`);
    this.name = 'GroqTimeoutError';
    this.status = 408;
    this.timeoutMs = timeoutMs;
  }
}

export class GroqTruncatedResponseError extends Error {
  constructor(message = 'Groq review response was truncated because the completion token limit was reached.') {
    super(message);
    this.name = 'GroqTruncatedResponseError';
    this.finishReason = 'length';
    this.isTruncated = true;
  }
}

export const sanitizeErrorMessage = (message) => {
  if (typeof message !== 'string') return 'An unknown error occurred during Groq analysis.';
  return message
    .replace(/gsk_[A-Za-z0-9]+/gi, '[REDACTED]')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .slice(0, 300);
};

export const parseDurationToMs = (value) => {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const str = String(value).trim();
  if (!str) return null;

  // Pure integer or decimal number representing seconds
  if (/^\d+(?:\.\d+)?$/.test(str)) {
    const seconds = parseFloat(str);
    return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : null;
  }

  // Duration formats like "1m30s", "500ms", "12s", "2.5s", "2m"
  let totalMs = 0;
  let matched = false;

  const msMatch = str.match(/(\d+(?:\.\d+)?)\s*ms/i);
  if (msMatch) {
    totalMs += parseFloat(msMatch[1]);
    matched = true;
  }

  const secMatch = str.match(/(\d+(?:\.\d+)?)\s*s(?:ec(?:ond)?s?)?(?![a-zA-Z])/i);
  if (secMatch) {
    totalMs += parseFloat(secMatch[1]) * 1000;
    matched = true;
  }

  const minMatch = str.match(/(\d+(?:\.\d+)?)\s*m(?:in(?:ute)?s?)?(?![a-zA-Z])/i);
  if (minMatch) {
    totalMs += parseFloat(minMatch[1]) * 60 * 1000;
    matched = true;
  }

  if (matched && Number.isFinite(totalMs) && totalMs > 0) {
    return Math.round(totalMs);
  }

  // Parse HTTP Date header (e.g., "Wed, 21 Oct 2026 07:28:00 GMT")
  const parsedDate = Date.parse(str);
  if (Number.isFinite(parsedDate)) {
    const diff = parsedDate - Date.now();
    return diff > 0 ? diff : 0;
  }

  return null;
};

const extractHeaderValue = (headers, name) => {
  if (!headers) return null;
  if (typeof headers.get === 'function') {
    return headers.get(name) || headers.get(name.toLowerCase());
  }
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target && value !== undefined && value !== null) {
      return String(value);
    }
  }
  return null;
};

export const extractRateLimitRetryMs = (error) => {
  if (!error) return null;
  const headers = error.headers || error.response?.headers;

  const retryAfter = extractHeaderValue(headers, 'retry-after') ?? error.retryAfter;
  const resetTokens = extractHeaderValue(headers, 'x-ratelimit-reset-tokens');
  const resetRequests = extractHeaderValue(headers, 'x-ratelimit-reset-requests');

  const candidates = [retryAfter, resetTokens, resetRequests].filter(Boolean);
  const parsedDelays = candidates
    .map(parseDurationToMs)
    .filter((ms) => typeof ms === 'number' && Number.isFinite(ms) && ms > 0);

  if (parsedDelays.length > 0) {
    // Pick the most conservative (longest) suggested delay
    return Math.max(...parsedDelays);
  }

  return null;
};

export const isPermanentError = (error) => {
  if (!error) return false;

  if (error.name === 'UnrecoverableError' || error.unrecoverable === true) return true;

  const status = Number(error.status ?? error.statusCode ?? error.response?.status);
  if (Number.isInteger(status)) {
    // 400 Bad Request, 401 Unauthorized, 403 Forbidden, 404 Not Found, 422 Unprocessable Entity
    if ([400, 401, 403, 404, 422].includes(status)) {
      return true;
    }
    // Rate limit (429), timeouts (408), and 5xx are transient
    if (status === 429 || status === 408 || status >= 500) {
      return false;
    }
  }

  if (error.isRefusal || /refused the review/i.test(error.message)) return true;
  if (/too large for a reliable AI review/i.test(error.message)) return true;
  if (/Repository is no longer connected/i.test(error.message)) return true;
  if (/Review job metadata is invalid/i.test(error.message)) return true;
  if (/Legacy OAuth review job is missing/i.test(error.message)) return true;

  return false;
};

export const calculateReviewBackoff = (attemptsMade, type, error, job) => {
  if (isPermanentError(error)) {
    return -1;
  }

  const rateLimitMs = extractRateLimitRetryMs(error);
  if (rateLimitMs !== null) {
    return Math.min(Math.max(rateLimitMs, MIN_RETRY_DELAY_MS), MAX_RETRY_DELAY_MS);
  }

  // Fallback to exponential backoff
  const baseDelay = Number(job?.opts?.backoff?.delay) || 5_000;
  const attempts = Math.max(1, Number.isInteger(attemptsMade) ? attemptsMade : 1);
  const exponentialDelay = Math.round(Math.pow(2, attempts - 1) * baseDelay);
  return Math.min(exponentialDelay, MAX_RETRY_DELAY_MS);
};

export const createGroqClient = ({
  apiKey = process.env.GROQ_API_KEY,
  timeout = DEFAULT_GROQ_TIMEOUT_MS,
  maxRetries = 0, // Disable internal SDK retries so BullMQ orchestrates retry timing with full visibility
} = {}) => {
  if (!apiKey) {
    throw new Error('GROQ_API_KEY is not defined in .env');
  }

  return new Groq({
    apiKey,
    timeout,
    maxRetries,
  });
};

let defaultGroqClient = null;
export const getGroqClient = () => {
  if (!defaultGroqClient) {
    defaultGroqClient = createGroqClient();
  }
  return defaultGroqClient;
};

export const resetGroqClient = () => {
  defaultGroqClient = null;
};

const allowedCategories = [
  'bug',
  'security',
  'performance',
  'code_quality',
  'maintainability',
];

const allowedSeverities = [
  'critical',
  'high',
  'medium',
  'low',
  'suggestion',
];

export const analyzeDiffWithGroq = async (
  diff,
  {
    client,
    timeoutMs = DEFAULT_GROQ_TIMEOUT_MS,
    model = GROQ_MODEL,
    parseResponseFn,
  } = {},
) => {
  const groq = client || getGroqClient();

  const prompt = `
Review this Git diff as a senior software engineer.

Identify genuine:
- Bugs
- Security vulnerabilities
- Performance issues
- Code quality problems
- Maintainability issues

Base every finding on specific code shown in the supplied diff. Start each explanation with Evidence: followed by an exact short code excerpt enclosed in backticks, then a dash and how that code causes the issue. Do not infer behavior in files or code the diff does not show, or report claims contradicted by the diff.
Use an exact file path and the new-side line containing the cited code. Prefer the actual vulnerable statement over nearby braces, imports, or declarations. If no reliable location is visible, omit the finding.
Do not claim syntax errors, undefined variables, incomplete implementations, or filename conflicts without direct evidence. Check that a claimed undefined name is not declared in the shown code. Test and fixture files remain valid review targets; describe risks in their test/example context and do not imply production impact without evidence.
If no genuine issues exist, return an empty findings array.

Return exactly one JSON object in this format:
{
  "findings": [
    {
      "title": "SQL injection in search query",
      "category": "bug",
      "severity": "high",
      "filePath": "src/example.js",
      "lineNumber": 10,
      "explanation": "Evidence: [exact code excerpt in backticks] — explain how it causes the issue",
      "suggestedFix": "Explain how to fix it"
    }
  ]
}

Allowed categories: ${allowedCategories.join(', ')}.
Allowed severities: ${allowedSeverities.join(', ')}.

Return JSON only. No Markdown fences or surrounding explanation.

Git diff:
${diff}
`;

  let completion;
  try {
    completion = await groq.chat.completions.create(
      {
        model,
        messages: [
          {
            role: 'system',
            content:
              'You are an expert code reviewer. Review only evidence present in the supplied diff. Return one valid JSON object with a findings array. Each finding should include a concise title of at most 8 words, category, severity, exact diff filePath, positive new-side diff lineNumber, explanation, and suggestedFix. Start explanation with Evidence: `exact short code excerpt from the cited line` — then explain how that code causes the issue. Do not invent or speculate; reject claims contradicted by the diff. Do not claim syntax errors, undefined variables, incomplete implementations, or filename conflicts without direct evidence. Assess test/fixture code in its actual context and do not imply production impact without evidence. Omit findings without a reliable location. Return only JSON.',
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
        temperature: 0,
        max_completion_tokens: 8192,
      },
      {
        timeout: timeoutMs,
      },
    );
  } catch (error) {
    if (error?.name === 'APIConnectionTimeoutError' || /timeout/i.test(error?.message)) {
      throw new GroqTimeoutError(timeoutMs);
    }
    error.message = sanitizeErrorMessage(error?.message);
    throw error;
  }

  const choice = completion.choices?.[0];
  const message = choice?.message;

  console.log('Groq response diagnostics:', {
    model: completion.model,
    finishReason: choice?.finish_reason,
    contentType: typeof message?.content,
    contentLength: typeof message?.content === 'string' ? message.content.length : 0,
    refusal: Boolean(message?.refusal),
    reasoningPresent: Boolean(message?.reasoning),
    usage: completion.usage,
  });

  if (message?.refusal) {
    const refusalError = new Error(`Groq refused the review: ${message.refusal}`);
    refusalError.isRefusal = true;
    throw refusalError;
  }

  if (choice?.finish_reason === 'length') {
    throw new GroqTruncatedResponseError(
      'Groq review response was truncated because the completion token limit was reached.',
    );
  }

  const responseText = message?.content;
  if (typeof responseText !== 'string' || !responseText.trim()) {
    throw new Error(
      `Groq returned no review text. Finish reason: ${choice?.finish_reason ?? 'unknown'}`,
    );
  }

  if (typeof parseResponseFn === 'function') {
    return parseResponseFn(responseText, choice);
  }

  return responseText;
};

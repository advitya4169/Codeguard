/**
 * demoRateLimiter — in-memory sliding-window rate limiter for POST /api/review.
 *
 * Limits each IP to MAX_REQUESTS per WINDOW_MS to prevent automated abuse of
 * the unauthenticated demo endpoint and uncontrolled Groq API credit consumption.
 *
 * Implementation notes:
 *  - Uses a Map<ip, number[]> of request timestamps. No external packages required.
 *  - A setInterval cleanup removes stale entries to prevent memory growth.
 *  - Suitable for a single-process Node.js server. If the app is ever scaled
 *    horizontally, replace this with a Redis-backed limiter (e.g. rate-limiter-flexible).
 */

const WINDOW_MS = 60 * 1000; // 1 minute
const MAX_REQUESTS = 10;      // per IP per window

const ipTimestamps = new Map();

export function demoRateLimiter(req, res, next) {
  // Express resolves req.ip from the socket peer. Forwarded values are used
  // only when the peer is in the narrowly trusted loopback proxy range.
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';

  const now = Date.now();
  const windowStart = now - WINDOW_MS;

  // Retrieve and prune timestamps outside the current window
  const timestamps = (ipTimestamps.get(ip) ?? []).filter(
    (t) => t > windowStart
  );

  if (timestamps.length >= MAX_REQUESTS) {
    return res.status(429).json({
      error:
        'Too many requests. The demo allows 10 analyses per minute — please wait a moment and try again.',
    });
  }

  timestamps.push(now);
  ipTimestamps.set(ip, timestamps);
  next();
}

// Periodically remove entries where all timestamps have expired,
// so the Map does not grow without bound over a long server lifetime.
setInterval(() => {
  const cutoff = Date.now() - WINDOW_MS;
  for (const [ip, timestamps] of ipTimestamps.entries()) {
    const fresh = timestamps.filter((t) => t > cutoff);
    if (fresh.length === 0) {
      ipTimestamps.delete(ip);
    } else {
      ipTimestamps.set(ip, fresh);
    }
  }
}, WINDOW_MS);

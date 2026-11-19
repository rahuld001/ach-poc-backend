// Lightweight in-process sliding-window rate limiter.
// Keyed by IP address (or a custom key function). Not suitable for multi-process deployments
// where a shared Redis store would be needed; this is sufficient for the POC.

const WINDOW_MS = 60_000; // 1 minute sliding window

/**
 * Returns an Express middleware that limits requests to maxPerMinute per key per minute.
 * @param {object} opts
 * @param {number}   [opts.max]   Requests allowed per minute (default: RATE_LIMIT_PER_MINUTE env or 30)
 * @param {Function} [opts.keyFn] Returns the rate-limit key from req (default: req.ip)
 * @param {string}   [opts.label] Label for error message (e.g. 'payment initiation')
 */
export function rateLimit({ max, keyFn, label } = {}) {
  const maxPerMinute = max ?? Number(process.env.RATE_LIMIT_PER_MINUTE ?? 30);
  const getKey = keyFn ?? ((req) => req.ip ?? 'unknown');
  const store = new Map(); // key → timestamps[]

  return (req, res, next) => {
    const key = getKey(req);
    const now = Date.now();
    // Prune timestamps outside the window
    const timestamps = (store.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
    if (timestamps.length >= maxPerMinute) {
      return res.status(429).json({
        error: `Too many requests${label ? ` for ${label}` : ''}. Please wait a moment and try again.`,
        retry_after_seconds: Math.ceil(WINDOW_MS / 1000),
      });
    }
    timestamps.push(now);
    store.set(key, timestamps);
    next();
  };
}

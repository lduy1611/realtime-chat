'use strict';

/**
 * Sliding-window rate limiter: allows at most `limit` events per `windowMs`.
 */
class RateLimiter {
  constructor({ limit = 5, windowMs = 1000 } = {}) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.hits = [];
  }

  /** Records an attempt and returns true if it is allowed. */
  allow(now = Date.now()) {
    const cutoff = now - this.windowMs;
    while (this.hits.length && this.hits[0] <= cutoff) this.hits.shift();
    if (this.hits.length >= this.limit) return false;
    this.hits.push(now);
    return true;
  }
}

module.exports = { RateLimiter };

/**
 * Token-bucket rate limiter (TECHNICAL-SPEC §5). In-memory, single-node; sits behind this
 * interface so a Redis-backed bucket can replace it for multi-node (NFR-6) without touching
 * call sites. `now` is injectable for deterministic tests.
 */
export interface RateLimiter {
  /** Returns true if allowed; false if the bucket is empty. */
  take(key: string, ratePerMin: number, burst: number, cost?: number): boolean;
}

type Bucket = { tokens: number; updatedAt: number };

export class TokenBucketLimiter implements RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  take(key: string, ratePerMin: number, burst: number, cost = 1): boolean {
    const capacity = burst > 0 ? burst : ratePerMin;
    const refillPerMs = ratePerMin / 60_000;
    const t = this.now();
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: capacity, updatedAt: t };
      this.buckets.set(key, bucket);
    }
    const elapsed = Math.max(0, t - bucket.updatedAt);
    bucket.tokens = Math.min(capacity, bucket.tokens + elapsed * refillPerMs);
    bucket.updatedAt = t;
    if (bucket.tokens < cost) return false;
    bucket.tokens -= cost;
    return true;
  }
}

/**
 * Tracks failed-attempt counts for lockout (pairing brute-force, §5: 20 failed attempts/hour
 * per IP → 1h lockout). Sliding 1h window.
 */
export class FailureCounter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly windowMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  record(key: string): void {
    const arr = this.hits.get(key) ?? [];
    arr.push(this.now());
    this.hits.set(key, arr);
  }

  count(key: string): number {
    const cutoff = this.now() - this.windowMs;
    const arr = (this.hits.get(key) ?? []).filter((t) => t >= cutoff);
    this.hits.set(key, arr);
    return arr.length;
  }
}

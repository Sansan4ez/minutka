export class TokenBucketRateLimiter {
  private readonly buckets = new Map<string, { tokens: number; updatedAt: number }>();
  private readonly idleBucketLifetimeMs: number;
  constructor(private readonly capacity: number, private readonly refillPerMinute: number) {
    this.idleBucketLifetimeMs = (capacity / refillPerMinute) * 60_000;
  }
  allow(key: string, now = Date.now()): boolean {
    this.prune(now);
    const previous = this.buckets.get(key) ?? { tokens: this.capacity, updatedAt: now };
    const tokens = Math.min(this.capacity, previous.tokens + ((now - previous.updatedAt) / 60_000) * this.refillPerMinute);
    if (tokens < 1) { this.buckets.set(key, { tokens, updatedAt: now }); return false; }
    this.buckets.set(key, { tokens: tokens - 1, updatedAt: now }); return true;
  }
  private prune(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.updatedAt >= this.idleBucketLifetimeMs) this.buckets.delete(key);
    }
  }
}

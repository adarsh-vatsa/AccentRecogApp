/** Token-bucket rate limiter keyed by arbitrary strings. In-memory; fine for one process. */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; updated: number }>();

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
  ) {}

  /** Would a take of `cost` succeed right now? Doesn't consume anything. */
  peek(key: string, cost = 1): boolean {
    const bucket = this.buckets.get(key);
    if (!bucket) return this.capacity >= cost;
    const elapsed = (Date.now() - bucket.updated) / 1000;
    return Math.min(this.capacity, bucket.tokens + elapsed * this.refillPerSecond) >= cost;
  }

  take(key: string, cost = 1): boolean {
    const now = Date.now();
    const bucket = this.buckets.get(key) ?? { tokens: this.capacity, updated: now };
    const elapsed = (now - bucket.updated) / 1000;
    bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsed * this.refillPerSecond);
    bucket.updated = now;
    if (bucket.tokens < cost) {
      this.buckets.set(key, bucket);
      return false;
    }
    bucket.tokens -= cost;
    this.buckets.set(key, bucket);
    if (this.buckets.size > 50_000) this.sweep(now);
    return true;
  }

  private sweep(now: number): void {
    const fullAfterMs = (this.capacity / this.refillPerSecond) * 1000;
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.updated > fullAfterMs) this.buckets.delete(key);
    }
  }
}

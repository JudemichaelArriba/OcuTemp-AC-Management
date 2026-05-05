export class RateLimiter {
  private readonly storageKey: string;
  private readonly maxRequests: number;
  private readonly windowMs: number;

  constructor(key: string, maxRequests: number, windowMs: number) {
    this.storageKey = `__rl_${key}`;
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
  }

  private getTimestamps(): number[] {
    try {
      const raw = localStorage.getItem(this.storageKey);
      return raw ? (JSON.parse(raw) as number[]) : [];
    } catch {
      return [];
    }
  }

  private persist(timestamps: number[]): void {
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(timestamps));
    } catch {}
  }

  private pruned(): number[] {
    const now = Date.now();
    return this.getTimestamps().filter(t => now - t < this.windowMs);
  }

  isBlocked(): boolean {
    return this.pruned().length >= this.maxRequests;
  }

  remainingMs(): number {
    const active = this.pruned();
    if (active.length < this.maxRequests) return 0;
    const oldest = Math.min(...active);
    return this.windowMs - (Date.now() - oldest);
  }

  record(): void {
    const active = this.pruned();
    active.push(Date.now());
    this.persist(active);
  }

  reset(): void {
    try {
      localStorage.removeItem(this.storageKey);
    } catch {}
  }
}
/** Route-wide pacing shared by every connected account in this bot process. */
export interface ThrottleClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}
const systemClock: ThrottleClock = { now: Date.now, sleep: ms => new Promise(resolve => setTimeout(resolve, ms)) };
export const inventoryRoute = '/v2/users/{id}/tradableItems';
export function robloxRoute(path: string): string { return path.split('?')[0]!.replace(/\/users\/\d+\//, '/users/{id}/'); }
/** Retry-After may be seconds or an HTTP date. Missing/invalid headers use a conservative five-second pause. */
export function retryDelay(header: string | null, now = Date.now()): number {
  if (header !== null && header.trim() !== '') {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.max(1000, Math.ceil(seconds * 1000));
    const date = Date.parse(header);
    if (Number.isFinite(date)) return Math.max(1000, date - now);
  }
  return 5000;
}
export class RobloxThrottle {
  private tails = new Map<string, Promise<unknown>>();
  private nextAt = new Map<string, number>();
  private blockedUntil = new Map<string, number>();
  constructor(private clock: ThrottleClock = systemClock) {}
  now(): number { return this.clock.now(); }
  pause(route: string, ms: number): number {
    const until = Math.max(this.blockedUntil.get(route) ?? 0, this.now() + ms);
    this.blockedUntil.set(route, until);
    return until;
  }
  async run<T>(route: string, deadline: number, operation: () => Promise<T>, expired: () => Error): Promise<T> {
    const previous = this.tails.get(route) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(async () => {
      // Recheck after sleeping: another response may extend the server cooldown while this request waits.
      while (true) {
        const now = this.now();
        const delay = Math.max(0, (this.nextAt.get(route) ?? 0) - now, (this.blockedUntil.get(route) ?? 0) - now);
        if (now + delay >= deadline) throw expired();
        if (!delay) break;
        await this.clock.sleep(delay);
      }
      // Roblox's inventory endpoint rejects simultaneous sender/recipient reads with Retry-After: 5.
      this.nextAt.set(route, this.now() + (route === inventoryRoute ? 5500 : 350));
      return operation();
    });
    this.tails.set(route, task);
    try { return await task; }
    finally { if (this.tails.get(route) === task) this.tails.delete(route); }
  }
}

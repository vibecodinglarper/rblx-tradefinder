import { UserError, type UserProfile } from './domain.js';
import { recommendationKey, type Recommendation } from './engine.js';
import type { SearchService } from './search.js';
import type { Store } from './store.js';

type Sender = (discordId: string, recommendation: Recommendation) => Promise<void>;
const signature = (u: UserProfile) => JSON.stringify([u.robloxId, u.alerts, u.preferences]);
export class Monitor {
  private running: Promise<void> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  lastCompletedAt: number | null = null;
  constructor(private store: Store, private search: SearchService, private send: Sender, private intervalMs = 180_000) {}
  start(): void {
    this.stopped = false;
    const loop = async () => {
      try { await this.tick(); }
      catch (error) { console.error('Monitor failed:', error instanceof Error ? error.name : 'Unknown error'); }
      if (!this.stopped) this.timer = setTimeout(() => { void loop(); }, this.intervalMs);
    };
    void loop();
  }
  async stop(): Promise<void> { this.stopped = true; clearTimeout(this.timer); await this.running; }
  tick(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.scan().finally(() => { this.running = undefined; });
    return this.running;
  }
  private unchanged(user: UserProfile): UserProfile | undefined {
    const current = this.store.get(user.discordId);
    return current && signature(current) === signature(user) ? current : undefined;
  }
  private async scan(): Promise<void> {
    this.store.prune();
    for (const user of this.store.subscribers()) {
      if (this.stopped) break;
      try {
        const result = await this.search.search(user);
        let sent = 0;
        let deliveryFailed = false;
        for (const r of result.recommendations) {
          if (sent >= 2 || this.stopped || !this.unchanged(user)) break;
          const key = recommendationKey(r);
          if (this.store.seen(user.discordId, key)) continue;
          try { await this.send(user.discordId, r); }
          catch (error) {
            deliveryFailed = true;
            const current = this.unchanged(user);
            if (current) {
              const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
              // Discord 50007 = DMs blocked. Transient send errors preserve opt-in.
              current.alerts = code === 50007 ? false : current.alerts;
              current.alertError = code === 50007 ? 'DMs are blocked. Allow DMs and re-enable alerts.' : 'Discord delivery failed; will retry next scan.';
              this.store.save(current);
            }
            break;
          }
          if (this.unchanged(user)) this.store.markSent(user.discordId, key);
          sent++;
        }
        const current = this.unchanged(user);
        if (current && !deliveryFailed) {
          current.alertError = result.skippedSellers ? `${result.skippedSellers} seller inventories were unavailable in the last scan.` : null;
          this.store.save(current);
        }
      } catch (error) {
        const current = this.unchanged(user);
        if (current) { current.alertError = error instanceof UserError ? error.message.slice(0, 500) : 'Search failed; will retry next scan.'; this.store.save(current); }
      }
    }
    this.lastCompletedAt = Date.now();
  }
}

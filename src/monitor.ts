import { alertHourlyCap, UserError, type UserProfile } from './domain.js';
import { alertKey, type Recommendation } from './engine.js';
import { diffInventory, type InventoryChange } from './changes.js';
import type { SearchService } from './search.js';
import type { Store } from './store.js';

type Sender = (discordId: string, recommendation: Recommendation) => Promise<void>;
export type ChangeSender = (user: UserProfile, change: InventoryChange, checkedAt: number) => Promise<void>;
const signature = (u: UserProfile) => JSON.stringify([u.robloxId, u.alerts, u.inventoryAlerts, u.preferences]);
/** Discord 50007 = DMs blocked. */
const dmsBlocked = (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && error.code === 50007);
/**
 * How many alerts one scan sends is the user's own `alertsPerScan` (the alerts panel sets it); still one per seller per
 * scan, so a single trader cannot fill the batch. The hourly ceiling scales with that setting as a safety net.
 */
const PER_SELLER = 1;
export class Monitor {
  private running: Promise<void> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  lastCompletedAt: number | null = null;
  constructor(private store: Store, private search: SearchService, private send: Sender, private intervalMs = 180_000, private sendChange?: ChangeSender) {}
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
    await this.scanInventories();
    for (const user of this.store.subscribers()) {
      if (this.stopped) break;
      try {
        const result = await this.search.search(user);
        let sent = 0;
        let deliveryFailed = false;
        const perScan = user.preferences.alertsPerScan;
        const budget = Math.min(perScan, alertHourlyCap(perScan) - this.store.sentCount(user.discordId, 3_600_000));
        const sellers = new Map<number, number>();
        // Downgrades are the harder shape to find and the one people ask for, so each batch leads with them and then
        // alternates, rather than letting a run of upgrades use up the whole budget.
        const downs = result.recommendations.filter(r => r.mode === 'downgrade');
        const others = result.recommendations.filter(r => r.mode !== 'downgrade');
        const batch: Recommendation[] = [];
        for (let n = 0; n < Math.max(downs.length, others.length); n++) {
          if (downs[n]) batch.push(downs[n]!);
          if (others[n]) batch.push(others[n]!);
        }
        for (const r of batch) {
          if (sent >= budget || this.stopped || !this.unchanged(user)) break;
          // Same seller, same thing received (whatever you give for it) is one alert, and one per seller per scan.
          if ((sellers.get(r.ad.userId) ?? 0) >= PER_SELLER) continue;
          const key = alertKey(r);
          if (this.store.seen(user.discordId, key)) continue;
          try { await this.send(user.discordId, r); }
          catch (error) {
            deliveryFailed = true;
            const current = this.unchanged(user);
            if (current) {
              // Transient send errors preserve opt-in.
              const blocked = dmsBlocked(error);
              current.alerts = blocked ? false : current.alerts;
              current.alertError = blocked ? 'DMs are blocked. Allow DMs and re-enable alerts.' : 'Discord delivery failed; will retry next scan.';
              this.store.save(current);
            }
            break;
          }
          if (this.unchanged(user)) this.store.markSent(user.discordId, key);
          sellers.set(r.ad.userId, (sellers.get(r.ad.userId) ?? 0) + 1);
          sent++;
        }
        const current = this.unchanged(user);
        if (current && !deliveryFailed) {
          current.alertError = null;
          this.store.save(current);
        }
      } catch (error) {
        const current = this.unchanged(user);
        if (current) { current.alertError = error instanceof UserError ? error.message.slice(0, 500) : 'Search failed; will retry next scan.'; this.store.save(current); }
      }
    }
    this.lastCompletedAt = Date.now();
  }
  /**
   * Compares each watcher's public inventory with the last snapshot and DMs a recap of any copies that left or arrived.
   * The snapshot only advances once the DM is delivered, so a failed send is retried with the same diff next scan.
   */
  private async scanInventories(): Promise<void> {
    for (const user of this.store.inventoryWatchers()) {
      if (this.stopped) break;
      try {
        const [inventory, items] = await Promise.all([this.search.provider.inventory(user.robloxId), this.search.provider.items()]);
        const previous = this.store.snapshot(user.discordId);
        if (!this.unchanged(user)) continue;
        if (!previous) { this.store.saveSnapshot(user.discordId, inventory.holdings, inventory.fetchedAt); continue; }
        // A suddenly empty inventory is far more likely a privacy change or API hiccup than everything selling at once.
        if (!inventory.holdings.length && previous.holdings.length) { this.note(user, 'Your inventory came back empty (private, or Roblox hiccup); the change check was skipped.'); continue; }
        const change = diffInventory(previous.holdings, inventory.holdings, items.data);
        if (!change) continue;
        if (this.sendChange) await this.sendChange(user, change, inventory.fetchedAt);
        if (this.unchanged(user)) this.store.saveSnapshot(user.discordId, inventory.holdings, inventory.fetchedAt);
      } catch (error) {
        const current = this.unchanged(user);
        if (!current) continue;
        if (dmsBlocked(error)) { current.inventoryAlerts = false; current.alertError = 'DMs are blocked. Allow DMs and re-enable inventory DMs.'; this.store.save(current); }
        else this.note(user, error instanceof UserError ? error.message.slice(0, 500) : 'Inventory check failed; will retry next scan.');
      }
    }
  }
  private note(user: UserProfile, text: string): void {
    const current = this.unchanged(user);
    if (current) { current.alertError = text; this.store.save(current); }
  }
}

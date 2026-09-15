import { gunzipSync, gzipSync } from 'node:zlib';
import type { TradeAd } from './domain.js';
import type { AdArchive, ArchiveStats } from './search.js';
import { DEFAULT_ARCHIVE, type ArchivePolicy } from './store.js';

/**
 * A trade-ad archive that keeps its rolling window in memory and mirrors it to a document store in time buckets.
 *
 * The feed brings roughly 100,000 ads a day, so one document per ad would burn through a Firestore free tier before
 * lunch. Instead every ad is filed under the five-minute slice its creation time falls in, and each slice is one
 * document holding its ads gzip-compressed: about 300 documents for a full day, a handful of writes a minute, and a
 * few hundred deletes a day as the window rolls forward. Searches read memory, so nothing about them waits on the
 * network; the store exists so a restart, a redeploy or a move to another host starts with the last 24 hours intact.
 */
export const BUCKET_MS = 300_000;
/** One bucket document: every ad created inside one slice, compressed, with the numbers the console shows. */
export interface BucketDoc { start: number; count: number; updatedAt: number; gz: Buffer }
/** The few operations the archive needs from its store, so tests can supply an in-memory double. */
export interface BucketStore {
  /** Every bucket whose start is at or after `sinceStart`. */
  list(sinceStart: number): Promise<{ id: string; doc: BucketDoc }[]>;
  put(id: string, doc: BucketDoc): Promise<void>;
  remove(ids: string[]): Promise<void>;
}
export const bucketId = (start: number): string => String(start).padStart(15, '0');
const bucketOf = (createdAt: number): number => createdAt - (createdAt % BUCKET_MS);
export const encodeBucket = (ads: TradeAd[]): Buffer => gzipSync(JSON.stringify(ads));
export const decodeBucket = (gz: Buffer | Uint8Array): TradeAd[] => JSON.parse(gunzipSync(Buffer.from(gz)).toString('utf8')) as TradeAd[];

export class BucketedArchive implements AdArchive {
  private ads = new Map<number, TradeAd>();
  /** Buckets whose document no longer matches memory; rewritten (or removed, once empty) on the next flush. */
  private dirty = new Set<number>();
  /** Compressed size of every bucket the store is believed to hold, by bucket start. */
  private stored = new Map<number, number>();
  private queue: Promise<void> = Promise.resolve();
  private archiveMs: number;
  /** The last store failure, or null; the health report and heartbeat surface it. */
  lastError: string | null = null;
  constructor(private store: BucketStore, private policy: ArchivePolicy = DEFAULT_ARCHIVE) { this.archiveMs = policy.hours * 3_600_000; }
  /** Reads every bucket inside the window back into memory. Called once, before the bot goes online. */
  async load(now = Date.now()): Promise<number> {
    const cutoff = now - this.archiveMs;
    const buckets = await this.store.list(bucketOf(cutoff));
    for (const { doc } of buckets) {
      this.stored.set(doc.start, doc.gz.length);
      for (const ad of decodeBucket(doc.gz)) if (ad.createdAt > cutoff) this.ads.set(ad.id, ad);
    }
    this.enforceCap();
    return this.ads.size;
  }
  saveAds(ads: TradeAd[], now = Date.now()): number {
    const cutoff = now - this.archiveMs;
    let added = 0;
    for (const ad of ads) {
      if (ad.createdAt <= cutoff || this.ads.has(ad.id)) continue;
      this.ads.set(ad.id, ad); this.dirty.add(bucketOf(ad.createdAt)); added++;
    }
    if (added) this.schedule();
    return added;
  }
  recentAds(maxAgeMs: number, now = Date.now()): TradeAd[] {
    const cutoff = now - Math.min(maxAgeMs, this.archiveMs);
    return [...this.ads.values()].filter(ad => ad.createdAt > cutoff).sort((a, b) => b.createdAt - a.createdAt);
  }
  adCount(): number { return this.ads.size; }
  adCoverage(now = Date.now()): { count: number; minutes: number } {
    let oldest = Infinity;
    for (const ad of this.ads.values()) if (ad.createdAt < oldest) oldest = ad.createdAt;
    return { count: this.ads.size, minutes: Number.isFinite(oldest) ? Math.round((now - oldest) / 60_000) : 0 };
  }
  stats(now = Date.now()): Required<ArchiveStats> {
    const { count, minutes } = this.adCoverage(now);
    let bytes = 0;
    for (const size of this.stored.values()) bytes += size;
    return { count, minutes, perHour: minutes ? Math.round(count / (minutes / 60)) : 0, bytes,
      retentionHours: this.policy.hours, maxAds: this.policy.maxAds, storage: 'firestore' };
  }
  /** Rolls the window forward: ads past retention go, the newest `maxAds` survive, and emptied buckets are removed. */
  prune(now = Date.now()): void {
    const cutoff = now - this.archiveMs;
    for (const [id, ad] of this.ads) if (ad.createdAt <= cutoff) { this.ads.delete(id); this.dirty.add(bucketOf(ad.createdAt)); }
    this.enforceCap();
    // Buckets that ended before the cutoff cannot hold a live ad any more, whether or not memory ever saw them.
    for (const start of this.stored.keys()) if (start + BUCKET_MS <= cutoff) this.dirty.add(start);
    if (this.dirty.size) this.schedule();
  }
  private enforceCap(): void {
    const excess = this.ads.size - this.policy.maxAds;
    if (excess <= 0) return;
    const oldest = [...this.ads.values()].sort((a, b) => a.createdAt - b.createdAt).slice(0, excess);
    for (const ad of oldest) { this.ads.delete(ad.id); this.dirty.add(bucketOf(ad.createdAt)); }
  }
  private schedule(): void { this.queue = this.queue.then(() => this.flush()); }
  /** Writes every dirty bucket, one document each; a failure keeps the bucket dirty so the next beat retries it. */
  async flush(now = Date.now()): Promise<void> {
    if (!this.dirty.size) return;
    const pending = [...this.dirty]; this.dirty.clear();
    const grouped = new Map<number, TradeAd[]>();
    for (const start of pending) grouped.set(start, []);
    for (const ad of this.ads.values()) grouped.get(bucketOf(ad.createdAt))?.push(ad);
    const removals: number[] = [];
    for (const [start, ads] of grouped) {
      if (!ads.length) { removals.push(start); continue; }
      try {
        const gz = encodeBucket(ads.sort((a, b) => a.createdAt - b.createdAt));
        await this.store.put(bucketId(start), { start, count: ads.length, updatedAt: now, gz });
        this.stored.set(start, gz.length); this.lastError = null;
      } catch (error) { this.dirty.add(start); this.report(error); }
    }
    if (removals.length) {
      try { await this.store.remove(removals.map(bucketId)); for (const start of removals) this.stored.delete(start); this.lastError = null; }
      catch (error) { for (const start of removals) this.dirty.add(start); this.report(error); }
    }
  }
  /** Waits for every queued write; used at shutdown so the last poll is not lost. */
  async settle(): Promise<void> { await this.queue; }
  private report(error: unknown): void {
    this.lastError = error instanceof Error ? error.message : 'Unknown error';
    console.error('Firestore archive write failed; will retry:', this.lastError);
  }
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUCKET_MS, BucketedArchive, bucketId, decodeBucket, type BucketDoc, type BucketStore } from '../src/archive.js';
import type { TradeAd } from '../src/domain.js';

/** An in-memory stand-in for the Firestore collection, counting operations the way a bill would. */
class FakeStore implements BucketStore {
  docs = new Map<string, BucketDoc>();
  writes = 0; deletes = 0; failNext = false;
  async list(sinceStart: number) { return [...this.docs].filter(([, d]) => d.start >= sinceStart).map(([id, doc]) => ({ id, doc })); }
  async put(id: string, doc: BucketDoc) { if (this.failNext) { this.failNext = false; throw new Error('unavailable'); } this.docs.set(id, doc); this.writes++; }
  async remove(ids: string[]) { for (const id of ids) { this.docs.delete(id); this.deletes++; } }
  ads(): TradeAd[] { return [...this.docs.values()].flatMap(d => decodeBucket(d.gz)); }
}
const HOUR = 3_600_000;
// A multiple of BUCKET_MS, so the minutes-before-now arithmetic below lands in the buckets it says it does.
const T0 = 1_789_000_200_000;
const ad = (id: number, createdAt: number): TradeAd => ({ id, createdAt, userId: 1, username: 'u', offering: [1], requesting: [2], tags: [], offeringRobux: 0, requestingRobux: 0 });

test('ads are filed into five-minute buckets, one document each, and read back after a restart', async () => {
  const store = new FakeStore();
  const archive = new BucketedArchive(store, { hours: 24, maxAds: 100_000 });
  const now = T0 + 24 * HOUR;
  // Three polls: ads across two buckets, then a repeat of the same ads, then one more in the second bucket.
  assert.equal(archive.saveAds([ad(1, now - 6 * 60_000), ad(2, now - 4 * 60_000), ad(3, now - 3 * 60_000)], now), 3);
  await archive.settle();
  assert.equal(store.writes, 2, 'one document per bucket');
  assert.equal(archive.saveAds([ad(2, now - 4 * 60_000), ad(3, now - 3 * 60_000)], now), 0, 'reposts are not archived twice');
  assert.equal(archive.saveAds([ad(4, now - 2 * 60_000)], now), 1);
  await archive.settle();
  assert.equal(store.docs.size, 2, 'two buckets touched');
  assert.equal(store.writes, 3, 'the second poll changed nothing, the third rewrote one bucket');
  for (const [id, doc] of store.docs) { assert.equal(id, bucketId(doc.start)); assert.equal(doc.start % BUCKET_MS, 0); assert.ok(doc.gz.length > 0); }
  assert.deepEqual(store.ads().map(a => a.id).sort(), [1, 2, 3, 4]);
  assert.deepEqual(archive.recentAds(5 * 60_000, now).map(a => a.id), [4, 3, 2], 'newest first, inside the age filter');
  assert.equal(archive.stats(now).storage, 'firestore');
  // A fresh process reads the same window back.
  const again = new BucketedArchive(store, { hours: 24, maxAds: 100_000 });
  assert.equal(await again.load(now), 4);
  assert.deepEqual(again.adCoverage(now), { count: 4, minutes: 6 });
  assert.ok(again.stats(now).bytes > 0, 'size reflects what the store holds');
});

test('the window rolls forward: expired ads and emptied buckets are removed, the cap keeps only the newest', async () => {
  const store = new FakeStore();
  const archive = new BucketedArchive(store, { hours: 24, maxAds: 5 });
  const start = T0;
  archive.saveAds([ad(1, start + 1000), ad(2, start + 2000)], start + 3000);
  await archive.settle();
  assert.equal(store.docs.size, 1);
  // A day later the first bucket has expired; new arrivals go on, and the oldest bucket document disappears.
  const later = start + 24 * HOUR + 10_000;
  archive.saveAds([ad(3, later - 1000)], later);
  archive.prune(later);
  await archive.settle();
  assert.deepEqual(store.ads().map(a => a.id), [3]);
  assert.equal(store.deletes, 1, 'the expired bucket was deleted, not rewritten');
  assert.equal(archive.adCount(), 1);
  assert.equal(archive.saveAds([ad(9, later - 30 * HOUR)], later), 0, 'an ad already outside the window is never stored');
  // Past the cap, each arrival displaces the oldest.
  archive.saveAds([ad(4, later + 1), ad(5, later + 2), ad(6, later + 3), ad(7, later + 4), ad(8, later + 5)], later + 6);
  archive.prune(later + 6);
  await archive.settle();
  assert.deepEqual(archive.recentAds(HOUR, later + 6).map(a => a.id), [8, 7, 6, 5, 4]);
  assert.deepEqual(store.ads().map(a => a.id).sort(), [4, 5, 6, 7, 8], 'the store mirrors memory');
  // Loading more than the cap from the store keeps only the newest.
  const capped = new BucketedArchive(store, { hours: 24, maxAds: 2 });
  await capped.load(later + 6);
  assert.deepEqual(capped.recentAds(HOUR, later + 6).map(a => a.id), [8, 7]);
});

test('a store outage keeps the bucket dirty and retries it on the next flush without losing ads', async () => {
  const store = new FakeStore();
  const archive = new BucketedArchive(store, { hours: 24, maxAds: 100 });
  store.failNext = true;
  archive.saveAds([ad(1, T0)], T0 + 1000);
  await archive.settle();
  assert.equal(store.docs.size, 0);
  assert.equal(archive.lastError, 'unavailable');
  assert.equal(archive.recentAds(HOUR, T0 + 1000).length, 1, 'searches still see the ad');
  archive.saveAds([ad(2, T0 + 500)], T0 + 1000);
  await archive.settle();
  assert.deepEqual(store.ads().map(a => a.id).sort(), [1, 2]);
  assert.equal(archive.lastError, null);
});

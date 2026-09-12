import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UserError } from '../src/domain.js';
import { SearchService } from '../src/search.js';
import { recommendationKey } from '../src/engine.js';
import { ad, fixtureProvider, inventory, profile } from './fixtures.js';

test('end-to-end search verifies both inventories and deduplicates reposted recommendations', async () => {
  const provider = fixtureProvider(); provider.adList.push(ad({ id: 701 }));
  const result = await new SearchService(provider).search(profile());
  // The ad asks for 10+20, so single-item offers (+120%) are past the realistic band and dropped; only the advertised exchange remains.
  assert.equal(result.recommendations.length, 1); assert.equal(result.recommendations[0]?.match, 'exact');
  assert.deepEqual(provider.calls, [1, 2]);
  assert.equal(result.recommendations[0]?.give[0]?.userAssetId, 100);
  const r = result.recommendations[0]!;
  assert.equal(recommendationKey(r), recommendationKey({ ...r, ad: ad({ id: 999 }) }));
});
test('private seller inventory is skipped and never presented as verified', async () => {
  const provider = fixtureProvider(), original = provider.inventory.bind(provider);
  provider.inventory = async id => { if (id === 2) throw new UserError('Inventory private'); return original(id); };
  const r = await new SearchService(provider).search(profile());
  assert.equal(r.recommendations.length, 0); assert.equal(r.skippedSellers, 1); assert.match(r.notes[0]!, /private/);
});
test('stale ads, self ads, Robux ads and held seller items never become recommendations', async () => {
  for (const override of [{ createdAt: Date.now() - 3_600_001 }, { userId: 1 }, { requestingRobux: 1 }, { createdAt: Date.now() + 120_000 }]) {
    const provider = fixtureProvider(); provider.adList = [ad(override)];
    assert.equal((await new SearchService(provider).search(profile())).recommendations.length, 0);
  }
  const provider = fixtureProvider(); provider.inventories.get(2)!.holdings[0]!.onHold = true;
  assert.equal((await new SearchService(provider).search(profile())).recommendations.length, 0);
});
test('finds target items from multiple sellers and enforces seller request cap', async () => {
  const provider = fixtureProvider(); provider.adList.push(ad({ id: 702, userId: 3 })); provider.inventories.set(3, inventory(3, [30]));
  const user = profile(); user.preferences.targetIds = [30]; user.preferences.mode = 'upgrade';
  assert.equal((await new SearchService(provider).search(user)).recommendations.length, 2);
  const capped = await new SearchService(provider, 1).search(user);
  assert.equal(capped.sellersChecked, 1); assert.equal(capped.candidateSellers, 2);
});
test('refuses snapshots that became stale during a scan', async () => {
  const provider = fixtureProvider(); provider.inventories.get(1)!.fetchedAt = Date.now() - 300_001;
  await assert.rejects(new SearchService(provider).search(profile()), /stale/);
});
test('serializes a user search and releases the lock after errors', async () => {
  const provider = fixtureProvider(); let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }); const original = provider.items.bind(provider);
  provider.items = async () => { await gate; return original(); };
  const service = new SearchService(provider), first = service.search(profile());
  await assert.rejects(service.search(profile()), /already running/);
  release(); await first; await service.search(profile());
});

test('searches screen archived ads beyond the live feed, deduplicate by ID, and report how far back they reached', async () => {
  const { Store } = await import('../src/store.js');
  const store = new Store(':memory:');
  const provider = fixtureProvider();
  // The live feed only has the current ad; a 20-minute-old ad from the same seller lives only in the archive.
  const old = ad({ id: 650, createdAt: Date.now() - 20 * 60_000, offering: [30], requesting: [10] });
  assert.equal(store.saveAds([old, old]), 1);
  const service = new SearchService(provider, 12, store);
  const result = await service.search(profile());
  assert.equal(result.adsScanned, 2); assert.ok(result.coverageMinutes >= 20);
  assert.equal(store.recentAds(3_600_000).length, 2, 'the live ad was archived by the search');
  // Ads outside the user's max ad age are ignored, and the archive is pruned after 24 hours.
  const user = profile(); user.preferences.maxAdAgeMinutes = 5;
  assert.equal((await new SearchService(provider, 12, store).search(user)).adsScanned, 1);
  store.saveAds([ad({ id: 1, createdAt: Date.now() - 25 * 3_600_000 })]); store.prune();
  assert.equal(store.adCount(), 2);
  const coverage = service.coverage()!; assert.equal(coverage.count, 2); assert.ok(coverage.minutes >= 20 && coverage.minutes <= 21);
  assert.equal(new SearchService(provider).coverage(), undefined);
  store.close();
});

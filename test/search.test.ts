import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UserError } from '../src/domain.js';
import { SearchService } from '../src/search.js';
import { recommendationKey } from '../src/engine.js';
import { ad, fixtureProvider, inventory, profile } from './fixtures.js';

test('end-to-end search verifies both inventories and deduplicates reposted recommendations', async () => {
  const provider = fixtureProvider(); provider.adList.push(ad({ id: 701 }));
  const result = await new SearchService(provider).search(profile());
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

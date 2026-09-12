import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { alertHourlyCap, UserError } from '../src/domain.js';
import { Monitor } from '../src/monitor.js';
import { SearchService } from '../src/search.js';
import { ad, fixtureProvider, inventory, item, profile } from './fixtures.js';

test('trade DMs recheck both inventories without cached reads and suppress copies lost after discovery', async () => {
  for (const owner of [1, 2]) for (const condition of ['missing', 'held', 'non-tradable', 'unknown', 'failure']) {
    const store = new Store(':memory:'), user = profile(); user.alerts = true; store.save(user);
    const provider = fixtureProvider(), original = provider.inventory.bind(provider);
    let invalidate = true, sends = 0;
    const refreshed: number[] = [];
    provider.inventory = async (id, age, viewer) => {
      const inv = await original(id);
      if (age !== 0) return inv;
      assert.equal(viewer?.discordId, user.discordId);
      refreshed.push(id);
      if (!invalidate || id !== owner) return { ...inv, fetchedAt: Date.now() };
      if (condition === 'failure') throw new UserError('Verification unavailable.');
      return { ...inv, fetchedAt: Date.now(), holdings: condition === 'missing' ? [] : inv.holdings.map(c => ({ ...c,
        onHold: condition === 'held', tradable: condition === 'non-tradable' ? false : condition === 'unknown' ? undefined : true })) };
    };
    const monitor = new Monitor(store, new SearchService(provider), async (_id, r) => {
      sends++;
      assert.ok([...r.give, ...r.receive].every(c => c.tradable === true && !c.onHold));
    });
    try {
      await monitor.tick();
      assert.equal(sends, 0, `${owner}: ${condition}`);
      assert.deepEqual(refreshed.sort(), [1, 2]);
      assert.equal(store.sentCount(user.discordId, 3_600_000), 0, 'suppressed alerts are not marked delivered');
      invalidate = false;
      await monitor.tick();
      assert.equal(sends, 1, 'a later valid trade can still be delivered');
    } finally { await monitor.stop(); store.close(); }
  }
});

test('disabling alerts during the final inventory check prevents the DM', async () => {
  const store = new Store(':memory:'), user = profile(); user.alerts = true; store.save(user);
  const provider = fixtureProvider(), original = provider.inventory.bind(provider);
  provider.inventory = async (id, age) => {
    if (age === 0) { user.alerts = false; store.save(user); }
    return original(id);
  };
  let sent = false;
  const monitor = new Monitor(store, new SearchService(provider), async () => { sent = true; });
  try { await monitor.tick(); assert.equal(sent, false); }
  finally { await monitor.stop(); store.close(); }
});

test('final DM validation preserves bundle targets and quantities, never replacing one with a classic asset', async () => {
  const provider = fixtureProvider();
  const target = { itemType: 'Bundle' as const, targetId: '163046677043335' };
  provider.inventories.get(1)!.holdings[0]!.itemTarget = target;
  const search = new SearchService(provider), user = profile();
  const recommendation = (await search.search(user)).recommendations[0]!;
  assert.ok(await search.refresh(user, recommendation));
  delete provider.inventories.get(1)!.holdings[0]!.itemTarget;
  assert.equal(await search.refresh(user, recommendation), null);
  provider.inventories.get(1)!.holdings[0]!.itemTarget = target;
  assert.equal(await search.refresh(user, { ...recommendation, give: [recommendation.give[0]!, recommendation.give[0]!] }), null);
});

test('SQLite saves preferences and deduplication across restarts; forget removes both', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tradefinder-'));
  try {
    const path = join(dir, 'test.sqlite'); let store = new Store(path);
    const user = profile(); user.preferences.targetIds = [30]; store.save(user); store.markSent(user.discordId, 'abc'); store.close();
    store = new Store(path); assert.deepEqual(store.get(user.discordId)?.preferences.targetIds, [30]); assert.equal(store.seen(user.discordId, 'abc'), true);
    assert.equal(store.seen(user.discordId, 'abc', Date.now() + 86_400_001), false);
    store.forget(user.discordId); assert.equal(store.get(user.discordId), undefined); assert.equal(store.seen(user.discordId, 'abc'), false); store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('linking same account preserves settings; switching accounts clears targets and alerts', () => {
  const store = new Store(':memory:'); const user = profile(); user.alerts = true; user.preferences.targetIds = [30]; store.save(user);
  assert.equal(store.link(user.discordId, user.robloxId, 'Renamed').alerts, true);
  const changed = store.link(user.discordId, 99, 'Different'); assert.equal(changed.alerts, false); assert.deepEqual(changed.preferences.targetIds, []); store.close();
});
test('monitor requires opt-in, deduplicates recommendations, and persists delivery history', async () => {
  const store = new Store(':memory:'); const user = profile(); store.save(user); let sends = 0;
  const monitor = new Monitor(store, new SearchService(fixtureProvider()), async () => { sends++; });
  await monitor.tick(); assert.equal(sends, 0);
  user.alerts = true; store.save(user);
  await Promise.all([monitor.tick(), monitor.tick()]); await monitor.tick(); assert.equal(sends, 1);
  await monitor.stop(); store.close();
});
test('failed DM is not marked sent, retries transient errors and disables blocked DMs', async () => {
  const store = new Store(':memory:'); const user = profile(); user.alerts = true; store.save(user); let calls = 0;
  const monitor = new Monitor(store, new SearchService(fixtureProvider()), async () => { calls++; if (calls === 1) throw new Error('transient'); });
  await monitor.tick(); assert.equal(store.get(user.discordId)?.alerts, true); assert.match(store.get(user.discordId)?.alertError ?? '', /delivery failed/);
  await monitor.tick(); assert.equal(calls, 2); assert.equal(store.get(user.discordId)?.alertError, null);
  store.forget(user.discordId); store.save(user);
  const blocked = new Monitor(store, new SearchService(fixtureProvider()), async () => { throw Object.assign(new Error('blocked'), { code: 50007 }); });
  await blocked.tick(); assert.equal(store.get(user.discordId)?.alerts, false); assert.match(store.get(user.discordId)?.alertError ?? '', /DMs are blocked/);
  await monitor.stop(); await blocked.stop(); store.close();
});
test('disabling alerts, changing preferences or forgetting during a search prevents delivery', async () => {
  for (const action of ['disable', 'change', 'forget']) {
    const store = new Store(':memory:'); const user = profile(); user.alerts = true; store.save(user);
    const provider = fixtureProvider(), original = provider.inventory.bind(provider); let sent = false;
    provider.inventory = async id => {
      if (id === 2) {
        if (action === 'forget') store.forget(user.discordId);
        else { const current = store.get(user.discordId)!; if (action === 'disable') current.alerts = false; else current.preferences.targetIds = [999]; store.save(current); }
      }
      return original(id);
    };
    const monitor = new Monitor(store, new SearchService(provider), async () => { sent = true; });
    await monitor.tick(); assert.equal(sent, false);
    if (action === 'forget') assert.equal(store.get(user.discordId), undefined);
    await monitor.stop(); store.close();
  }
});

test('alerts send one per seller per scan, treat a different give-bundle for the same item as the same alert, and stop at the hourly cap', async () => {
  // Seller 2 offers item 30 (110) in one ad and item 40 (48, so giving item 10 is a -4% loss inside the default window) in another.
  const provider = fixtureProvider();
  provider.itemMap.set(40, item(40, 48));
  provider.inventories.set(2, inventory(2, [30, 40]));
  provider.adList = [ad(), ad({ id: 701, offering: [40], requesting: [10] })];
  const store = new Store(':memory:'); const user = profile(); user.alerts = true; store.save(user);
  const sent: number[] = [];
  const monitor = new Monitor(store, new SearchService(provider), async (_id, r) => { sent.push(r.receive[0]!.assetId); });
  await monitor.tick(); assert.equal(sent.length, 1, 'one alert per scan');
  await monitor.tick(); assert.equal(sent.length, 2, 'the other item from the same seller follows next scan'); assert.deepEqual([...new Set(sent)].sort(), [30, 40]);
  await monitor.tick(); assert.equal(sent.length, 2, 'both seller/item pairs are now known for 24 hours');
  // The hourly ceiling scales with the chosen rate (30 an hour per slot, never under 60); at it, nothing more goes out.
  const cap = alertHourlyCap(user.preferences.alertsPerScan);
  assert.equal(cap, 90);
  const busy = new Store(':memory:'); busy.save(user);
  for (let i = 0; i < cap; i++) busy.markSent(user.discordId, `earlier-${i}`);
  let overflow = 0;
  const capped = new Monitor(busy, new SearchService(provider), async () => { overflow++; });
  await capped.tick(); assert.equal(overflow, 0, 'the hourly ceiling holds everything back');
  assert.equal(busy.sentCount(user.discordId, 3_600_000), cap);
  assert.equal(busy.sentCount(user.discordId, 3_600_000, Date.now() + 3_600_001), 0);
  await monitor.stop(); await capped.stop(); store.close(); busy.close();
});

test('the per-check DM rate decides how many sellers one scan alerts about', async () => {
  // Two sellers, each offering one item the user can trade for; the rate is the only thing limiting the batch.
  const build = () => {
    const provider = fixtureProvider();
    provider.itemMap.set(40, item(40, 48));
    provider.inventories.set(3, inventory(3, [40]));
    provider.adList = [ad(), ad({ id: 701, userId: 3, username: 'OtherSeller', offering: [40], requesting: [10] })];
    return provider;
  };
  const user = profile(); user.alerts = true;
  assert.equal(user.preferences.alertsPerScan, 3, 'the default sends a batch, not a trickle');
  const store = new Store(':memory:'); store.save(user);
  const sent: number[] = [];
  const monitor = new Monitor(store, new SearchService(build()), async (_id, r) => { sent.push(r.ad.userId); });
  await monitor.tick(); assert.deepEqual(sent.sort(), [2, 3], 'both sellers in one scan');
  // Turned down to one, the same scan sends a single DM and leaves the rest for later checks.
  const slow = new Store(':memory:'); const quiet = profile(); quiet.alerts = true; quiet.preferences.alertsPerScan = 1; slow.save(quiet);
  const trickle: number[] = [];
  const paced = new Monitor(slow, new SearchService(build()), async (_id, r) => { trickle.push(r.ad.userId); });
  await paced.tick(); assert.equal(trickle.length, 1);
  await paced.tick(); assert.equal(trickle.length, 2); assert.deepEqual([...trickle].sort(), [2, 3]);
  await monitor.stop(); await paced.stop(); store.close(); slow.close();
});

test('alert batches lead with downgrades, and only send trades that are actually worth sending', async () => {
  const provider = fixtureProvider();
  // The user holds a 110 item plus two 50s. One seller splits the 110 into two 60s (+9% downgrade); another
  // consolidates the two 50s into a 90 (a 10% overpay, the upgrade). A third offers a lone 55, which is a 1-for-1
  // nobody asked for and an absurd overpay any other way, so it is worth nothing to either side.
  provider.inventories.set(1, inventory(1, [30, 10, 20]));
  for (const [id, value] of [[60, 60], [61, 60], [70, 90], [80, 55]] as const) provider.itemMap.set(id, item(id, value));
  provider.inventories.set(2, inventory(2, [60, 61]));
  provider.inventories.set(3, inventory(3, [70]));
  provider.inventories.set(4, inventory(4, [80]));
  provider.adList = [
    ad({ id: 900, userId: 2, offering: [60, 61], requesting: [] }),
    ad({ id: 901, userId: 3, offering: [70], requesting: [] }),
    ad({ id: 902, userId: 4, offering: [80], requesting: [] }),
  ];
  const store = new Store(':memory:'); const user = profile(); user.alerts = true; store.save(user);
  const sent: string[] = [];
  const monitor = new Monitor(store, new SearchService(provider), async (_id, r) => { sent.push(`${r.give.length}v${r.receive.length} ${r.mode}`); });
  await monitor.tick();
  assert.deepEqual(sent, ['1v2 downgrade', '2v1 upgrade'], 'the downgrade leads the batch and the pointless offer never appears');
  await monitor.stop(); store.close();
});

test('the ad archive is a rolling window: past the retention span or the row cap, the oldest go first', () => {
  const store = new Store(':memory:', { hours: 2, maxAds: 5 });
  const now = Date.now();
  const at = (id: number, minutesAgo: number) => ({ ...ad({ id }), createdAt: now - minutesAgo * 60_000 });
  store.saveAds([at(1, 200), at(2, 190), ...Array.from({ length: 8 }, (_, i) => at(10 + i, i))]);
  assert.equal(store.adCount(), 10);
  store.prune(now);
  // The two beyond the two-hour window are gone, and the cap keeps only the five newest of what is left.
  assert.equal(store.adCount(), 5);
  const kept = store.recentAds(2 * 3_600_000, now).map(a => a.id).sort((x, y) => x - y);
  assert.deepEqual(kept, [10, 11, 12, 13, 14], 'the newest survive and the oldest are displaced');
  // A search never reaches past the retention window, whatever age filter it asks for.
  assert.equal(store.recentAds(48 * 3_600_000, now).length, 5);
  const stats = store.stats(now);
  assert.equal(stats.count, 5); assert.equal(stats.maxAds, 5); assert.equal(stats.retentionHours, 2);
  assert.ok(stats.bytes > 0, 'the panels report the size the archive takes on disk');
  store.close();
});

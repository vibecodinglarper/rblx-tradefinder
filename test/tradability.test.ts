import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpClient } from '../src/http.js';
import { Providers, parseBundleAssets } from '../src/providers.js';
import { reconcileInventory } from '../src/tradability.js';
import { groupInventory } from '../src/inventory.js';
import { priced, evaluate } from '../src/engine.js';
import { SearchService } from '../src/search.js';
import { inventoryMessage } from '../src/presentation.js';
import { UserError, defaults } from '../src/domain.js';
import type { TradableCopy } from '../src/trading.js';
import { inventory, item, profile, fixtureProvider } from './fixtures.js';

const rose = 835095880, bundle = 163046677043335;
const prices = new Map([[rose, item(rose, 4120, { name: 'Rose Amazeface' })], [10, item(10, 50)]]);
const verifiedCopy = (id: number, instance: string, held = false, type: 'Asset' | 'Bundle' = 'Asset'): TradableCopy => ({
  itemTarget: { itemType: type, targetId: String(id) }, collectibleItemInstanceId: instance, isOnHold: held,
});
const snapshot = (data: TradableCopy[]) => ({ data, fetchedAt: Date.now() });

test('a retained Rose Amazeface is permanently untradable: kept in the holdings but hidden from the inventory, and cannot enter drafts', () => {
  const inv = reconcileInventory(inventory(1, [rose, 10]), snapshot([verifiedCopy(10, 'hat')]), new Map());
  const entries = groupInventory(inv, prices);
  assert.equal(inv.holdings.length, 2);
  assert.equal(inv.holdings.find(h => h.assetId === rose)?.tradable, false);
  assert.deepEqual(entries.map(e => e.assetId), [10]);
  assert.deepEqual(priced(inv, prices).map(c => c.assetId), [10]);
  const body = inventoryMessage(profile(), { view: 'text', page: 0, pages: 1, entries, copies: 1, total: 1, value: 50, rap: 50 });
  const text = body.embeds![0]!.toJSON().description!;
  assert.doesNotMatch(text, /Rose Amazeface/);
  assert.match(text, /Item 10.*✅ Tradable/);
  const legacy = { ...inv.holdings[0]!, item: prices.get(rose)! };
  const recipient = { ...inventory(2, [20]).holdings[0]!, item: item(20, 4120) };
  assert.equal(evaluate([legacy], [recipient], defaults(), true).passes, false);
});

test('a real migrated bundle is separate from the retained classic face and keeps its pricing ID', () => {
  const inv = reconcileInventory(inventory(1, [rose]), snapshot([verifiedCopy(bundle, 'dynamic-copy', false, 'Bundle')]), new Map([[bundle, rose]]));
  const entries = groupInventory(inv, prices);
  assert.equal(inv.holdings.length, 2);
  assert.equal(entries.length, 1, 'the untradable classic face is not displayed');
  assert.equal(entries[0]!.name, 'Rose Amazeface (Bundle)');
  assert.equal(entries[0]!.tags[0], 'Tradable');
  const eligible = priced(inv, prices);
  assert.equal(eligible.length, 1);
  assert.equal(eligible[0]!.assetId, rose);
  assert.equal(eligible[0]!.userAssetId, 'dynamic-copy');
  assert.deepEqual(eligible[0]!.itemTarget, { itemType: 'Bundle', targetId: String(bundle) });
});

test('copy counts and hold status come from verified instances; stale extra copies remain unavailable', () => {
  const raw = inventory(1, [10, 10, 10]);
  const inv = reconcileInventory(raw, snapshot([verifiedCopy(10, 'free'), verifiedCopy(10, 'held', true)]), new Map());
  assert.equal(priced(inv, prices).length, 1);
  assert.equal(inv.holdings.filter(c => c.tradable === false).length, 2);
  // The held copy is only temporarily untradable, so it stays in view; the stale public row is gone for good and is not shown.
  const entry = groupInventory(inv, prices)[0]!;
  assert.equal(entry.quantity, 2);
  assert.deepEqual(entry.tags, ['1/2 tradable', '1 on hold']);
  assert.ok(raw.holdings.every(c => c.tradable === true && !c.onHold), 'reconciliation must not mutate shared public snapshots');
});

test('an item whose every copy is on hold is shown with a single on-hold tag, never as Not tradable', () => {
  const inv = reconcileInventory(inventory(1, [10]), snapshot([verifiedCopy(10, 'held', true)]), new Map());
  const entries = groupInventory(inv, prices);
  assert.deepEqual(entries.map(e => e.tags), [['on hold']]);
  const text = inventoryMessage(profile(), { view: 'text', page: 0, pages: 1, entries, copies: 1, total: 1, value: 0, rap: 0 }).embeds![0]!.toJSON().description!;
  assert.match(text, /Item 10.*⏳ on hold/);
  assert.doesNotMatch(text, /Not tradable/);
});

test('unmapped bundles remain visible but cannot accidentally use an asset with the same numeric ID for pricing', () => {
  const inv = reconcileInventory(inventory(1, []), snapshot([{ ...verifiedCopy(rose, 'unknown', false, 'Bundle'), name: 'Different bundle', rap: 12 }]), new Map());
  assert.equal(priced(inv, prices).length, 0);
  const entry = groupInventory(inv, prices)[0]!;
  assert.equal(entry.name, 'Different bundle (Bundle)');
  assert.equal(entry.value, 12);
  assert.equal(entry.item, null);
});

test('multiple authenticated copies missing from the public response are all retained exactly once', () => {
  const inv = reconcileInventory(inventory(1, []), snapshot([
    verifiedCopy(10, 'one'), verifiedCopy(10, 'two'), verifiedCopy(bundle, 'bundle', false, 'Bundle'), verifiedCopy(rose, 'classic'),
  ]), new Map([[bundle, rose]]));
  assert.equal(inv.holdings.length, 4);
  assert.equal(new Set(inv.holdings.map(c => c.collectibleItemInstanceId)).size, 4);
  assert.equal(groupInventory(inv, prices).length, 3);
  assert.equal(groupInventory(inv, prices).find(e => e.assetId === 10)?.quantity, 2);
});

test('Rolimons bundle mapping accepts explicit target types and rejects conflicting IDs', () => {
  const row = ['Rose Amazeface', null, 4120, null, null, null, null, null, 'thumbnail', 2, bundle];
  const html = `var item_details = ${JSON.stringify({ [rose]: row, 10: [...row.slice(0, 9), 1, 10] })};`;
  assert.deepEqual([...parseBundleAssets(html)], [[bundle, rose]]);
  assert.throws(() => parseBundleAssets('var item_details = {broken};'), /unreadable/);
  assert.throws(() => parseBundleAssets(`var item_details = ${JSON.stringify({ [rose]: row, 10: row })};`), /conflicting/);
});

test('inventory verification failures preserve public items as unknown, and never mark them tradable', async () => {
  const publicClient = new HttpClient(async () => new Response(JSON.stringify({ nextPageCursor: null,
    data: [{ assetId: rose, userAssetId: 11228515831, isOnHold: false }] })), 0);
  let calls = 0;
  const p = new Providers(publicClient, async () => { calls++; throw new UserError('Roblox is rate limited.'); });
  const unconnected = await p.inventory(1);
  assert.equal(calls, 0);
  assert.match(unconnected.tradabilityError!, /connect/);
  const failed = await p.inventory(1, undefined, profile());
  assert.match(failed.tradabilityError!, /rate limited/);
  assert.equal(failed.holdings.length, 1);
  assert.equal(priced(failed, prices).length, 0);
  assert.deepEqual(groupInventory(failed, prices)[0]!.tags, ['Tradability unknown']);
});

test('provider verifies per viewer without contaminating another viewer or a later disconnected read', async () => {
  const publicClient = new HttpClient(async () => new Response(JSON.stringify({ nextPageCursor: null,
    data: [{ assetId: 10, userAssetId: 100, isOnHold: false }] })), 0);
  const p = new Providers(publicClient, async (_owner, viewer) => snapshot(viewer.discordId === '123' ? [verifiedCopy(10, 'one')] : []));
  assert.equal((await p.inventory(1, undefined, profile())).holdings[0]!.tradable, true);
  assert.equal((await p.inventory(1, undefined, { ...profile(), discordId: '456' })).holdings[0]!.tradable, false);
  assert.equal((await p.inventory(1)).holdings[0]!.tradable, undefined);
});

test('provider adds authenticated bundles with explicit Rolimons mappings, and fails closed when mappings disappear', async () => {
  for (const available of [true, false]) {
    const row = ['Rose Amazeface', null, 4120, null, null, null, null, null, 'thumbnail', 2, bundle];
    const http = new HttpClient(async input => String(input).includes('rolimons.com/trades')
      ? new Response(available ? `var item_details = ${JSON.stringify({ [rose]: row })};` : 'blocked', { status: available ? 200 : 403 })
      : new Response(JSON.stringify({ nextPageCursor: null, data: [{ assetId: rose, userAssetId: 1, isOnHold: false }] })), 0);
    const p = new Providers(http, async () => snapshot([verifiedCopy(bundle, 'bundle', false, 'Bundle')]));
    const inv = await p.inventory(1, undefined, profile());
    assert.equal(inv.holdings.length, 2);
    assert.equal(inv.holdings[0]!.tradable, false);
    assert.equal(priced(inv, prices).length, available ? 1 : 0);
    assert.equal(inv.holdings[1]!.tradable, true);
  }
});

test('both sides of recommendations exclude non-tradable copies and unknown inventories report the reason', async () => {
  for (const owner of [1, 2]) {
    const p = fixtureProvider();
    p.inventories.get(owner)!.holdings.forEach(c => { c.tradable = false; });
    const search = new SearchService(p);
    if (owner === 1) await assert.rejects(search.search(profile()), /verified tradable/);
    else assert.equal((await search.search(profile())).recommendations.length, 0);
  }
  const p = fixtureProvider();
  p.inventories.get(1)!.tradabilityError = 'Use /connect to verify inventory.';
  await assert.rejects(new SearchService(p).search(profile()), /connect/);
  delete p.inventories.get(1)!.tradabilityError;
  p.inventories.get(2)!.tradabilityError = 'Verification failed.';
  const result = await new SearchService(p).search(profile());
  assert.equal(result.recommendations.length, 0);
  assert.equal(result.skippedSellers, 1);
  assert.deepEqual(result.notes, ['Verification failed.']);
});

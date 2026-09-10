import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaults, effectiveValue, type Item, type Preferences } from '../src/domain.js';
import { evaluate, outgoingBundles, priced, propose, selectCopies, totals } from '../src/engine.js';
import { ad, fixtureProvider, inventory, item } from './fixtures.js';

const copy = (id: number, value: number, copyId = id) => ({ assetId: id, userAssetId: copyId, onHold: false, item: item(id, value) });
test('upgrade calculates gains, overpay and counterparty loss with their correct denominators', () => {
  const r = evaluate([copy(1, 50), copy(2, 50)], [copy(3, 110)], { ...defaults(), mode: 'upgrade' });
  assert.equal(r.passes, true); assert.equal(r.mode, 'upgrade'); assert.equal(r.valueGain, 10);
  assert.equal(r.valueGainPct, 10); assert.equal(r.rapGainPct, 10); assert.equal(r.overpayPct, 0);
  assert.ok(Math.abs(r.partnerLossPct - 1000 / 110) < 1e-9);
});
test('downgrade receives multiple copies; default value filter rejects losses even with overpay allowance', () => {
  const give = [copy(1, 100)], receive = [copy(2, 45), copy(3, 50)];
  assert.equal(evaluate(give, receive, defaults()).passes, false);
  const r = evaluate(give, receive, { ...defaults(), mode: 'downgrade', minValueGainPct: -5, maxOverpayPct: 6 });
  assert.equal(r.passes, true); assert.ok(Math.abs(r.overpayPct - 500 / 95) < 1e-9);
});
test('RAP fallback does not turn negative unassigned values into negative prices', () => {
  const c = copy(1, 100); c.item.value = null;
  assert.equal(effectiveValue(c.item), 100);
  const r = evaluate([c], [copy(2, 110)], defaults());
  assert.equal(r.passes, true); assert.match(r.warnings.join(' '), /not independent/);
});
test('risk and user preference constraints reject unsafe or unwanted incoming trades', () => {
  for (const [override, prefs] of [
    [{ projected: true }, {}], [{ demand: -1 }, { minDemand: 0 }], [{ rap: 200 }, { maxRapValueRatio: 1.4 }],
    [{}, { targetIds: [999] }], [{}, { lockedIds: [1] }], [{}, { mode: 'upgrade' as const }],
  ] as [Partial<Item>, Partial<Preferences>][]) {
    const incoming = copy(2, 110); incoming.item = { ...incoming.item, ...override };
    assert.equal(evaluate([copy(1, 100)], [incoming], { ...defaults(), ...prefs }).passes, false);
  }
  assert.equal(evaluate([copy(1, 10)], [copy(2, 110)], defaults()).passes, false);
});
test('rejects duplicate copies, same asset both sides, held items, zero RAP and more than four items', () => {
  const a = copy(1, 50);
  assert.equal(evaluate([a, a], [copy(2, 110)], defaults()).passes, false);
  assert.equal(evaluate([a], [copy(1, 50, 100)], defaults()).passes, false);
  assert.equal(evaluate([{ ...a, onHold: true }], [copy(2, 50)], defaults()).passes, false);
  assert.equal(evaluate([{ ...a, item: { ...a.item, rap: 0 } }], [copy(2, 50)], defaults()).passes, false);
  assert.equal(evaluate(Array.from({ length: 5 }, (_, i) => copy(i + 1, 10)), [copy(8, 55)], defaults()).passes, false);
});
test('selection uses actual unique copies and excludes held, locked and unsupported inventory entries', () => {
  const inv = inventory(1, [10, 10, 20, 999]); inv.holdings[1]!.onHold = true;
  const copies = priced(inv, fixtureProvider().itemMap, [20]);
  assert.equal(copies.length, 1); assert.equal(selectCopies([10, 10], copies), null);
  assert.equal(selectCopies([10, 10], priced(inventory(1, [10, 10]), fixtureProvider().itemMap))?.length, 2);
});
test('fluctuating trend is not treated as high growth', () => {
  const a = copy(1, 50); a.item.trend = 4;
  assert.equal(totals([a]).trend, -0.5);
});
test('generates exact upgrades and target counteroffers, respecting seller tags and unavailable ad copies', () => {
  const f = fixtureProvider();
  const own = priced(f.inventories.get(1)!, f.itemMap), partner = priced(f.inventories.get(2)!, f.itemMap);
  const { bundles } = outgoingBundles(own, f.adList);
  const exact = propose(ad(), own, partner, bundles, defaults());
  assert.equal(exact[0]?.match, 'exact'); assert.equal(exact[0]?.give.length, 2);
  assert.equal(propose(ad({ requesting: [] }), own, partner, bundles, { ...defaults(), targetIds: [30] })[0]?.match, 'proposal');
  assert.equal(propose(ad({ offering: [30, 30] }), own, partner, bundles, defaults()).length, 0);
  assert.equal(propose(ad({ tags: [5] }), own, partner, bundles, defaults()).length, 0);
  assert.ok(propose(ad({ tags: [6] }), own, partner, bundles, defaults()).length > 0);
  assert.equal(propose(ad({ offeringRobux: 10 }), own, partner, bundles, defaults()).length, 0);
});
test('bounded search includes exact requested bundles outside its sampled pool', () => {
  const f = fixtureProvider(); const own = priced(f.inventories.get(1)!, f.itemMap), partner = priced(f.inventories.get(2)!, f.itemMap);
  assert.equal(propose(ad(), own, partner, [], defaults())[0]?.match, 'exact');
  const huge = Array.from({ length: 100 }, (_, i) => copy(i + 1, i + 1));
  const pool = outgoingBundles(huge, []);
  assert.equal(pool.truncated, true); assert.ok(pool.bundles.length <= 24157);
});
test('partial requested-item matches remain counteroffers, and repeated asset requests need enough copies', () => {
  const f = fixtureProvider(); const own = priced(f.inventories.get(1)!, f.itemMap), partner = priced(f.inventories.get(2)!, f.itemMap);
  const { bundles } = outgoingBundles(own, []);
  assert.equal(propose(ad({ requesting: [10, 999] }), own, partner, bundles, defaults())[0]?.match, 'requested-items');
  assert.notEqual(propose(ad({ requesting: [10, 10] }), own, partner, bundles, defaults())[0]?.match, 'exact');
});

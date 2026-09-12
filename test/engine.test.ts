import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaults, effectiveValue, type Item, type Preferences } from '../src/domain.js';
import { emptyBundles, evaluate, outgoingBundles, priced, propose, selectCopies, totals, affordableRange } from '../src/engine.js';
import { ad, fixtureProvider, inventory, item, proposalProvider } from './fixtures.js';

const copy = (id: number, value: number, copyId = id) => ({ assetId: id, userAssetId: copyId, onHold: false, tradable: true, item: item(id, value) });
test('upgrade calculates gains, overpay and counterparty loss with their correct denominators', () => {
  // A real upgrade: two copies consolidated into one better item, carrying the overpay that gets it accepted.
  const r = evaluate([copy(1, 50), copy(2, 50)], [copy(3, 90)], { ...defaults(), mode: 'upgrade' });
  assert.equal(r.passes, true); assert.equal(r.mode, 'upgrade'); assert.equal(r.valueGain, -10);
  assert.equal(r.valueGainPct, -10); assert.equal(r.rapGainPct, -10); assert.equal(r.partnerLossPct, 0);
  assert.ok(Math.abs(r.overpayPct - 1000 / 90) < 1e-9);
  // The same exchange seen from the other side is the downgrade that collects that overpay.
  const partner = evaluate([copy(3, 90)], [copy(1, 50), copy(2, 50)], { ...defaults(), mode: 'downgrade' });
  assert.equal(partner.passes, true); assert.equal(partner.valueGain, 10); assert.equal(partner.overpayPct, 0);
  assert.ok(Math.abs(partner.partnerLossPct - 1000 / 100) < 1e-9);
});
test('a trade is a RAP trade once 30% of the value on the table comes from items with no Rolimons value', () => {
  const rap = (id: number, value: number) => ({ assetId: id, userAssetId: id, onHold: false, tradable: true, item: item(id, value, { value: null }) });
  // 50 of 190 (26%) is RAP-only: still a value trade, so only the 'rap' filter turns it away.
  const mostlyValued = evaluate([rap(1, 50), copy(2, 50)], [copy(3, 90)], defaults());
  assert.equal(mostlyValued.kind, 'value'); assert.ok(Math.abs(mostlyValued.rapShare - 5000 / 190) < 1e-9);
  assert.equal(evaluate([rap(1, 50), copy(2, 50)], [copy(3, 90)], { ...defaults(), tradeKind: 'value' }).passes, true);
  assert.match(evaluate([rap(1, 50), copy(2, 50)], [copy(3, 90)], { ...defaults(), tradeKind: 'rap' }).failures.join(' '), /value trade \(26% of the value/);
  // 100 of 190 (53%) is RAP-only: a RAP trade, counted on both sides of the exchange.
  const rapHeavy = evaluate([rap(1, 50), copy(2, 50)], [rap(3, 90)], defaults());
  assert.equal(rapHeavy.kind, 'rap'); assert.match(rapHeavy.warnings.join(' '), /74% of this trade, so it is a rap trade/);
  assert.match(evaluate([rap(1, 50), copy(2, 50)], [rap(3, 90)], { ...defaults(), tradeKind: 'value' }).failures.join(' '), /RAP trade \(74% of the value/);
  assert.equal(evaluate([rap(1, 50), copy(2, 50)], [rap(3, 90)], { ...defaults(), tradeKind: 'rap' }).passes, true);
  // Exactly on the line counts as RAP: 57 of 190 is 30%.
  assert.equal(evaluate([rap(1, 57), copy(2, 43)], [copy(3, 90)], defaults()).kind, 'rap');
});
test('shapes that shuffle items without upgrading or downgrading are rejected outright', () => {
  const p = defaults();
  const copies = (n: number, each: number, from = 1) => Array.from({ length: n }, (_, i) => copy(from + i, each, from + i));
  // 4-for-3 and 3-for-2 move a pile of items without changing what anyone ends up with.
  assert.match(evaluate(copies(4, 25), copies(3, 37, 10), p).failures.join(' '), /4-for-3 shuffles items around/);
  assert.match(evaluate(copies(3, 34), copies(2, 56, 10), p).failures.join(' '), /3-for-2 shuffles items around/);
  assert.match(evaluate(copies(2, 50), copies(2, 55, 10), p).failures.join(' '), /neither an upgrade nor a downgrade/);
  // A 1-for-1 is the same idea, unless the seller's own ad asked for exactly that.
  assert.match(evaluate(copies(1, 100), copies(1, 110, 10), p).failures.join(' '), /neither an upgrade nor a downgrade/);
  assert.equal(evaluate(copies(1, 100), copies(1, 110, 10), p, true).passes, true);
  // Consolidating has to actually consolidate: the item received must beat the best one given.
  assert.match(evaluate([copy(1, 100), copy(2, 10)], [copy(3, 99)], p).failures.join(' '), /not an upgrade/);
  assert.match(evaluate([copy(1, 60)], [copy(2, 70), copy(3, 5)], p).failures.join(' '), /not a downgrade/);
});
test('a downgrade has to collect a real profit, and only an ad can justify a lopsided one', () => {
  const p = defaults();
  assert.equal(evaluate([copy(1, 100)], [copy(2, 55), copy(3, 55)], p).passes, true, 'a 10% profit is what a downgrade is for');
  // Losing value, or barely moving it, is not a trade worth sending to anyone.
  assert.match(evaluate([copy(1, 100)], [copy(2, 45), copy(3, 50)], p).failures.join(' '), /Downgrade profit is below/);
  assert.match(evaluate([copy(1, 100)], [copy(2, 51), copy(3, 51)], p).failures.join(' '), /Downgrade profit is below/);
  // Past the ceiling it only stands when the seller's own ad asked for it.
  const lopsided = [copy(2, 90), copy(3, 90)];
  assert.equal(evaluate([copy(1, 100)], lopsided, p).passes, false);
  assert.equal(evaluate([copy(1, 100)], lopsided, p, true).passes, true);
  // A ceiling the user typed is their own choice and still applies, advertised or not.
  assert.equal(evaluate([copy(1, 100)], lopsided, { ...p, downgradeProfitMax: { value: 20, pct: true } }, true).passes, false);
});
test('RAP fallback does not turn negative unassigned values into negative prices', () => {
  const c = copy(1, 100); c.item.value = null;
  assert.equal(effectiveValue(c.item), 100);
  const r = evaluate([c], [copy(2, 56), copy(3, 56)], defaults());
  assert.equal(r.passes, true); assert.match(r.warnings.join(' '), /No assigned Rolimons value for Item 1: RAP counts as the value/);
});
test('risk and user preference constraints reject unsafe or unwanted incoming trades', () => {
  for (const [override, prefs] of [
    [{ projected: true }, {}], [{ demand: -1 }, { minDemand: 0 }],
    [{}, { targetIds: [999] }], [{}, { mode: 'upgrade' as const }],
  ] as [Partial<Item>, Partial<Preferences>][]) {
    const incoming = copy(2, 56); incoming.item = { ...incoming.item, ...override };
    assert.equal(evaluate([copy(1, 100)], [incoming, copy(3, 56)], { ...defaults(), ...prefs }).passes, false);
  }
  // RAP never decides: an incoming item with RAP far above its value, or a RAP loss, still passes on value alone.
  const inflated = copy(2, 56); inflated.item = { ...inflated.item, rap: 500 };
  assert.equal(evaluate([copy(1, 100)], [inflated, copy(3, 56)], { ...defaults(), maxRapValueRatio: 1.4, minRapGainPct: 0 }).passes, true);
  const rapLoss = copy(2, 56); rapLoss.item = { ...rapLoss.item, rap: 10 };
  assert.equal(evaluate([copy(1, 100)], [rapLoss, copy(3, 56)], { ...defaults(), minRapGainPct: 0, minRapGain: 1000 }).passes, true);
});
test('rejects duplicate copies, same asset both sides, held items, zero value and more than four items; zero RAP is fine', () => {
  const a = copy(1, 100), pair = [copy(2, 56), copy(3, 56)];
  assert.equal(evaluate([a, a], pair, defaults()).passes, false);
  assert.equal(evaluate([a], [copy(1, 56, 100), copy(3, 56)], defaults()).passes, false);
  assert.equal(evaluate([{ ...a, onHold: true }], pair, defaults()).passes, false);
  assert.equal(evaluate([{ ...a, item: { ...a.item, rap: 0 } }], pair, defaults()).passes, true);
  assert.equal(evaluate([{ ...a, item: { ...a.item, value: 0 } }], pair, defaults()).passes, false);
  assert.equal(evaluate(Array.from({ length: 5 }, (_, i) => copy(i + 1, 10)), [copy(8, 30)], defaults()).passes, false);
});
test('selection uses actual unique copies and excludes held and unsupported inventory entries', () => {
  const inv = inventory(1, [10, 10, 999]); inv.holdings[1]!.onHold = true;
  const copies = priced(inv, fixtureProvider().itemMap);
  assert.equal(copies.length, 1); assert.equal(selectCopies([10, 10], copies), null);
  assert.equal(selectCopies([10, 10], priced(inventory(1, [10, 10]), fixtureProvider().itemMap))?.length, 2);
});
test('fluctuating trend is not treated as high growth', () => {
  const a = copy(1, 50); a.item.trend = 4;
  assert.equal(totals([a]).trend, -0.5);
});
test('generates exact upgrades and target counteroffers, ignoring seller tags and skipping unavailable ad copies', () => {
  const f = fixtureProvider();
  const own = priced(f.inventories.get(1)!, f.itemMap), partner = priced(f.inventories.get(2)!, f.itemMap);
  const { bundles } = outgoingBundles(own, f.adList);
  const exact = propose(ad(), own, partner, bundles, defaults());
  assert.equal(exact[0]?.match, 'exact'); assert.equal(exact[0]?.give.length, 2);
  assert.equal(propose(ad({ offering: [30, 30] }), own, partner, bundles, defaults()).length, 0);
  // An ad naming no wanted items still gets a counteroffer, as long as the upgrade carries a realistic overpay.
  const g = proposalProvider(), mine = priced(g.inventories.get(1)!, g.itemMap), theirs = priced(g.inventories.get(2)!, g.itemMap);
  const open = propose(ad({ requesting: [] }), mine, theirs, outgoingBundles(mine, []).bundles, { ...defaults(), targetIds: [30] });
  assert.equal(open[0]?.match, 'proposal'); assert.equal(open[0]?.mode, 'upgrade');
  // Seller tags no longer reject offers: any ad offering the item is a valid basis.
  assert.ok(propose(ad({ tags: [5] }), own, partner, bundles, defaults()).length > 0);
  assert.ok(propose(ad({ tags: [6] }), own, partner, bundles, defaults()).length > 0);
  assert.equal(propose(ad({ offeringRobux: 10 }), own, partner, bundles, defaults()).length, 0);
});
test('bounded search includes exact requested bundles outside its sampled pool', () => {
  const f = fixtureProvider(); const own = priced(f.inventories.get(1)!, f.itemMap), partner = priced(f.inventories.get(2)!, f.itemMap);
  assert.equal(propose(ad(), own, partner, emptyBundles(), defaults())[0]?.match, 'exact');
  const huge = Array.from({ length: 100 }, (_, i) => copy(i + 1, i + 1));
  const pool = outgoingBundles(huge, []);
  assert.equal(pool.truncated, true); assert.ok(pool.bundles.all.length <= 24157);
});
test('partial requested-item matches remain counteroffers, and repeated asset requests need enough copies', () => {
  const f = proposalProvider(); const own = priced(f.inventories.get(1)!, f.itemMap), partner = priced(f.inventories.get(2)!, f.itemMap);
  const { bundles } = outgoingBundles(own, []);
  assert.equal(propose(ad({ requesting: [10, 999] }), own, partner, bundles, defaults())[0]?.match, 'requested-items');
  assert.notEqual(propose(ad({ requesting: [10, 10] }), own, partner, bundles, defaults())[0]?.match, 'exact');
});
test('affordable band spans the cheapest copy to the top four together, and evaluate enforces the receive range only when on', () => {
  const own = [copy(1, 100), copy(2, 20), copy(3, 300), copy(4, 50), copy(5, 400)];
  assert.deepEqual(affordableRange(own, 10), { minReceiveValue: 400, maxReceiveValue: Math.round(850 * 1.1) });
  assert.equal(affordableRange([], 3), null);
  // A downgrade worth 112 for a 100 item sits inside the band only when the cap allows it.
  const give = [copy(1, 100)], got = [copy(2, 56), copy(3, 56)];
  const p = { ...defaults(), affordable: true, minReceiveValue: null, maxReceiveValue: 100 };
  assert.equal(evaluate(give, got, p).passes, false);
  assert.equal(evaluate(give, got, { ...p, affordable: false }).passes, true);
  assert.equal(evaluate(give, got, { ...p, maxReceiveValue: 120, minReceiveValue: 115 }).passes, false);
});

test('a lopsided proposal only stands when the ad asks for exactly the given items', () => {
  const f = fixtureProvider();
  // Seller offers item 30 (110); giving 10+20 (100) gains 10% and giving item 10 alone gains 120%. Neither is a
  // trade a stranger accepts: one asks them to take on an item and lose value, the other is a giveaway.
  const own = priced(f.inventories.get(1)!, f.itemMap), partner = priced(f.inventories.get(2)!, f.itemMap);
  const { bundles } = outgoingBundles(own, []);
  assert.deepEqual(propose(ad({ requesting: [] }), own, partner, bundles, defaults()), [], 'an open ad gets neither');
  const asked = propose(ad({ requesting: [10] }), own, partner, bundles, defaults());
  assert.ok(asked.some(r => r.valueGainPct === 120 && r.match === 'exact'), 'the seller asked for item 10 alone, so that lopsided trade stands');
});

test('downgrade profit and upgrade overpay windows accept a percent or a value on each side and only bind their own shape', () => {
  const p = defaults();
  // Downgrade: give 100, get 45 + 65 = 110 (+10, +10%).
  const down = [copy(1, 100)], got = [copy(2, 45), copy(3, 65)];
  assert.equal(evaluate(down, got, { ...p, downgradeProfitMin: { value: 5, pct: true }, downgradeProfitMax: { value: 25, pct: true } }).passes, true);
  assert.equal(evaluate(down, got, p).passes, true, 'a blank window falls back to what the shape is normally worth');
  assert.match(evaluate(down, got, { ...p, downgradeProfitMin: { value: 15, pct: true } }).failures.join(' '), /Downgrade profit is below 15%/);
  assert.match(evaluate(down, got, { ...p, downgradeProfitMax: { value: 5, pct: false } }).failures.join(' '), /Downgrade profit is above 5\./);
  assert.equal(evaluate(down, got, { ...p, upgradeOverpayMax: { value: -50, pct: true } }).passes, true, 'the upgrade window ignores a downgrade');
  // Upgrade: give 50 + 50, get 98 (overpay +2, +2%).
  const up = [copy(1, 50), copy(2, 50)], one = [copy(3, 98)];
  assert.equal(evaluate(up, one, { ...p, upgradeOverpayMin: { value: -5, pct: true }, upgradeOverpayMax: { value: 3, pct: true } }).passes, true);
  assert.match(evaluate(up, one, p).failures.join(' '), /Upgrade overpay is below 4%/, 'a 2% overpay is not enough to get an upgrade accepted');
  assert.match(evaluate(up, one, { ...p, upgradeOverpayMax: { value: 1, pct: false } }).failures.join(' '), /Upgrade overpay is above 1\./);
  assert.match(evaluate(up, one, { ...p, upgradeOverpayMin: { value: 3, pct: true } }).failures.join(' '), /Upgrade overpay is below 3%/);
});

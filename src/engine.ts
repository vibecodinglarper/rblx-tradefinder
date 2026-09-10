import { createHash } from 'node:crypto';
import { effectiveValue, type Holding, type Inventory, type Item, type Preferences, type TradeAd } from './domain.js';

export interface PricedCopy extends Holding { item: Item }
export interface Totals { value: number; rap: number; demand: number; trend: number }
export interface Evaluation {
  give: PricedCopy[]; receive: PricedCopy[]; giving: Totals; receiving: Totals;
  valueGain: number; rapGain: number; valueGainPct: number; rapGainPct: number;
  overpayPct: number; partnerLossPct: number; score: number; mode: 'upgrade' | 'downgrade' | 'swap';
  passes: boolean; failures: string[]; warnings: string[];
}
export interface Recommendation extends Evaluation {
  ad: TradeAd; match: 'exact' | 'requested-items' | 'proposal';
  ownInventoryAt: number; partnerInventoryAt: number; pricesAt: number;
}
export function priced(inventory: Inventory, items: Map<number, Item>, locked: number[] = []): PricedCopy[] {
  const excluded = new Set(locked);
  return inventory.holdings.flatMap(h => {
    const item = items.get(h.assetId);
    return !h.onHold && !excluded.has(h.assetId) && item && effectiveValue(item) > 0
      ? [{ ...h, item }] : [];
  });
}
export function totals(copies: PricedCopy[]): Totals {
  const value = copies.reduce((n, c) => n + effectiveValue(c.item), 0);
  return {
    value, rap: copies.reduce((n, c) => n + c.item.rap, 0),
    demand: value ? copies.reduce((n, c) => n + effectiveValue(c.item) * Math.max(0, c.item.demand), 0) / value : 0,
    // Rolimons enum is categorical: 4 means fluctuating, not stronger growth.
    trend: value ? copies.reduce((n, c) => n + effectiveValue(c.item) * ({ 0: -1, 1: -0.5, 3: 1, 4: -0.5 }[c.item.trend] ?? 0), 0) / value : 0,
  };
}
export function selectCopies(ids: number[], inventory: PricedCopy[]): PricedCopy[] | null {
  const used = new Set<number>();
  const copies: PricedCopy[] = [];
  for (const id of ids) {
    const copy = inventory.find(c => c.assetId === id && !used.has(c.userAssetId));
    if (!copy) return null;
    used.add(copy.userAssetId); copies.push(copy);
  }
  return copies;
}
export function sameAssets(a: { assetId: number }[], b: number[]): boolean {
  return a.map(c => c.assetId).sort((x, y) => x - y).join(',') === [...b].sort((x, y) => x - y).join(',');
}
export function evaluate(give: PricedCopy[], receive: PricedCopy[], p: Preferences): Evaluation {
  const giving = totals(give), receiving = totals(receive);
  const valueGain = receiving.value - giving.value, rapGain = receiving.rap - giving.rap;
  const valueGainPct = giving.value > 0 ? 100 * valueGain / giving.value : 0;
  const rapGainPct = giving.rap > 0 ? 100 * rapGain / giving.rap : 0;
  const overpayPct = receiving.value > 0 ? 100 * Math.max(0, -valueGain) / receiving.value : 0;
  const partnerLossPct = receiving.value > 0 ? 100 * Math.max(0, valueGain) / receiving.value : 0;
  const mode = give.length > receive.length ? 'upgrade' : give.length < receive.length ? 'downgrade' : 'swap';
  const failures: string[] = [], warnings: string[] = [];
  if (!give.length || !receive.length || give.length > 4 || receive.length > 4) failures.push('Each side must contain 1–4 copies.');
  if (new Set([...give, ...receive].map(c => c.userAssetId)).size !== give.length + receive.length) failures.push('A unique item copy appears more than once.');
  if ([...give, ...receive].some(c => c.onHold)) failures.push('An item is on hold.');
  if (giving.value <= 0 || receiving.value <= 0 || giving.rap <= 0 || receiving.rap <= 0) failures.push('Value or RAP is unavailable or zero.');
  if (give.some(c => p.lockedIds.includes(c.assetId))) failures.push('An outgoing item is locked.');
  if (give.some(g => receive.some(r => r.assetId === g.assetId))) failures.push('Same item appears on both sides; redundant exchanges are excluded.');
  if (p.mode !== 'any' && p.mode !== mode) failures.push(`Does not fit ${p.mode} mode.`);
  if (p.targetIds.length && !receive.some(c => p.targetIds.includes(c.assetId))) failures.push('Does not include a wanted item.');
  if (valueGainPct + 1e-9 < p.minValueGainPct) failures.push(`Value gain is below ${p.minValueGainPct}%.`);
  if (rapGainPct + 1e-9 < p.minRapGainPct) failures.push(`RAP gain is below ${p.minRapGainPct}%.`);
  if (overpayPct > p.maxOverpayPct + 1e-9) failures.push(`Overpay exceeds ${p.maxOverpayPct}% of received value.`);
  if (partnerLossPct > p.maxPartnerLossPct + 1e-9) failures.push(`Counterparty value loss exceeds ${p.maxPartnerLossPct}%; unlikely to be accepted.`);
  if (p.excludeProjected && receive.some(c => c.item.projected)) failures.push('Receiving a projected item is disabled.');
  if (receive.some(c => c.item.demand < p.minDemand)) failures.push(`Incoming demand is below ${p.minDemand}.`);
  if (receive.some(c => c.item.value !== null && c.item.rap / c.item.value > p.maxRapValueRatio)) failures.push(`Incoming RAP/value ratio exceeds ${p.maxRapValueRatio}.`);
  if ([...give, ...receive].some(c => c.item.value === null)) warnings.push('Some items are unvalued: effective value uses RAP, so value and RAP are not independent signals.');
  if (receive.some(c => c.item.projected)) warnings.push('Incoming projected item: RAP may be inflated.');
  if (receive.some(c => c.item.hyped)) warnings.push('Incoming item is marked hyped.');
  if (receive.some(c => c.item.rare)) warnings.push('Incoming rare item: liquidity and negotiated prices can vary.');
  if (receive.some(c => c.item.demand < 0 || c.item.trend < 0)) warnings.push('Some demand/trend data is unknown and receives no scoring bonus.');
  if (receive.some(c => [0, 1, 4].includes(c.item.trend))) warnings.push('An incoming item has a lowering, unstable or fluctuating trend.');
  const penalty = receive.reduce((n, c) => n + (c.item.projected ? 25 : 0) + (c.item.hyped ? 5 : 0) + (c.item.rare ? 3 : 0), 0);
  const score = Math.round((0.65 * valueGainPct + 0.35 * rapGainPct + 2 * (receiving.demand - giving.demand)
    + (receiving.trend - giving.trend) - penalty) * 100) / 100;
  return { give, receive, giving, receiving, valueGain, rapGain, valueGainPct, rapGainPct, overpayPct, partnerLossPct,
    score, mode, passes: !failures.length, failures, warnings };
}

export function combinations<T>(pool: T[], max = 4): T[][] {
  const result: T[][] = [];
  function visit(start: number, picked: T[]) {
    if (picked.length) result.push(picked);
    if (picked.length === max) return;
    for (let i = start; i < pool.length; i++) visit(i + 1, [...picked, pool[i]!]);
  }
  visit(0, []);
  return result;
}

export interface Bundle { copies: PricedCopy[]; value: number }
/** Bound exponential work while retaining requested copies and a spread of price points. */
export function outgoingBundles(own: PricedCopy[], ads: TradeAd[], cap = 28): { bundles: Bundle[]; truncated: boolean } {
  const wanted = new Set(ads.flatMap(a => a.requesting));
  const sorted = [...own].sort((a, b) => effectiveValue(a.item) - effectiveValue(b.item) || a.userAssetId - b.userAssetId);
  // At most four interchangeable copies of an asset are useful in a trade.
  const counts = new Map<number, number>();
  const useful = sorted.filter(c => { const n = (counts.get(c.assetId) ?? 0) + 1; counts.set(c.assetId, n); return n <= 4; });
  let pool = useful;
  if (pool.length > cap) {
    const selected = pool.filter(c => wanted.has(c.assetId)).slice(0, Math.floor(cap / 2));
    const rest = pool.filter(c => !selected.includes(c));
    const slots = cap - selected.length;
    for (let i = 0; i < slots; i++) selected.push(rest[Math.floor(i * (rest.length - 1) / Math.max(1, slots - 1))]!);
    pool = selected;
  }
  const seen = new Set<string>();
  const bundles = combinations(pool).filter(copies => {
    const key = copies.map(c => c.assetId).sort((a, b) => a - b).join(',');
    if (seen.has(key)) return false;
    seen.add(key); return true;
  }).map(copies => ({ copies, value: totals(copies).value })).sort((a, b) => a.value - b.value);
  return { bundles, truncated: useful.length > cap };
}
function lowerBound(bundles: Bundle[], value: number): number {
  let lo = 0, hi = bundles.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (bundles[mid]!.value < value) lo = mid + 1; else hi = mid; }
  return lo;
}
export function propose(ad: TradeAd, own: PricedCopy[], partner: PricedCopy[], bundles: Bundle[], p: Preferences): Omit<Recommendation, 'ownInventoryAt' | 'partnerInventoryAt' | 'pricesAt'>[] {
  if (ad.offeringRobux || ad.requestingRobux) return [];
  // An ad with any unavailable copy is stale; don't quietly change its advertised offer.
  const advertised = selectCopies(ad.offering, partner);
  if (!advertised?.length) return [];
  const requested = ad.requesting.length ? selectCopies(ad.requesting, own) : null;
  const results: Omit<Recommendation, 'ownInventoryAt' | 'partnerInventoryAt' | 'pricesAt'>[] = [];
  const seen = new Set<string>();
  for (const receive of combinations(advertised)) {
    if (p.targetIds.length && !receive.some(c => p.targetIds.includes(c.assetId))) continue;
    const receivingValue = totals(receive).value;
    const min = receivingValue * (1 - p.maxPartnerLossPct / 100);
    const max = Math.min(receivingValue * (1 + p.maxOverpayPct / 100), receivingValue / (1 + p.minValueGainPct / 100));
    const from = lowerBound(bundles, min), end = lowerBound(bundles, max + 0.000001);
    // Sample the whole eligible value interval rather than always selecting its cheapest edge.
    const candidates: PricedCopy[][] = requested ? [requested] : [];
    const count = Math.min(160, end - from);
    for (let i = 0; i < count; i++) candidates.push(bundles[from + Math.floor(i * (end - from - 1) / Math.max(1, count - 1))]!.copies);
    for (const give of candidates) {
      const key = `${give.map(c => c.assetId).sort().join(',')}:${receive.map(c => c.assetId).sort().join(',')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const result = evaluate(give, receive, p);
      if (!result.passes) continue;
      // Tags describe the seller's desired direction, opposite to the user's.
      if (ad.tags.includes(5) && !ad.tags.includes(6) && result.mode !== 'downgrade') continue;
      if (ad.tags.includes(6) && !ad.tags.includes(5) && result.mode !== 'upgrade') continue;
      const match = ad.requesting.length && sameAssets(give, ad.requesting) && sameAssets(receive, ad.offering)
        ? 'exact' : give.some(c => ad.requesting.includes(c.assetId)) ? 'requested-items' : 'proposal';
      results.push({ ...result, score: result.score + (match === 'exact' ? 8 : match === 'requested-items' ? 3 : 0), ad, match });
    }
  }
  return results.sort((a, b) => b.score - a.score).slice(0, 3);
}
export function recommendationKey(r: Recommendation): string {
  // Ignore ad IDs and interchangeable copy IDs so reposts do not cause repeated alerts.
  return createHash('sha256').update(`${r.ad.userId}:${r.give.map(c => c.assetId).sort().join(',')}:${r.receive.map(c => c.assetId).sort().join(',')}`).digest('hex');
}

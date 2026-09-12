import { createHash } from 'node:crypto';
import { effectiveValue, RAP_TRADE_PCT, type Bound, type Holding, type Inventory, type Item, type Preferences, type TradeAd } from './domain.js';

export interface PricedCopy extends Holding { item: Item }
export interface Totals { value: number; rap: number; demand: number; trend: number }
export interface Evaluation {
  give: PricedCopy[]; receive: PricedCopy[]; giving: Totals; receiving: Totals;
  valueGain: number; rapGain: number; valueGainPct: number; rapGainPct: number;
  overpayPct: number; partnerLossPct: number; score: number; mode: 'upgrade' | 'downgrade' | 'swap';
  /** Share of the value on both sides that comes from items with no assigned Rolimons value (RAP standing in), 0–100. */
  rapShare: number;
  /** A RAP trade once `rapShare` reaches RAP_TRADE_PCT; a value trade otherwise. */
  kind: 'value' | 'rap';
  passes: boolean; failures: string[]; warnings: string[];
}
export interface Recommendation extends Evaluation {
  ad: TradeAd; match: 'exact' | 'requested-items' | 'proposal';
  ownInventoryAt: number; partnerInventoryAt: number; pricesAt: number;
}
/**
 * What each shape has to be worth before it is worth sending, when the user has set no window of their own.
 * An upgrade hands the other side more items to look after, so it only gets accepted with an overpay — around 10%
 * is the rule of thumb. A downgrade is the other end of that same trade, so it collects the overpay as profit.
 */
export const SHAPE_WINDOWS = {
  upgradeOverpay: { min: { value: 4, pct: true } as Bound, max: { value: 20, pct: true } as Bound },
  downgradeProfit: { min: { value: 4, pct: true } as Bound, max: { value: 35, pct: true } as Bound },
} as const;
/** The window actually in force for each shape: what the user set, falling back to what the shape is normally worth. */
export const downgradeWindow = (p: Preferences) => ({ min: p.downgradeProfitMin ?? SHAPE_WINDOWS.downgradeProfit.min, max: p.downgradeProfitMax ?? SHAPE_WINDOWS.downgradeProfit.max });
export const upgradeWindow = (p: Preferences) => ({ min: p.upgradeOverpayMin ?? SHAPE_WINDOWS.upgradeOverpay.min, max: p.upgradeOverpayMax ?? SHAPE_WINDOWS.upgradeOverpay.max });
/** The value movement each shape is aiming for: an upgrade pays the overpay, a downgrade collects it. */
export const SHAPE_TARGET_PCT: Record<string, number> = { upgrade: -10, downgrade: 12, swap: 0 };
/** Lower is better: how far a trade sits from what its own shape is supposed to achieve. */
export const shapeDistance = (r: { mode: string; valueGainPct: number }): number =>
  Math.abs(r.valueGainPct - (SHAPE_TARGET_PCT[r.mode] ?? 0));
/**
 * How small a trade is next to the best item the user owns, in powers of ten: 0 for trades around their top items,
 * 1 for a tenth of that, and so on. Hardly anyone wants to shuffle the bottom of their inventory, so this bands the
 * results before anything else is considered — a tidy percentage on pocket change still ranks behind real trades.
 */
export const sizeBand = (r: Evaluation, biggestOwned: number): number =>
  Math.floor(Math.log10(Math.max(1, biggestOwned / Math.max(1, Math.max(r.giving.value, r.receiving.value)))));
/**
 * How much value a trade can move your way before it stops being something a real person accepts. A downgrade is the
 * exception: the partner is consolidating and expects to pay for it, so a large gain there is ordinary, not a fluke.
 */
export const realisticGain = (mode: string): number => (mode === 'downgrade' ? 35 : REALISTIC_GAIN_PCT);
/** Projected items are worth less than their numbers say, so they never take part in any trade calculation. */
export function priced(inventory: Inventory, items: Map<number, Item>): PricedCopy[] {
  return inventory.holdings.flatMap(h => {
    const item = items.get(h.assetId);
    return !h.onHold && item && !item.projected && effectiveValue(item) > 0
      ? [{ ...h, item }] : [];
  });
}
/** The value band a user's own items can pay for: from their cheapest copy up to their four most valuable together, plus the mode's gain window. */
export function affordableRange(own: PricedCopy[], maxGainPct: number): { minReceiveValue: number; maxReceiveValue: number } | null {
  if (!own.length) return null;
  const values = own.map(c => effectiveValue(c.item)).sort((a, b) => b - a);
  const top = values.slice(0, 4).reduce((n, v) => n + v, 0);
  // From the user's best single item (anything cheaper is not an upgrade target) to their four best together plus the gain band.
  return { minReceiveValue: values[0]!, maxReceiveValue: Math.round(top * (1 + Math.max(0, maxGainPct) / 100)) };
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
/**
 * Judges one exchange. `advertised` means the seller's own ad asked for exactly these items, which relaxes the bounds
 * that exist only to predict what a partner would accept — they have already said what they would accept.
 */
export function evaluate(give: PricedCopy[], receive: PricedCopy[], p: Preferences, advertised = false): Evaluation {
  const giving = totals(give), receiving = totals(receive);
  const valueGain = receiving.value - giving.value, rapGain = receiving.rap - giving.rap;
  const valueGainPct = giving.value > 0 ? 100 * valueGain / giving.value : 0;
  const rapGainPct = giving.rap > 0 ? 100 * rapGain / giving.rap : 0;
  const overpayPct = receiving.value > 0 ? 100 * Math.max(0, -valueGain) / receiving.value : 0;
  const partnerLossPct = receiving.value > 0 ? 100 * Math.max(0, valueGain) / receiving.value : 0;
  const mode = give.length > receive.length ? 'upgrade' : give.length < receive.length ? 'downgrade' : 'swap';
  // What part of the trade rests on RAP: items Rolimons has not valued count their RAP as value, on either side.
  const rapValue = [...give, ...receive].reduce((n, c) => n + (c.item.value === null ? effectiveValue(c.item) : 0), 0);
  const rapShare = giving.value + receiving.value > 0 ? 100 * rapValue / (giving.value + receiving.value) : 0;
  const kind = rapShare + 1e-9 >= RAP_TRADE_PCT ? 'rap' : 'value';
  const failures: string[] = [], warnings: string[] = [];
  const share = `${Math.round(rapShare)}% of the value on the table is RAP-only items`;
  if (p.tradeKind === 'value' && kind === 'rap') failures.push(`This is a RAP trade (${share}) and you asked for value trades.`);
  if (p.tradeKind === 'rap' && kind === 'value') failures.push(`This is a value trade (${share}, under ${RAP_TRADE_PCT}%) and you asked for RAP trades.`);
  if (!give.length || !receive.length || give.length > 4 || receive.length > 4) failures.push('Each side must contain 1–4 copies.');
  if (new Set([...give, ...receive].map(c => c.userAssetId)).size !== give.length + receive.length) failures.push('A unique item copy appears more than once.');
  if ([...give, ...receive].some(c => c.onHold)) failures.push('An item is on hold.');
  if (giving.value <= 0 || receiving.value <= 0) failures.push('Value is unavailable or zero.');
  if (give.some(g => receive.some(r => r.assetId === g.assetId))) failures.push('Same item appears on both sides; redundant exchanges are excluded.');
  if (p.mode !== 'any' && p.mode !== mode) failures.push(`Does not fit ${p.mode} mode.`);
  if (p.targetIds.length && !receive.some(c => p.targetIds.includes(c.assetId))) failures.push('Does not include a wanted item.');
  // Only a trade that really consolidates or really splits is worth sending: at least two items given per item
  // received, or received per item given. 4-for-3, 3-for-2 and even-count shuffles move a pile of items without
  // changing what anyone owns, which is why nobody sends them. A 1-for-1 only stands when the ad asked for it.
  if (mode === 'swap' && !(advertised && give.length === 1)) failures.push('An even exchange is neither an upgrade nor a downgrade.');
  else if (mode !== 'swap' && Math.max(give.length, receive.length) < 2 * Math.min(give.length, receive.length)) {
    failures.push(`${give.length}-for-${receive.length} shuffles items around without upgrading or downgrading.`);
  }
  // Upgrading means walking away with a better single item than you put in; downgrading is the same test reversed.
  const best = (copies: PricedCopy[]) => (copies.length ? Math.max(...copies.map(c => effectiveValue(c.item))) : 0);
  if (mode === 'upgrade' && best(receive) <= best(give)) failures.push('Nothing you receive beats the best item you give, so this is not an upgrade.');
  if (mode === 'downgrade' && best(give) <= best(receive)) failures.push('Nothing you give beats the best item you receive, so this is not a downgrade.');
  // The loss floor is about plain value; an upgrade's loss is its overpay, judged by the overpay window below.
  if (mode !== 'upgrade' && valueGainPct + 1e-9 < p.minValueGainPct) failures.push(`Value gain is below ${p.minValueGainPct}%.`);
  // Profit window: per-item rules for received items take over from the general range; several rules all apply.
  const rules = receive.flatMap(c => { const r = p.itemRules[String(c.assetId)]; return r ? [{ name: c.item.name, ...r }] : []; });
  const windows = rules.length ? rules : [{ name: null, min: p.minValueGain, max: p.maxValueGain }];
  for (const w of windows) {
    const why = w.name ? ` (your rule for ${w.name})` : '';
    if (w.min !== null && valueGain + 1e-9 < w.min) failures.push(`Value gain is below ${w.min.toLocaleString('en-US')}${why}.`);
    if (w.max !== null && valueGain - 1e-9 > w.max) failures.push(`Value gain is above ${w.max.toLocaleString('en-US')}${why}.`);
  }
  // Shape-specific windows. Downgrade profit is your gain; upgrade overpay is how much more you give (negative = you gain).
  const bound = (b: Bound | null | undefined, value: number, pct: number) => (b ? (b.pct ? { got: pct, want: b.value, text: `${b.value}%` } : { got: value, want: b.value, text: b.value.toLocaleString('en-US') }) : null);
  if (mode === 'downgrade') {
    const lo = bound(p.downgradeProfitMin ?? SHAPE_WINDOWS.downgradeProfit.min, valueGain, valueGainPct);
    // The default ceiling is only a guess at what a partner would hand over, and their own ad settles that. A ceiling
    // the user typed is their own choice, so it still applies.
    const hi = bound(p.downgradeProfitMax ?? (advertised ? null : SHAPE_WINDOWS.downgradeProfit.max), valueGain, valueGainPct);
    if (lo && lo.got + 1e-9 < lo.want) failures.push(`Downgrade profit is below ${lo.text}.`);
    if (hi && hi.got - 1e-9 > hi.want) failures.push(`Downgrade profit is above ${hi.text}.`);
  } else if (mode === 'upgrade') {
    // The default floor is only a guess at what the partner needs to say yes, and their own ad settles that; a floor
    // the user typed is their own choice. The ceiling is what the user is willing to pay either way.
    const lo = bound(p.upgradeOverpayMin ?? (advertised ? null : SHAPE_WINDOWS.upgradeOverpay.min), -valueGain, -valueGainPct);
    const hi = bound(p.upgradeOverpayMax ?? SHAPE_WINDOWS.upgradeOverpay.max, -valueGain, -valueGainPct);
    if (lo && lo.got + 1e-9 < lo.want) failures.push(`Upgrade overpay is below ${lo.text}.`);
    if (hi && hi.got - 1e-9 > hi.want) failures.push(`Upgrade overpay is above ${hi.text}.`);
  }
  if (p.affordable && p.minReceiveValue !== null && receiving.value + 1e-9 < p.minReceiveValue) failures.push(`Received value is below your ${p.minReceiveValue.toLocaleString('en-US')} floor.`);
  if (p.affordable && p.maxReceiveValue !== null && receiving.value - 1e-9 > p.maxReceiveValue) failures.push(`Received value is above your ${p.maxReceiveValue.toLocaleString('en-US')} cap.`);
  if ([...give, ...receive].some(c => c.item.projected)) failures.push('Projected items are excluded from every calculation; their value is not what it appears.');
  if (receive.some(c => c.item.demand < p.minDemand)) failures.push(`Incoming demand is below ${p.minDemand}.`);
  // RAP is informational only: every decision above and the score below use value (or RAP standing in as value).
  const unvalued = [...give, ...receive].filter(c => c.item.value === null).map(c => c.item.name);
  if (unvalued.length) warnings.push(`No assigned Rolimons value for ${[...new Set(unvalued)].join(', ')}: RAP counts as the value (${Math.round(rapShare)}% of this trade, so it is a ${kind} trade).`);
  if (receive.some(c => c.item.projected)) warnings.push('Incoming projected item: RAP may be inflated.');
  if (receive.some(c => c.item.hyped)) warnings.push('Incoming item is marked hyped.');
  if (receive.some(c => c.item.rare)) warnings.push('Incoming rare item: liquidity and negotiated prices can vary.');
  if (receive.some(c => c.item.demand < 0 || c.item.trend < 0)) warnings.push('Some demand/trend data is unknown and receives no scoring bonus.');
  if (receive.some(c => [0, 1, 4].includes(c.item.trend))) warnings.push('An incoming item has a lowering, unstable or fluctuating trend.');
  const penalty = receive.reduce((n, c) => n + (c.item.projected ? 25 : 0) + (c.item.hyped ? 5 : 0) + (c.item.rare ? 3 : 0), 0);
  const score = Math.round((valueGainPct + 2 * (receiving.demand - giving.demand)
    + (receiving.trend - giving.trend) - penalty) * 100) / 100;
  return { give, receive, giving, receiving, valueGain, rapGain, valueGainPct, rapGainPct, overpayPct, partnerLossPct,
    score, mode, rapShare, kind, passes: !failures.length, failures, warnings };
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

/** Sellers rarely give away more than this share of value, so proposals past it are only kept when the ad asked for exactly these items. */
export const REALISTIC_GAIN_PCT = 10;
export interface Bundle { copies: PricedCopy[]; value: number }
/**
 * Every bundle of the user's own items worth offering, cheapest first, plus the same bundles split by how many items
 * they contain. The split matters: there are far more four-item bundles than single items, so sampling one flat list
 * by value alone buries the single-item offers that every downgrade is built on.
 */
export interface BundleIndex { all: Bundle[]; bySize: Bundle[][] }
export const emptyBundles = (): BundleIndex => ({ all: [], bySize: [] });
/** Bound exponential work while retaining requested copies and the items people actually trade around. */
export function outgoingBundles(own: PricedCopy[], ads: TradeAd[], cap = 28): { bundles: BundleIndex; truncated: boolean } {
  const wanted = new Set(ads.flatMap(a => a.requesting));
  const sorted = [...own].sort((a, b) => effectiveValue(a.item) - effectiveValue(b.item) || a.userAssetId - b.userAssetId);
  // At most four interchangeable copies of an asset are useful in a trade.
  const counts = new Map<number, number>();
  const useful = sorted.filter(c => { const n = (counts.get(c.assetId) ?? 0) + 1; counts.set(c.assetId, n); return n <= 4; });
  let pool = useful;
  if (pool.length > cap) {
    const requested = pool.filter(c => wanted.has(c.assetId)).slice(0, Math.floor(cap / 3));
    const rest = pool.filter(c => !requested.includes(c));
    // People trade around their better items; a handful of cheap copies stay on as throw-ins and nothing else does.
    const throwIns = Math.min(4, Math.floor((cap - requested.length) / 4));
    const byValue = [...rest].sort((a, b) => effectiveValue(b.item) - effectiveValue(a.item));
    pool = [...new Set([...requested, ...byValue.slice(0, cap - requested.length - throwIns), ...rest.slice(0, throwIns)])].slice(0, cap);
  }
  const seen = new Set<string>();
  const all = combinations(pool).filter(copies => {
    const key = copies.map(c => c.assetId).sort((a, b) => a - b).join(',');
    if (seen.has(key)) return false;
    seen.add(key); return true;
  }).map(copies => ({ copies, value: totals(copies).value })).sort((a, b) => a.value - b.value);
  const bySize: Bundle[][] = [];
  for (const bundle of all) (bySize[bundle.copies.length] ??= []).push(bundle);
  return { bundles: { all, bySize }, truncated: useful.length > cap };
}
function lowerBound(bundles: Bundle[], value: number): number {
  let lo = 0, hi = bundles.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (bundles[mid]!.value < value) lo = mid + 1; else hi = mid; }
  return lo;
}
/**
 * Which give-bundle sizes can possibly pair with a receive of this size, from the shape rule alone. Receiving three
 * items can only ever be a downgrade of one, and receiving one can only ever be an upgrade of two or more, so every
 * other size is wasted arithmetic. Pairs the seller explicitly asked for are tried whatever their size.
 */
const GIVE_SIZES: Record<number, number[]> = { 1: [2, 3, 4], 2: [1, 4], 3: [1], 4: [1, 2] };
/** Bundles sampled per size, taken from the side of the receive value that the shape needs. */
const PER_SIZE = 40;
export function propose(ad: TradeAd, own: PricedCopy[], partner: PricedCopy[], bundles: BundleIndex, p: Preferences): Omit<Recommendation, 'ownInventoryAt' | 'partnerInventoryAt' | 'pricesAt'>[] {
  if (ad.offeringRobux || ad.requestingRobux) return [];
  // An ad with any unavailable copy is stale; don't quietly change its advertised offer.
  const advertised = selectCopies(ad.offering, partner);
  if (!advertised?.length) return [];
  const requested = ad.requesting.length ? selectCopies(ad.requesting, own) : null;
  const results: Omit<Recommendation, 'ownInventoryAt' | 'partnerInventoryAt' | 'pricesAt'>[] = [];
  const seen = new Set<string>();
  // What a give-bundle has to be worth for its shape's window to be satisfiable at all, as multipliers of the value
  // received. Binary-searching straight into that range skips the bundles whose only possible outcome is rejection,
  // which is where nearly all of the work used to go. A bound given as an amount rather than a percentage cannot be
  // turned into a multiplier, so it simply widens the range and `evaluate` applies it as usual.
  const upgradeGive = ((lo, hi): [number, number] => [lo.pct ? 1 + lo.value / 100 : 1, hi.pct ? 1 + hi.value / 100 : Infinity])(
    p.upgradeOverpayMin ?? SHAPE_WINDOWS.upgradeOverpay.min, p.upgradeOverpayMax ?? SHAPE_WINDOWS.upgradeOverpay.max);
  const downgradeGive = ((lo, hi): [number, number] => [hi.pct ? 1 / (1 + hi.value / 100) : 0, lo.pct ? 1 / (1 + lo.value / 100) : Infinity])(
    p.downgradeProfitMin ?? SHAPE_WINDOWS.downgradeProfit.min, p.downgradeProfitMax ?? SHAPE_WINDOWS.downgradeProfit.max);
  for (const receive of combinations(advertised)) {
    if (p.targetIds.length && !receive.some(c => p.targetIds.includes(c.assetId))) continue;
    const receivingValue = totals(receive).value;
    // Only the loss floor bounds what you give; any gain above it is welcome, so cheaper bundles are all eligible.
    const candidates: Bundle[] = requested ? [{ copies: requested, value: totals(requested).value }] : [];
    // Each size is sampled from the side of the receive value its shape needs: an upgrade gives more than it gets, a
    // downgrade gives less. Taking them per size keeps a single valuable item from being crowded out by the thousands
    // of four-item combinations that happen to land on the same total.
    for (const size of GIVE_SIZES[receive.length] ?? []) {
      const sized = bundles.bySize[size];
      if (!sized?.length) continue;
      const [lo, hi] = size > receive.length ? upgradeGive : downgradeGive;
      const from = lowerBound(sized, receivingValue * lo);
      const to = Math.min(lowerBound(sized, receivingValue * hi + 0.000001), from + PER_SIZE);
      for (let i = from; i < to; i++) candidates.push(sized[i]!);
    }
    for (const { copies: give, value: givingValue } of candidates) {
      const key = `${give.map(c => c.assetId).sort().join(',')}:${receive.map(c => c.assetId).sort().join(',')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // Seller tags (wants an upgrade/downgrade) are hints only: any ad offering the item is a valid basis for an offer.
      // An ad asking for exactly these items is different — those are the seller's own stated terms.
      const asksForThese = ad.requesting.length > 0 && sameAssets(give, ad.requesting);
      // Two exact rejections that need only arithmetic, taken before building a full evaluation: most candidates fail
      // on the margin alone, and an evaluation costs far more than the division that rules one out.
      const shape = give.length > receive.length ? 'upgrade' : give.length < receive.length ? 'downgrade' : 'swap';
      if (!asksForThese && givingValue > 0 && 100 * (receivingValue - givingValue) / givingValue > realisticGain(shape) + 1e-9) continue;
      const result = evaluate(give, receive, p, asksForThese);
      if (!result.passes) continue;
      const match = asksForThese && sameAssets(receive, ad.offering)
        ? 'exact' : give.some(c => ad.requesting.includes(c.assetId)) ? 'requested-items' : 'proposal';
      results.push({ ...result, score: result.score + (match === 'exact' ? 8 : match === 'requested-items' ? 3 : 0), ad, match });
    }
  }
  // Keep the realistic proposals per ad: advertised exchanges first, then the ones closest to even. Upgrades and downgrades
  // are cut separately so an ad that supports both shapes contributes both.
  const realism = (r: { match: string }) => (r.match === 'exact' ? 2 : r.match === 'requested-items' ? 1 : 0);
  const ordered = results.sort((a, b) => realism(b) - realism(a) || shapeDistance(a) - shapeDistance(b) || b.score - a.score);
  return [...ordered.filter(r => r.mode !== 'downgrade').slice(0, 3), ...ordered.filter(r => r.mode === 'downgrade').slice(0, 3)];
}
/** Alert identity: the seller and what you would get. A different bundle of your own items for the same thing is the same alert. */
export function alertKey(r: Recommendation): string {
  return createHash('sha256').update(`alert:${r.ad.userId}:${r.receive.map(c => c.assetId).sort().join(',')}`).digest('hex');
}
export function recommendationKey(r: Recommendation): string {
  // Ignore ad IDs and interchangeable copy IDs so reposts do not cause repeated alerts.
  return createHash('sha256').update(`${r.ad.userId}:${r.give.map(c => c.assetId).sort().join(',')}:${r.receive.map(c => c.assetId).sort().join(',')}`).digest('hex');
}

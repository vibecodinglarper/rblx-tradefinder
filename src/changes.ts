import { effectiveValue, type Holding, type Item } from './domain.js';
import { totals, type PricedCopy, type Totals } from './engine.js';

/**
 * What changed between two looks at a public inventory. Copies are matched by their unique copy ID, so a trade shows
 * as copies out plus copies in, a sale or gift as copies out only, and a purchase as copies in only.
 */
export interface InventoryChange {
  kind: 'trade' | 'out' | 'in';
  removed: PricedCopy[]; added: PricedCopy[];
  lost: Totals; gained: Totals;
  /** Net change in value and RAP: gained minus lost. */
  valueGain: number; rapGain: number;
  /** Net value change relative to what left; only meaningful for a trade, null for a one-sided change. */
  valueGainPct: number | null;
  /** Whole-inventory totals before and after, counting every priced copy. */
  before: { copies: number; value: number; rap: number }; after: { copies: number; value: number; rap: number };
  /** Copies whose price is unknown on either side; they count as zero in the totals. */
  unpriced: number;
}
/** Rolimons data when the item is tracked; otherwise Roblox's own name and recent average price stand in for both figures. */
function copyOf(h: Holding, items: Map<number, Item>): PricedCopy {
  const item = items.get(h.assetId) ?? {
    id: h.assetId, name: h.name ?? `Item ${h.assetId}`, acronym: '', rap: h.robloxRap && h.robloxRap > 0 ? h.robloxRap : 0, value: null,
    demand: -1, trend: 2, projected: false, hyped: false, rare: false,
  };
  return { ...h, item };
}
const summary = (copies: PricedCopy[]) => ({ copies: copies.length, value: copies.reduce((n, c) => n + effectiveValue(c.item), 0), rap: copies.reduce((n, c) => n + c.item.rap, 0) });
const bySafeValue = (a: PricedCopy, b: PricedCopy) => effectiveValue(b.item) - effectiveValue(a.item) || a.item.name.localeCompare(b.item.name);
export function diffInventory(before: Holding[], after: Holding[], items: Map<number, Item>): InventoryChange | null {
  const previous = new Map(before.map(h => [h.userAssetId, h]));
  const current = new Map(after.map(h => [h.userAssetId, h]));
  const removed = before.filter(h => !current.has(h.userAssetId)).map(h => copyOf(h, items)).sort(bySafeValue);
  const added = after.filter(h => !previous.has(h.userAssetId)).map(h => copyOf(h, items)).sort(bySafeValue);
  if (!removed.length && !added.length) return null;
  const lost = totals(removed), gained = totals(added);
  return {
    kind: removed.length && added.length ? 'trade' : removed.length ? 'out' : 'in',
    removed, added, lost, gained,
    valueGain: gained.value - lost.value, rapGain: gained.rap - lost.rap,
    valueGainPct: removed.length && added.length && lost.value > 0 ? 100 * (gained.value - lost.value) / lost.value : null,
    before: summary(before.map(h => copyOf(h, items))), after: summary(after.map(h => copyOf(h, items))),
    unpriced: [...removed, ...added].filter(c => effectiveValue(c.item) <= 0).length,
  };
}

import { effectiveValue, visibleHoldings, type Inventory, type Item } from './domain.js';

/** One catalog item in an inventory, with every owned copy folded into a quantity. */
export interface InventoryEntry {
  assetId: number; name: string; quantity: number; onHold: number; item: Item | null;
  /** Value per copy: Rolimons value, else Rolimons RAP, else Roblox recent average price; null only when nothing is known. */
  value: number | null; rap: number | null; tags: string[];
  /** True when `value` is really a RAP figure standing in for an unassigned value. */
  rapAsValue: boolean;
}
export type InventoryView = 'grid' | 'text';
export const PAGE_SIZE: Record<InventoryView, number> = { grid: 12, text: 20 };

/** Permanently untradable copies are left out; a copy on hold is shown, since it will be tradable again. */
export function groupInventory(inventory: Inventory, items: Map<number, Item>): InventoryEntry[] {
  const groups = new Map<string, InventoryEntry>();
  const availability = new Map<InventoryEntry, { tradable: number; unknown: number }>();
  for (const h of visibleHoldings(inventory.holdings)) {
    const key = h.itemTarget ? `${h.itemTarget.itemType}:${h.itemTarget.targetId}` : `Asset:${h.assetId}`;
    let entry = groups.get(key);
    if (!entry) {
      const item = h.unmappedBundle ? null : items.get(h.assetId) ?? null;
      const rap = item?.rap ?? (h.robloxRap && h.robloxRap > 0 ? h.robloxRap : null);
      const value = item ? effectiveValue(item) : rap;
      entry = { assetId: h.assetId, name: item?.name ?? h.name ?? `Item ${h.assetId}`, quantity: 0, onHold: 0, item, value, rap,
        rapAsValue: value !== null && (item?.value ?? null) === null,
        tags: [item?.rare && 'rare', item?.projected && 'projected', item?.hyped && 'hyped', value === null && 'unpriced'].filter((t): t is string => Boolean(t)) };
      if (h.itemTarget?.itemType === 'Bundle') entry.name += ' (Bundle)';
      groups.set(key, entry);
      availability.set(entry, { tradable: 0, unknown: 0 });
    }
    entry.quantity++;
    if (h.onHold) entry.onHold++;
    const status = availability.get(entry)!;
    if (h.tradable === true && !h.onHold) status.tradable++;
    else if (h.tradable === undefined) status.unknown++;
  }
  const entries = [...groups.values()];
  for (const e of entries) {
    const status = availability.get(e)!;
    // Status goes first so it remains visible even when a card has several other tags. With untradable copies gone,
    // a verified entry with nothing tradable is one whose every copy is on hold.
    const label = status.unknown ? 'Tradability unknown' : status.tradable === e.quantity ? 'Tradable'
      : status.tradable === 0 ? 'on hold' : `${status.tradable}/${e.quantity} tradable`;
    e.tags.unshift(label);
    if (e.onHold && label !== 'on hold') e.tags.push(e.onHold === e.quantity ? 'on hold' : `${e.onHold} on hold`);
  }
  // Most valuable first; unpriced items last, then by name so the order is stable between pages.
  return entries.sort((a, b) => (b.value ?? -1) - (a.value ?? -1) || a.name.localeCompare(b.name));
}
export function paginate<T>(list: T[], page: number, size: number): { items: T[]; page: number; pages: number } {
  const pages = Math.max(1, Math.ceil(list.length / size));
  const current = Math.min(Math.max(0, page), pages - 1);
  return { items: list.slice(current * size, current * size + size), page: current, pages };
}

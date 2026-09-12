import { effectiveValue, type Inventory, type Item } from './domain.js';

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

export function groupInventory(inventory: Inventory, items: Map<number, Item>): InventoryEntry[] {
  const groups = new Map<number, InventoryEntry>();
  for (const h of inventory.holdings) {
    let entry = groups.get(h.assetId);
    if (!entry) {
      const item = items.get(h.assetId) ?? null;
      const rap = item?.rap ?? (h.robloxRap && h.robloxRap > 0 ? h.robloxRap : null);
      const value = item ? effectiveValue(item) : rap;
      entry = { assetId: h.assetId, name: item?.name ?? h.name ?? `Item ${h.assetId}`, quantity: 0, onHold: 0, item, value, rap,
        rapAsValue: value !== null && (item?.value ?? null) === null,
        tags: [item?.rare && 'rare', item?.projected && 'projected', item?.hyped && 'hyped', value === null && 'unpriced'].filter((t): t is string => Boolean(t)) };
      groups.set(h.assetId, entry);
    }
    entry.quantity++;
    if (h.onHold) entry.onHold++;
  }
  const entries = [...groups.values()];
  for (const e of entries) if (e.onHold) e.tags.push(e.onHold === e.quantity ? 'on hold' : `${e.onHold} on hold`);
  // Most valuable first; unpriced items last, then by name so the order is stable between pages.
  return entries.sort((a, b) => (b.value ?? -1) - (a.value ?? -1) || a.name.localeCompare(b.name));
}
export function paginate<T>(list: T[], page: number, size: number): { items: T[]; page: number; pages: number } {
  const pages = Math.max(1, Math.ceil(list.length / size));
  const current = Math.min(Math.max(0, page), pages - 1);
  return { items: list.slice(current * size, current * size + size), page: current, pages };
}

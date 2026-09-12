import type { Holding, Inventory, Snapshot } from './domain.js';
import type { TradableCopy } from './trading.js';

/** Keep legacy-only items visible, but only authenticated copies are eligible for recommendations. */
export function reconcileInventory(publicInventory: Inventory, verified: Snapshot<TradableCopy[]>, bundleAssets: Map<number, number>): Inventory {
  const holdings: Holding[] = publicInventory.holdings.map(h => ({ ...h, tradable: false }));
  const matched = new Set<Holding>();
  for (const copy of verified.data) {
    const targetId = Number(copy.itemTarget.targetId);
    const bundle = copy.itemTarget.itemType === 'Bundle';
    const pricingId = bundle ? bundleAssets.get(targetId) : targetId;
    // A retained classic face and its replacement are separate items. Never let a bundle validate the classic asset.
    const existing = !bundle ? holdings.find(h => h.assetId === targetId && !matched.has(h) && h.onHold === copy.isOnHold)
      ?? holdings.find(h => h.assetId === targetId && !matched.has(h)) : undefined;
    const holding: Holding = existing ?? { assetId: pricingId ?? targetId, userAssetId: copy.collectibleItemInstanceId, onHold: copy.isOnHold };
    matched.add(holding);
    if (!existing) holdings.push(holding);
    Object.assign(holding, { itemTarget: copy.itemTarget, collectibleItemInstanceId: copy.collectibleItemInstanceId,
      tradable: !copy.isOnHold, onHold: copy.isOnHold, name: copy.name ?? holding.name, robloxRap: copy.rap ?? holding.robloxRap,
      ...(bundle && pricingId === undefined ? { unmappedBundle: true } : {}) });
  }
  return { userId: publicInventory.userId, holdings, fetchedAt: Math.min(publicInventory.fetchedAt, verified.fetchedAt) };
}

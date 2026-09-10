import { UserError, type Preferences, type UserProfile, type TradeAd } from './domain.js';
import { outgoingBundles, priced, propose, recommendationKey, type Recommendation } from './engine.js';
import type { DataProvider } from './providers.js';

export interface SearchResult {
  recommendations: Recommendation[]; adsScanned: number; sellersChecked: number;
  skippedSellers: number; truncatedInventory: boolean; candidateSellers: number;
  pricesAt: number; notes: string[];
}
export class SearchService {
  private active = new Set<string>();
  constructor(readonly provider: DataProvider, private maxSellers = 12) {}
  async search(user: UserProfile, preferences: Preferences = user.preferences): Promise<SearchResult> {
    if (this.active.has(user.discordId)) throw new UserError('A search is already running for you. Please wait for it to finish.');
    this.active.add(user.discordId);
    try { return await this.run(user, preferences); }
    finally { this.active.delete(user.discordId); }
  }
  private async run(user: UserProfile, p: Preferences): Promise<SearchResult> {
    const [items, adSnapshot, inventory] = await Promise.all([this.provider.items(), this.provider.ads(), this.provider.inventory(user.robloxId)]);
    const own = priced(inventory, items.data, p.lockedIds);
    if (!own.length) throw new UserError('No available, unlocked items with supported Rolimons prices were found in this public inventory.');
    const now = Date.now();
    const ads = adSnapshot.data.filter(a => a.userId !== user.robloxId && a.createdAt <= now + 60_000
      && now - a.createdAt <= p.maxAdAgeMinutes * 60_000 && a.offering.length && !a.offeringRobux && !a.requestingRobux
      && a.offering.every(id => items.data.has(id)) && (!p.targetIds.length || a.offering.some(id => p.targetIds.includes(id))));
    const { bundles, truncated } = outgoingBundles(own, ads);
    const bySeller = new Map<number, { ads: TradeAd[]; score: number }>();
    // Price-screen every recent ad before spending requests on seller inventories.
    for (const ad of ads) {
      const advertised = ad.offering.map((assetId, i) => ({ assetId, userAssetId: -(i + 1), onHold: false, item: items.data.get(assetId)! }));
      const previews = propose(ad, own, advertised, bundles, p);
      if (!previews.length) continue;
      const existing = bySeller.get(ad.userId) ?? { ads: [], score: -Infinity };
      existing.ads.push(ad); existing.score = Math.max(existing.score, previews[0]!.score);
      bySeller.set(ad.userId, existing);
    }
    const sellers = [...bySeller.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, this.maxSellers);
    const recommendations: Recommendation[] = [];
    let skippedSellers = 0;
    const notes: string[] = [];
    for (const [sellerId, candidate] of sellers) {
      try {
        const partnerInventory = await this.provider.inventory(sellerId);
        const partner = priced(partnerInventory, items.data);
        for (const ad of candidate.ads) {
          for (const result of propose(ad, own, partner, bundles, p)) recommendations.push({ ...result,
            ownInventoryAt: inventory.fetchedAt, partnerInventoryAt: partnerInventory.fetchedAt, pricesAt: items.fetchedAt });
        }
      } catch (error) {
        skippedSellers++;
        if (error instanceof UserError && !notes.includes(error.message)) notes.push(error.message);
        else if (!(error instanceof UserError)) throw error;
      }
    }
    // Don't present snapshots that aged excessively during a slow/rate-limited scan.
    const finished = Date.now();
    if (finished - items.fetchedAt > 5 * 60_000 || finished - inventory.fetchedAt > 5 * 60_000)
      throw new UserError('The scan took too long and its prices or inventory became stale. Please retry.');
    const seen = new Set<string>();
    const ranked = recommendations.sort((a, b) => b.score - a.score).filter(r => {
      if (finished - r.partnerInventoryAt > 5 * 60_000 || finished - r.ad.createdAt > p.maxAdAgeMinutes * 60_000) return false;
      const key = recommendationKey(r);
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });
    return { recommendations: ranked.slice(0, 10), adsScanned: ads.length, sellersChecked: sellers.length,
      skippedSellers, truncatedInventory: truncated, candidateSellers: bySeller.size, pricesAt: items.fetchedAt, notes: notes.slice(0, 2) };
  }
}

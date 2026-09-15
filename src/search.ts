import { effectiveValue, UserError, type Holding, type Inventory, type Preferences, type UserProfile, type TradeAd } from './domain.js';
import { affordableRange, evaluate, outgoingBundles, priced, propose, REALISTIC_GAIN_PCT, recommendationKey, sameAssets, shapeDistance, sizeBand, type Evaluation, type Recommendation, type PricedCopy } from './engine.js';

export interface SearchOptions {
  /** Only offer these items, one at a time (downgrade mode: each chosen item alone for several of the seller's). */
  giveOnly?: number[];
  /** Ranking key, lower first; defaults to the heuristic score descending. */
  rank?: (r: Evaluation) => number;
}
import type { DataProvider } from './providers.js';

/** Where past polls of the ad feed are kept; the Store implements it. */
export interface ArchiveStats { count: number; minutes: number; perHour?: number; bytes?: number; retentionHours?: number; maxAds?: number }
export interface AdArchive {
  saveAds(ads: TradeAd[]): number;
  recentAds(maxAgeMs: number, now?: number): TradeAd[];
  adCoverage(now?: number): { count: number; minutes: number };
  /** Richer numbers for the panels that report on the archive; optional so test doubles need not provide them. */
  stats?(now?: number): ArchiveStats;
}
export interface SearchResult {
  recommendations: Recommendation[]; adsScanned: number; sellersChecked: number;
  skippedSellers: number; truncatedInventory: boolean; candidateSellers: number;
  pricesAt: number; notes: string[];
  /** Age of the oldest ad screened, in minutes: how far back the archive reached for this search. */
  coverageMinutes: number;
  /** Ads in the screened pool that offered a wanted/target item, before any price filtering. */
  adsOfferingTarget: number;
}
/**
 * How stale a prospective partner's inventory may be while screening. Recommendations are rejected once their
 * snapshot passes five minutes, so this stays well inside that, and repeat scans reuse most of the reads.
 */
const PARTNER_INVENTORY_MS = 180_000;
export class SearchService {
  private active = new Set<string>();
  constructor(readonly provider: DataProvider, private maxSellers = 12, readonly archive?: AdArchive) {}
  /** Archive size and reach, for status panels. Absent when no archive is attached. */
  coverage(): ArchiveStats | undefined { return this.archive?.stats?.() ?? this.archive?.adCoverage(); }
  /** A saved recommendation is only a candidate. Refresh quantities, targets and prices before delivering it. */
  async refresh(user: UserProfile, recommendation: Recommendation): Promise<Recommendation | null> {
    const [own, partner, items] = await Promise.all([
      this.provider.inventory(user.robloxId, 0, user),
      this.provider.inventory(recommendation.ad.userId, 0, user), this.provider.items(),
    ]);
    const unverified = own.tradabilityError ?? partner.tradabilityError;
    if (unverified) throw new UserError(unverified);
    if ([own.fetchedAt, partner.fetchedAt, items.fetchedAt].some(at => Date.now() - at > 300_000))
      throw new UserError('Inventory verification became stale. The alert was not sent.');
    if (Date.now() - recommendation.ad.createdAt > user.preferences.maxAdAgeMinutes * 60_000) return null;
    const key = (c: Holding) => `${c.itemTarget?.itemType ?? 'Asset'}:${c.itemTarget?.targetId ?? c.assetId}`;
    const select = (wanted: Holding[], available: PricedCopy[]) => {
      const used = new Set<number | string>();
      const selected: PricedCopy[] = [];
      for (const expected of wanted) {
        const copy = available.find(c => c.assetId === expected.assetId && key(c) === key(expected) && !used.has(c.userAssetId));
        if (!copy) return null;
        used.add(copy.userAssetId); selected.push(copy);
      }
      return selected;
    };
    const give = select(recommendation.give, priced(own, items.data));
    const receive = select(recommendation.receive, priced(partner, items.data));
    if (!give || !receive) return null;
    const advertised = recommendation.ad.requesting.length > 0 && sameAssets(give, recommendation.ad.requesting);
    const evaluation = evaluate(give, receive, user.preferences, advertised);
    if (!evaluation.passes) return null;
    return { ...recommendation, ...evaluation, ownInventoryAt: own.fetchedAt, partnerInventoryAt: partner.fetchedAt, pricesAt: items.fetchedAt };
  }
  async search(user: UserProfile, preferences: Preferences = user.preferences, options: SearchOptions = {}): Promise<SearchResult> {
    if (this.active.has(user.discordId)) throw new UserError('A search is already running for you. Please wait for it to finish.');
    this.active.add(user.discordId);
    try { return await this.run(user, preferences, options); }
    finally { this.active.delete(user.discordId); }
  }
  private async run(user: UserProfile, p: Preferences, options: SearchOptions): Promise<SearchResult> {
    const [items, adSnapshot, inventory] = await Promise.all([this.provider.items(), this.provider.ads(), this.provider.inventory(user.robloxId, undefined, user)]);
    if (inventory.tradabilityError) throw new UserError(inventory.tradabilityError);
    let own = priced(inventory, items.data);
    // Downgrade: every chosen item must be giveable, and one copy each is all a single-item give can use.
    const giveOnly = options.giveOnly ?? [];
    const single = giveOnly.length > 0;
    if (single) {
      const missing = giveOnly.filter(id => !own.some(c => c.assetId === id));
      if (missing.length) throw new UserError(`You do not have an available, non-projected copy of ${missing.map(id => `**${items.data.get(id)?.name ?? `item ${id}`}**`).join(', ')} to give.`);
      own = [...new Map(own.filter(c => giveOnly.includes(c.assetId)).map(c => [c.assetId, c])).values()];
    }
    if (!own.length) throw new UserError('No verified tradable, non-projected items with supported Rolimons prices were found in this public inventory.');
    // "Affordable" without a typed range means the band this inventory can pay for; alerts get the same treatment.
    if (p.affordable && p.minReceiveValue === null && p.maxReceiveValue === null) {
      // Chosen give-aways are searched one at a time, so the band runs from the cheapest of them, not the best.
      const band = affordableRange(own, REALISTIC_GAIN_PCT);
      const cheapest = Math.min(...own.map(c => effectiveValue(c.item)));
      p = { ...p, ...band, ...(single && band ? { minReceiveValue: cheapest } : {}) };
    }
    const inBand = (ad: TradeAd) => {
      if (!p.affordable) return true;
      const values = ad.offering.map(id => effectiveValue(items.data.get(id)!));
      return (p.minReceiveValue === null || values.reduce((n, v) => n + v, 0) >= p.minReceiveValue) && (p.maxReceiveValue === null || Math.min(...values) <= p.maxReceiveValue);
    };
    // What this inventory can pay with: the cheapest single copy up to the four best together. Any exchange has to
    // pair one of those bundles with some subset of an ad, so an ad whose cheapest item is far beyond the best bundle,
    // or whose whole offer sits under the smallest, cannot produce one. Two multiplications rule it out before the
    // combinatorics, which is where nearly all the time goes.
    const ownValues = own.map(c => effectiveValue(c.item)).sort((a, b) => b - a);
    const largestBundle = single ? ownValues[0] ?? 0 : ownValues.slice(0, 4).reduce((n, v) => n + v, 0);
    const smallestBundle = ownValues[ownValues.length - 1] ?? 0;
    const reachable = (ad: TradeAd) => {
      let cheapest = Infinity, total = 0;
      for (const id of ad.offering) { const v = effectiveValue(items.data.get(id)!); if (v < cheapest) cheapest = v; total += v; }
      return cheapest <= largestBundle * 2 && total >= smallestBundle * 0.6;
    };
    const now = Date.now();
    // The live feed only covers the last few minutes; merge it with every archived ad inside the age filter.
    this.archive?.saveAds(adSnapshot.data);
    const archived = this.archive?.recentAds(p.maxAdAgeMinutes * 60_000, now) ?? [];
    const everything = [...new Map([...archived, ...adSnapshot.data].map(a => [a.id, a])).values()];
    // Rolimons reposts the same offer over and over — roughly two of every three archived ads are a repeat. Only the
    // newest copy of an identical offer is worth screening; the rest would produce the same recommendation and be
    // discarded downstream anyway, after paying the full price of working them out.
    const newest = new Map<string, TradeAd>();
    for (const a of everything) {
      const key = `${a.userId}:${[...a.offering].sort().join(',')}>${[...a.requesting].sort().join(',')}`;
      const seenBefore = newest.get(key);
      if (!seenBefore || a.createdAt > seenBefore.createdAt) newest.set(key, a);
    }
    const pool = [...newest.values()];
    const adsOfferingTarget = p.targetIds.length ? pool.filter(a => a.offering.some(id => p.targetIds.includes(id))).length : pool.length;
    const ads = pool.filter(a => a.userId !== user.robloxId && a.createdAt <= now + 60_000
      && now - a.createdAt <= p.maxAdAgeMinutes * 60_000 && a.offering.length && !a.offeringRobux && !a.requestingRobux
      && a.offering.every(id => items.data.has(id)) && (!p.targetIds.length || a.offering.some(id => p.targetIds.includes(id))) && inBand(a) && reachable(a));
    const built = outgoingBundles(own, ads); let bundles = built.bundles; const { truncated } = built;
    // Several chosen give-aways are separate candidates, never combined: only the single-item bundles stay, and an ad
    // that asks for exactly several of them is not a downgrade of any one of them.
    if (single) { const ones = bundles.bySize[1] ?? []; bundles = { all: ones, bySize: [[], ones] }; }
    const oneGive = (r: { give: unknown[] }) => !single || r.give.length === 1;
    const bySeller = new Map<number, { ads: TradeAd[]; score: number }>();
    // Price-screen every recent ad before spending requests on seller inventories.
    for (const ad of ads) {
      const advertised = ad.offering.map((assetId, i) => ({ assetId, userAssetId: -(i + 1), onHold: false, tradable: true, item: items.data.get(assetId)! }));
      const previews = propose(ad, own, advertised, bundles, p).filter(oneGive);
      if (!previews.length) continue;
      const existing = bySeller.get(ad.userId) ?? { ads: [], score: -Infinity };
      existing.ads.push(ad); existing.score = Math.max(existing.score, previews[0]!.score);
      bySeller.set(ad.userId, existing);
    }
    const sellers = [...bySeller.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, this.maxSellers);
    const recommendations: Recommendation[] = [];
    let skippedSellers = 0;
    const notes: string[] = [];
    // Seller inventories are independent of one another, so they are fetched together. The HTTP client still paces
    // requests to Roblox one at a time; asking concurrently only overlaps the waiting, which is most of the cost.
    type Verified = { candidate: { ads: TradeAd[] }; inventory: Inventory; error?: undefined } | { error: UserError; candidate?: undefined; inventory?: undefined };
    const verified = await Promise.all(sellers.map(async ([sellerId, candidate]): Promise<Verified> => {
      try {
        const inventory = await this.provider.inventory(sellerId, PARTNER_INVENTORY_MS, user);
        if (inventory.tradabilityError) throw new UserError(inventory.tradabilityError);
        return { candidate, inventory };
      }
      catch (error) {
        if (!(error instanceof UserError)) throw error;
        return { error };
      }
    }));
    for (const outcome of verified) {
      if (outcome.error) {
        skippedSellers++;
        if (!notes.includes(outcome.error.message)) notes.push(outcome.error.message);
        continue;
      }
      const partner = priced(outcome.inventory, items.data);
      for (const ad of outcome.candidate.ads) {
        for (const result of propose(ad, own, partner, bundles, p).filter(oneGive)) recommendations.push({ ...result,
          ownInventoryAt: inventory.fetchedAt, partnerInventoryAt: outcome.inventory.fetchedAt, pricesAt: items.fetchedAt });
      }
    }
    // Don't present snapshots that aged excessively during a slow/rate-limited scan.
    const finished = Date.now();
    if (finished - items.fetchedAt > 5 * 60_000 || finished - inventory.fetchedAt > 5 * 60_000)
      throw new UserError('The scan took too long and its prices or inventory became stale. Please retry.');
    const seen = new Set<string>();
    // Trades are banded by size against the user's best item first, whatever the caller ranks by: a neat percentage
    // on their cheapest copies is not a trade anyone wants. Inside a band, each trade is judged against what its own
    // shape is for — an upgrade that carries a real overpay, a downgrade that collects a real profit.
    const biggestOwned = own.reduce((n, c) => Math.max(n, effectiveValue(c.item)), 0);
    const within = options.rank ?? shapeDistance;
    const rank = (r: Evaluation) => sizeBand(r, biggestOwned) * 1000 + within(r);
    const ranked = recommendations.sort((a, b) => rank(a) - rank(b) || b.score - a.score).filter(r => {
      if (finished - r.partnerInventoryAt > 5 * 60_000 || finished - r.ad.createdAt > p.maxAdAgeMinutes * 60_000) return false;
      const key = recommendationKey(r);
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });
    const oldest = everything.reduce((min, a) => Math.min(min, a.createdAt), now);
    return { recommendations: ranked.slice(0, 60), adsScanned: everything.length, sellersChecked: sellers.length,
      skippedSellers, truncatedInventory: truncated, candidateSellers: bySeller.size, pricesAt: items.fetchedAt, notes: notes.slice(0, 2),
      coverageMinutes: Math.round((now - oldest) / 60_000), adsOfferingTarget };
  }
}

import { defaults, type Inventory, type Item, type TradeAd, type UserProfile } from '../src/domain.js';
import type { DataProvider } from '../src/providers.js';

export const item = (id: number, value: number, overrides: Partial<Item> = {}): Item => ({
  id, name: `Item ${id}`, acronym: `I${id}`, rap: value, value, demand: 2, trend: 2,
  projected: false, hyped: false, rare: false, ...overrides,
});
export const inventory = (userId: number, ids: number[], start = userId * 100): Inventory => ({
  userId, holdings: ids.map((assetId, i) => ({ assetId, userAssetId: start + i, onHold: false })), fetchedAt: Date.now(),
});
export const ad = (overrides: Partial<TradeAd> = {}): TradeAd => ({ id: 700, userId: 2, username: 'ExampleSeller', createdAt: Date.now(),
  offering: [30], requesting: [10, 20], tags: [], offeringRobux: 0, requestingRobux: 0, ...overrides });
export const profile = (): UserProfile => ({ discordId: '123', robloxId: 1, username: 'ExampleTrader', preferences: defaults(), alerts: false, alertError: null });
export function fixtureProvider(): DataProvider & { itemMap: Map<number, Item>; adList: TradeAd[]; inventories: Map<number, Inventory>; calls: number[] } {
  return {
    itemMap: new Map([item(10, 50), item(20, 50), item(30, 110), item(40, 45)].map(i => [i.id, i])),
    adList: [ad()], inventories: new Map([[1, inventory(1, [10, 20])], [2, inventory(2, [30])]]), calls: [],
    async items() { return { data: this.itemMap, fetchedAt: Date.now() }; },
    async ads() { return { data: this.adList, fetchedAt: Date.now() }; },
    async inventory(id) { this.calls.push(id); const inv = this.inventories.get(id); if (!inv) throw new Error('Missing fixture'); return inv; },
    async user(input) { return { id: Number(input), name: 'ExampleUser' }; },
  };
}

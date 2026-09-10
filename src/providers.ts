import { z } from 'zod';
import { Cache, HttpClient } from './http.js';
import { idSchema, UserError, type Inventory, type Item, type Snapshot, type TradeAd } from './domain.js';

const numeric = z.number().finite();
const itemRow = z.tuple([z.string(), z.string(), numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric]);
const itemResponse = z.object({ success: z.literal(true), items: z.record(z.string(), itemRow) });
const adSide = z.object({ items: z.array(idSchema).max(4).optional(), tags: z.array(z.number().int()).optional(), robux: z.number().nonnegative().optional() });
const adRow = z.tuple([idSchema, numeric, idSchema, z.string(), adSide, adSide]);
const adResponse = z.object({ success: z.literal(true), trade_ads: z.array(z.unknown()) });
const inventoryPage = z.object({
  nextPageCursor: z.string().nullable(),
  data: z.array(z.object({ assetId: idSchema, userAssetId: idSchema, isOnHold: z.boolean() })),
});

function validate<T>(schema: z.ZodType<T>, data: unknown, source: string): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new UserError(`${source} returned an unsupported data format. No guesses were made about the data.`);
  return parsed.data;
}

export function parseItems(data: unknown): Map<number, Item> {
  const response = validate(itemResponse, data, 'Rolimons items');
  const items = new Map<number, Item>();
  for (const [rawId, row] of Object.entries(response.items)) {
    const id = Number(rawId);
    if (!Number.isSafeInteger(id) || id <= 0 || row[2] < 0) continue;
    items.set(id, { id, name: row[0], acronym: row[1], rap: row[2], value: row[3] > 0 ? row[3] : null,
      demand: row[5], trend: row[6], projected: row[7] !== -1, hyped: row[8] !== -1, rare: row[9] !== -1 });
  }
  if (!items.size) throw new UserError('Rolimons returned no usable item prices.');
  return items;
}
export function parseAds(data: unknown): TradeAd[] {
  const response = validate(adResponse, data, 'Rolimons ads');
  const ads: TradeAd[] = [];
  for (const raw of response.trade_ads) {
    const parsed = adRow.safeParse(raw);
    if (!parsed.success) continue;
    const [id, timestamp, userId, username, offer, request] = parsed.data;
    ads.push({ id, createdAt: timestamp * 1000, userId, username, offering: offer.items ?? [],
      requesting: request.items ?? [], tags: request.tags ?? [], offeringRobux: offer.robux ?? 0, requestingRobux: request.robux ?? 0 });
  }
  if (response.trade_ads.length && !ads.length) throw new UserError('Rolimons trade ad format changed; no ads could be read.');
  return ads;
}

export interface DataProvider {
  items(): Promise<Snapshot<Map<number, Item>>>;
  ads(): Promise<Snapshot<TradeAd[]>>;
  inventory(userId: number): Promise<Inventory>;
  user(input: string): Promise<{ id: number; name: string }>;
  /** Avatar headshot CDN URL, or null when unavailable. Optional: fixtures and offline tools may omit it. */
  avatar?(userId: number): Promise<string | null>;
}
export class Providers implements DataProvider {
  private cache = new Cache();
  constructor(private http = new HttpClient()) {}
  items(): Promise<Snapshot<Map<number, Item>>> {
    return this.cache.get('items', 120_000, async () => ({
      data: parseItems(await this.http.json('https://api.rolimons.com/items/v1/itemdetails')), fetchedAt: Date.now(),
    }));
  }
  ads(): Promise<Snapshot<TradeAd[]>> {
    return this.cache.get('ads', 30_000, async () => ({
      data: parseAds(await this.http.json('https://api.rolimons.com/tradeads/v1/getrecentads')), fetchedAt: Date.now(),
    }));
  }
  inventory(userId: number): Promise<Inventory> {
    idSchema.parse(userId);
    return this.cache.get(`inventory:${userId}`, 60_000, async () => {
      const holdings: Inventory['holdings'] = [];
      const seenCursors = new Set<string>();
      const seenCopies = new Set<number>();
      let cursor: string | null = null;
      const started = Date.now();
      for (let page = 0; page < 100; page++) {
        const url = new URL(`https://inventory.roblox.com/v1/users/${userId}/assets/collectibles`);
        url.searchParams.set('limit', '100'); url.searchParams.set('sortOrder', 'Asc');
        if (cursor) url.searchParams.set('cursor', cursor);
        const data = validate(inventoryPage, await this.http.json(url.toString()), 'Roblox inventory');
        for (const entry of data.data) {
          if (seenCopies.has(entry.userAssetId)) throw new UserError('Inventory changed during pagination. Retry the search.');
          seenCopies.add(entry.userAssetId);
          holdings.push({ assetId: entry.assetId, userAssetId: entry.userAssetId, onHold: entry.isOnHold });
        }
        cursor = data.nextPageCursor;
        if (!cursor) return { userId, holdings, fetchedAt: started };
        if (seenCursors.has(cursor)) throw new UserError('Roblox repeated an inventory page; refusing an incomplete inventory.');
        seenCursors.add(cursor);
      }
      throw new UserError('Inventory exceeded 10,000 copies. Search stopped rather than using incomplete data.');
    });
  }
  avatar(userId: number): Promise<string | null> {
    idSchema.parse(userId);
    return this.cache.get(`avatar:${userId}`, 3_600_000, async () => {
      const schema = z.object({ data: z.array(z.object({ targetId: idSchema, state: z.string(), imageUrl: z.string().nullable().optional() })) });
      const response = schema.safeParse(await this.http.json(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userId}&size=150x150&format=Png&isCircular=false`));
      const entry = response.success ? response.data.data.find(d => d.targetId === userId) : undefined;
      return entry?.state === 'Completed' && entry.imageUrl?.startsWith('https://') ? entry.imageUrl : null;
    });
  }
  async user(input: string): Promise<{ id: number; name: string }> {
    const userSchema = z.object({ id: idSchema, name: z.string() });
    if (/^\d+$/.test(input)) {
      const id = validate(idSchema, Number(input), 'Roblox user ID');
      return validate(userSchema, await this.http.json(`https://users.roblox.com/v1/users/${id}`), 'Roblox user');
    }
    if (!/^[A-Za-z0-9_]{3,20}$/.test(input)) throw new UserError('Enter a Roblox username or numeric user ID.');
    const response = validate(z.object({ data: z.array(userSchema) }), await this.http.json('https://users.roblox.com/v1/usernames/users', {
      method: 'POST', body: JSON.stringify({ usernames: [input], excludeBannedUsers: true }),
    }), 'Roblox user');
    if (!response.data[0]) throw new UserError('That Roblox username was not found.');
    return response.data[0];
  }
}

export function resolveItem(input: string, items: Map<number, Item>): Item {
  const query = input.trim().toLowerCase();
  const direct = items.get(Number(query));
  if (direct) return direct;
  const exact = [...items.values()].filter(i => i.name.toLowerCase() === query || (i.acronym && i.acronym.toLowerCase() === query));
  if (exact.length === 1) return exact[0]!;
  const matches = exact.length ? exact : [...items.values()].filter(i => i.name.toLowerCase().includes(query));
  if (matches.length === 1) return matches[0]!;
  if (!matches.length) throw new UserError('No supported Rolimons item matched. Try a catalog item ID or acronym.');
  throw new UserError(`Several items matched; use an item ID: ${matches.slice(0, 5).map(i => `${i.name} (${i.id})`).join(', ')}`);
}

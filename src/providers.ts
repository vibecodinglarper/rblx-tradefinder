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
  data: z.array(z.object({ assetId: idSchema, userAssetId: idSchema, isOnHold: z.boolean(), name: z.string().optional(), recentAveragePrice: z.number().nullable().optional() })),
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

/**
 * The Rolimons trades page embeds `var trade_ads = [...]` with its full ad list (about 2,000 ads, which the page then
 * splits into 50 client-side pages of 40). Extracting that array is the same as reading every page.
 */
export function extractSiteAds(html: string): unknown {
  const match = /var\s+trade_ads\s*=\s*\[/.exec(html);
  if (!match) throw new UserError('Rolimons trades page layout changed; no ads could be read from it.');
  const start = match.index + match[0].length - 1;
  let depth = 0, inString = false, escaped = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i]!;
    if (inString) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') inString = false; continue; }
    if (c === '"') inString = true;
    else if (c === '[') depth++;
    else if (c === ']' && --depth === 0) {
      try { return { success: true, trade_ads: JSON.parse(html.slice(start, i + 1)) }; }
      catch { throw new UserError('Rolimons trades page contained unreadable ad data.'); }
    }
  }
  throw new UserError('Rolimons trades page ad data was truncated.');
}

export interface DataProvider {
  items(): Promise<Snapshot<Map<number, Item>>>;
  ads(): Promise<Snapshot<TradeAd[]>>;
  inventory(userId: number, maxAgeMs?: number): Promise<Inventory>;
  user(input: string): Promise<{ id: number; name: string }>;
  /** Avatar headshot CDN URL, or null when unavailable. Optional: fixtures and offline tools may omit it. */
  avatar?(userId: number): Promise<string | null>;
  /** Full-body character render CDN URL, or null when unavailable. Optional decoration. */
  character?(userId: number): Promise<string | null>;
  /** PNG bytes of item thumbnails keyed by asset ID; missing entries mean unavailable. Optional decoration. */
  thumbnails?(assetIds: number[]): Promise<Map<number, Buffer>>;
}
export class Providers implements DataProvider {
  private cache = new Cache();
  /** After the trades page refuses us (403/429), stop asking for a while; the API and archive carry on unaffected. */
  private siteBlockedUntil = 0;
  constructor(private http = new HttpClient()) {}
  items(): Promise<Snapshot<Map<number, Item>>> {
    return this.cache.get('items', 120_000, async () => ({
      data: parseItems(await this.http.json('https://api.rolimons.com/items/v1/itemdetails')), fetchedAt: Date.now(),
    }));
  }
  /** Live feed: the API's last ~3 minutes merged with every ad on the website's trade pages (~30 minutes). */
  ads(): Promise<Snapshot<TradeAd[]>> {
    return this.cache.get('ads', 30_000, async () => {
      const [api, site] = await Promise.all([
        this.http.json('https://api.rolimons.com/tradeads/v1/getrecentads').then(parseAds),
        this.siteAds().catch(error => { console.error('Rolimons trades page unavailable:', error instanceof Error ? error.message : 'Unknown error'); return [] as TradeAd[]; }),
      ]);
      return { data: [...new Map([...site, ...api].map(a => [a.id, a])).values()], fetchedAt: Date.now() };
    });
  }
  /** One page download yields all 50 pages of ads, so it is refreshed only every few minutes. */
  siteAds(): Promise<TradeAd[]> {
    if (this.siteBlockedUntil > Date.now()) return Promise.resolve([]);
    return this.cache.get('siteAds', 150_000, async () => {
      try { return parseAds(extractSiteAds(await this.http.text('https://www.rolimons.com/trades'))); }
      catch (error) {
        if (error instanceof UserError && /HTTP 403|rate limited|busy/.test(error.message)) this.siteBlockedUntil = Date.now() + 30 * 60_000;
        throw error;
      }
    });
  }
  /**
   * `maxAgeMs` is how stale a cached copy may be. The user's own inventory is read fresh so a trade is never proposed
   * on a copy they have just traded away; a prospective partner's may be held a little longer, since every
   * recommendation is re-checked against both inventories before it is acted on anyway.
   */
  inventory(userId: number, maxAgeMs = 60_000): Promise<Inventory> {
    idSchema.parse(userId);
    return this.cache.get(`inventory:${userId}`, maxAgeMs, async () => {
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
          holdings.push({ assetId: entry.assetId, userAssetId: entry.userAssetId, onHold: entry.isOnHold, name: entry.name, robloxRap: entry.recentAveragePrice ?? null });
        }
        cursor = data.nextPageCursor;
        if (!cursor) return { userId, holdings, fetchedAt: started };
        if (seenCursors.has(cursor)) throw new UserError('Roblox repeated an inventory page; refusing an incomplete inventory.');
        seenCursors.add(cursor);
      }
      throw new UserError('Inventory exceeded 10,000 copies. Search stopped rather than using incomplete data.');
    });
  }
  avatar(userId: number): Promise<string | null> { return this.userThumbnail(userId, 'avatar-headshot'); }
  character(userId: number): Promise<string | null> { return this.userThumbnail(userId, 'avatar'); }
  private userThumbnail(userId: number, kind: 'avatar-headshot' | 'avatar'): Promise<string | null> {
    idSchema.parse(userId);
    return this.cache.get(`${kind}:${userId}`, 3_600_000, async () => {
      const schema = z.object({ data: z.array(z.object({ targetId: idSchema, state: z.string(), imageUrl: z.string().nullable().optional() })) });
      const response = schema.safeParse(await this.http.json(`https://thumbnails.roblox.com/v1/users/${kind}?userIds=${userId}&size=150x150&format=Png&isCircular=false`));
      const entry = response.success ? response.data.data.find(d => d.targetId === userId) : undefined;
      return entry?.state === 'Completed' && entry.imageUrl?.startsWith('https://') ? entry.imageUrl : null;
    });
  }
  async thumbnails(assetIds: number[]): Promise<Map<number, Buffer>> {
    const unique = [...new Set(assetIds)].filter(id => idSchema.safeParse(id).success).slice(0, 100);
    const result = new Map<number, Buffer>();
    if (!unique.length) return result;
    const schema = z.object({ data: z.array(z.object({ targetId: idSchema, state: z.string(), imageUrl: z.string().nullable().optional() })) });
    // One batched lookup resolves CDN URLs; each image is then cached for an hour, so paging back is free.
    const urls = await this.cache.get(`thumbs:${unique.join(',')}`, 3_600_000, async () => {
      const response = schema.safeParse(await this.http.json(`https://thumbnails.roblox.com/v1/assets?assetIds=${unique.join(',')}&size=150x150&format=Png`).catch(() => null));
      const map = new Map<number, string>();
      for (const entry of response.success ? response.data.data : []) if (entry.state === 'Completed' && entry.imageUrl?.startsWith('https://')) map.set(entry.targetId, entry.imageUrl);
      return map;
    });
    await Promise.all([...urls].map(async ([id, url]) => {
      const bytes = await this.cache.get(`thumb:${id}`, 3_600_000, async () => { const b = await this.http.bytes(url); if (!b) throw new Error('unavailable'); return b; }).catch(() => null);
      if (bytes) result.set(id, bytes);
    }));
    return result;
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

/** Thrown when several items fit; `matches` (best first) lets the UI offer a pick list instead of an error. */
export class AmbiguousItemError extends UserError {
  constructor(readonly query: string, readonly matches: Item[]) {
    super(`Several items match "${query.slice(0, 40)}": ${matches.slice(0, 5).map(i => `${i.name}${i.acronym ? ` (${i.acronym})` : ''} · ${i.id}`).join(', ')}${matches.length > 5 ? ', …' : ''}. Type the full name, its Rolimons acronym or the Roblox item ID.`);
  }
}
const HOW_TO_NAME = 'Use the full item name, its Rolimons acronym (like STF or Valk) or the Roblox item ID.';
/** Lowercase letters and digits only, so apostrophes, hyphens and spacing never block a match. */
const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
const byValue = (a: Item, b: Item) => (b.value ?? b.rap) - (a.value ?? a.rap);
/**
 * Finds one item from a full name, Rolimons acronym, Roblox item ID, or a pasted Rolimons/Roblox item URL.
 * Exact matches win; otherwise a single prefix or substring match is accepted; anything else is reported as ambiguous.
 */
export function resolveItem(input: string, items: Map<number, Item>): Item {
  const raw = input.trim();
  if (!raw) throw new UserError(`Enter an item. ${HOW_TO_NAME}`);
  const fromUrl = /(?:rolimons\.com\/item|roblox\.com\/catalog|roblox\.com\/library|roblox\.com\/bundles)\/(\d+)/i.exec(raw)?.[1];
  const numeric = fromUrl ?? (/^\d+$/.test(raw) ? raw : null);
  if (numeric) {
    const direct = items.get(Number(numeric));
    if (direct) return direct;
    throw new UserError(`Item ID ${numeric} is not a Rolimons-tracked limited. ${HOW_TO_NAME}`);
  }
  const query = normalize(raw);
  if (!query) throw new UserError(`Enter an item. ${HOW_TO_NAME}`);
  const all = [...items.values()];
  const acronym = all.filter(i => i.acronym && normalize(i.acronym) === query);
  if (acronym.length === 1) return acronym[0]!;
  const exact = all.filter(i => normalize(i.name) === query || normalize(i.name) === `the${query}`);
  if (exact.length === 1) return exact[0]!;
  if (acronym.length + exact.length > 1) throw new AmbiguousItemError(raw, [...acronym, ...exact].sort(byValue).slice(0, 25));
  const starts = all.filter(i => normalize(i.name).startsWith(query) || normalize(i.name).startsWith(`the${query}`));
  if (starts.length === 1) return starts[0]!;
  const contains = starts.length ? starts : all.filter(i => normalize(i.name).includes(query));
  if (contains.length === 1) return contains[0]!;
  // A partial acronym ("rsf" for RSFS) is only ever a suggestion, never a silent match.
  const candidates = contains.length ? contains : all.filter(i => i.acronym && normalize(i.acronym).startsWith(query));
  if (!candidates.length) throw new UserError(`No Rolimons-tracked limited matched "${raw.slice(0, 40)}". ${HOW_TO_NAME}`);
  throw new AmbiguousItemError(raw, candidates.sort(byValue).slice(0, 25));
}

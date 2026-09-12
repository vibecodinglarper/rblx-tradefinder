import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpClient, Cache } from '../src/http.js';
import { AmbiguousItemError, extractSiteAds, parseAds, parseItems, Providers, resolveItem } from '../src/providers.js';
import { fixtureProvider } from './fixtures.js';

function http(responses: { status?: number; body: unknown; headers?: Record<string, string> }[]) {
  let count = 0; const urls: string[] = [];
  const client = new HttpClient((async (url: string | URL | Request) => {
    urls.push(String(url)); const r = responses[count++]; if (!r) throw new Error('Unexpected fetch');
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: r.headers });
  }) as typeof fetch, 0);
  return { client, urls, count: () => count };
}
const row = (assetId: number, userAssetId: number, isOnHold = false) => ({ assetId, userAssetId, isOnHold });
test('parses live Rolimons tuple layout, unassigned values, flags and repeated ad IDs', () => {
  const items = parseItems({ success: true, items: { '10': ['Hat', 'H', 123, -1, 123, -1, 2, -1, 1, -1] } });
  assert.equal(items.get(10)?.value, null); assert.equal(items.get(10)?.projected, false); assert.equal(items.get(10)?.hyped, true);
  const ads = parseAds({ success: true, trade_ads: [[1, 1700000000, 2, 'Trader', { items: [10, 10] }, { tags: [6] }]] });
  assert.deepEqual(ads[0]?.offering, [10, 10]); assert.deepEqual(ads[0]?.requesting, []); assert.equal(ads[0]?.createdAt, 1700000000000);
  assert.throws(() => parseItems({ success: false }));
  assert.throws(() => parseAds({ success: true, trade_ads: [['broken']] }));
});
test('pagination preserves distinct duplicate assets and encodes cursors', async () => {
  const mock = http([{ body: { nextPageCursor: 'a+b/c=', data: [row(10, 1)] } }, { body: { nextPageCursor: null, data: [row(10, 2, true)] } }]);
  const provider = new Providers(mock.client); const result = await provider.inventory(2);
  assert.equal(result.holdings.length, 2); assert.equal(result.holdings[1]?.onHold, true);
  assert.match(mock.urls[1]!, /cursor=a%2Bb%2Fc%3D/);
  await provider.inventory(2); assert.equal(mock.count(), 2);
});
test('refuses private inventories, repeated cursors, duplicate copies and missing hold information', async () => {
  await assert.rejects(new Providers(http([{ status: 403, body: {} }]).client).inventory(2), /private/);
  await assert.rejects(new Providers(http([{ body: { nextPageCursor: 'x', data: [row(10, 1)] } }, { body: { nextPageCursor: 'x', data: [row(10, 2)] } }]).client).inventory(2), /repeated/);
  await assert.rejects(new Providers(http([{ body: { nextPageCursor: 'x', data: [row(10, 1)] } }, { body: { nextPageCursor: null, data: [row(10, 1)] } }]).client).inventory(2), /changed/);
  await assert.rejects(new Providers(http([{ body: { nextPageCursor: null, data: [{ assetId: 10, userAssetId: 1 }] } }]).client).inventory(2), /unsupported/);
});
test('retries transient rate limits, but refuses long retry-after waits', async () => {
  const m = http([{ status: 429, headers: { 'retry-after': '0' }, body: {} }, { body: { success: true } }]);
  assert.deepEqual(await m.client.json('https://example.test/data'), { success: true }); assert.equal(m.count(), 2);
  const long = http([{ status: 429, headers: { 'retry-after': '120' }, body: {} }]);
  await assert.rejects(long.client.json('https://example.test/data'), /rate limited/); assert.equal(long.count(), 1);
  await assert.rejects(long.client.json('https://example.test/other'), /rate limited/); assert.equal(long.count(), 1);
});
test('cache coalesces concurrent loads and never caches failed requests', async () => {
  const cache = new Cache(); let loads = 0;
  const loader = async () => { loads++; return 42; };
  assert.deepEqual(await Promise.all([cache.get('a', 1000, loader), cache.get('a', 1000, loader)]), [42, 42]); assert.equal(loads, 1);
  await assert.rejects(cache.get('b', 1000, async () => { throw new Error('down'); }));
  assert.equal(await cache.get('b', 1000, loader), 42); assert.equal(loads, 2);
});
test('resolves item IDs and acronyms while reporting ambiguous searches', () => {
  const items = fixtureProvider().itemMap;
  assert.equal(resolveItem('I10', items).id, 10); assert.equal(resolveItem('30', items).id, 30);
  assert.throws(() => resolveItem('Item', items), /Several/); assert.throws(() => resolveItem('missing', items), /No Rolimons-tracked/);
});

test('avatar lookup returns the CDN headshot only when completed and https; failures degrade to null', async () => {
  const ok = http([{ body: { data: [{ targetId: 156, state: 'Completed', imageUrl: 'https://tr.rbxcdn.com/abc/150/150/AvatarHeadshot/Png/noFilter' }] } }]);
  assert.equal(await new Providers(ok.client).avatar(156), 'https://tr.rbxcdn.com/abc/150/150/AvatarHeadshot/Png/noFilter');
  assert.equal(await new Providers(http([{ body: { data: [{ targetId: 156, state: 'Pending', imageUrl: '' }] } }]).client).avatar(156), null);
  assert.equal(await new Providers(http([{ body: { data: [{ targetId: 156, state: 'Completed', imageUrl: 'http://insecure.example/x.png' }] } }]).client).avatar(156), null);
  assert.equal(await new Providers(http([{ body: { unexpected: true } }]).client).avatar(156), null);
});

test('trades page extraction reads the embedded ad array past nested brackets and bracketed strings', () => {
  const ads = [[94470531, 1789078344, 7636073273, 'Sigma]Holder[', { items: [21416138, 102887469225690] }, { tags: [3, 4, 5, 6] }],
    [94470530, 1789078300, 41377756, 'kp"b5', { items: [16477149823] }, { items: [1048037], tags: [3] }]];
  const html = `<html><script>var trade_ads_note = "use the API [please]"; var s = [1];\nvar trade_ads = ${JSON.stringify(ads)};\nvar other = [[2]];</script></html>`;
  const parsed = extractSiteAds(html) as { success: boolean; trade_ads: unknown[] };
  assert.equal(parsed.success, true); assert.deepEqual(parsed.trade_ads, ads);
  assert.throws(() => extractSiteAds('<html>nothing here</html>'), /layout changed/);
  assert.throws(() => extractSiteAds('var trade_ads = [[1, 2'), /truncated/);
});

test('a refused trades page backs off for 30 minutes while the API keeps feeding ads', async () => {
  const apiAds = { success: true, trade_ads: [[700, Math.floor(Date.now() / 1000), 2, 'Seller', { items: [30] }, { items: [10] }]] };
  let pageHits = 0;
  const fetcher = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('rolimons.com/trades')) { pageHits++; return new Response('forbidden', { status: 403 }); }
    return new Response(JSON.stringify(apiAds), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  const provider = new Providers(new HttpClient(fetcher, 0));
  assert.equal((await provider.ads()).data.length, 1); assert.equal(pageHits, 1);
  await assert.rejects(provider.siteAds(), /HTTP 403/).catch(() => undefined);
  assert.deepEqual(await provider.siteAds(), []); assert.equal(pageHits, 1, 'no retry while backed off');
});

test('items resolve from full names ignoring punctuation, acronyms, IDs and pasted URLs; partial names become pick lists', () => {
  const items = new Map([
    [1235488, { ...fixtureProvider().itemMap.get(10)!, id: 1235488, name: "Clockwork's Headphones", acronym: 'CWHP' }],
    [1172161, { ...fixtureProvider().itemMap.get(10)!, id: 1172161, name: 'The Bluesteel Bathelm', acronym: 'BBH' }],
    [1, { ...fixtureProvider().itemMap.get(10)!, id: 1, name: 'Red Sparkle Time Fedora', acronym: 'RSTF', value: 100 }],
    [2, { ...fixtureProvider().itemMap.get(10)!, id: 2, name: 'Sparkle Time Fedora', acronym: 'STF', value: 200 }],
  ]);
  assert.equal(resolveItem('clockworks headphones', items).id, 1235488);
  assert.equal(resolveItem('Clockwork’s Headphones', items).id, 1235488);
  assert.equal(resolveItem('blue steel bathelm', items).id, 1172161);
  assert.equal(resolveItem('cwhp', items).id, 1235488);
  assert.equal(resolveItem('https://www.rolimons.com/item/1172161', items).id, 1172161);
  assert.equal(resolveItem('https://www.roblox.com/catalog/1235488/Clockworks-Headphones', items).id, 1235488);
  assert.equal(resolveItem('sparkle time fedora', items).id, 2, 'an exact name beats a longer name containing it');
  assert.throws(() => resolveItem('fedora', items), (error: unknown) => error instanceof AmbiguousItemError && error.matches.map(i => i.id).join() === '2,1');
  assert.throws(() => resolveItem('rst', items), (error: unknown) => error instanceof AmbiguousItemError && error.matches.length === 1, 'partial acronym only suggests');
  assert.throws(() => resolveItem('https://www.rolimons.com/item/999', items), /not a Rolimons-tracked/);
  assert.throws(() => resolveItem('   ', items), /Enter an item/);
});

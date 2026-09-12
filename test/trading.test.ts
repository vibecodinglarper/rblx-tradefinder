import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MessageFlags, type ChatInputCommandInteraction, type MessageComponentInteraction, type ModalSubmitInteraction } from 'discord.js';
import { Store } from '../src/store.js';
import { RobloxTradesClient, TradingService, TradeVerificationRequired, parseChallenge, normalizeCookie, type TradeRequest } from '../src/trading.js';
import { SearchService } from '../src/search.js';
import { Bot } from '../src/bot.js';
import { RobloxThrottle } from '../src/roblox-throttle.js';
import { connectModal, tradeListMessage, verificationMessage, verificationModal } from '../src/presentation.js';
import { finderProvider, profile } from './fixtures.js';

const key = 'ab'.repeat(32);
const secret = '_|WARNING:-DO-NOT-SHARE-THIS.test-session-secret';
const json = (data: unknown, status = 200, headers?: Record<string, string>) => new Response(JSON.stringify(data), { status, headers });
const instance = (asset: number, id: string, held = false) => ({ collectibleItemInstanceId: id, itemTarget: { itemType: 'Asset', targetId: String(asset) }, isOnHold: held });
const item = (asset: number, ids: string[]) => ({ itemTarget: { itemType: 'Asset', targetId: String(asset) }, instances: ids.map(id => instance(asset, id)) });
function api() {
  let now = Date.now();
  const throttle = new RobloxThrottle({ now: () => now, sleep: async ms => { now += ms; } });
  const calls: { path: string; init: RequestInit }[] = [];
  const state = { identity: 1, eligible: true, allowed: true, posts: 0,
    send: (_body: TradeRequest, _init: RequestInit): Response | Promise<Response> => json({ tradeId: 901 }),
    verify: (_body: Record<string, unknown>, _init: RequestInit): Response => json({ verificationToken: 'verified-proof' }),
    continueChallenge: (_body: Record<string, unknown>): Response => json({ challengeId: 'outer-challenge', challengeType: '', challengeMetadata: '' }),
    inventory: (owner: number, _url: URL) => json({ userId: owner, items: owner === 1 ? [item(10, ['9223372036854775807']), item(20, ['sender-two'])] : [item(30, ['recipient-one'])], nextPageCursor: '' }),
  };
  const fetcher: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input)); calls.push({ path: url.pathname, init });
    assert.ok(['users.roblox.com', 'trades.roblox.com', 'twostepverification.roblox.com', 'apis.roblox.com'].includes(url.host));
    assert.equal(init.redirect, 'error');
    assert.equal(new Headers(init.headers).get('Cookie'), `.ROBLOSECURITY=${secret}`);
    if (url.pathname.endsWith('/challenges/authenticator/verify')) return state.verify(JSON.parse(String(init.body)), init);
    if (url.pathname === '/challenge/v1/continue') return state.continueChallenge(JSON.parse(String(init.body)));
    if (url.pathname === '/v1/users/authenticated') return json({ id: state.identity, name: 'ConnectedUser' });
    if (url.pathname === '/v2/users/me/can-trade') return json({ userId: state.identity, canTrade: state.eligible });
    if (url.pathname.endsWith('/can-trade-with')) return json({ userId: state.identity, targetUserId: 2, canTrade: state.allowed });
    if (url.pathname === '/v1/trades/metadata') return json({ maxItemsPerSide: 4 });
    if (url.pathname.endsWith('/tradableItems')) return state.inventory(Number(url.pathname.split('/')[3]), url);
    if (url.pathname === '/v2/trades/send') { state.posts++; return state.send(JSON.parse(String(init.body)), init); }
    throw new Error(`Unexpected test endpoint ${url.pathname}`);
  };
  return { fetcher, state, calls, throttle };
}
async function setup() {
  const store = new Store(':memory:', undefined, key), mock = api();
  const service = new TradingService(store, mock.fetcher, mock.throttle);
  await service.connect('123', secret);
  const recommendation = (await new SearchService(finderProvider()).search(profile())).recommendations[0]!;
  return { store, service, recommendation, ...mock };
}

test('connections persist encrypted, bind ciphertext to account and Discord ID, and delete on unlink', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'trade-sessions-')), path = join(dir, 'db.sqlite');
  let store = new Store(path, undefined, key);
  try {
    store.connect('123', { id: 1, name: 'Account' }, secret);
    store.close();
    assert.equal(readFileSync(path).includes(Buffer.from(secret)), false);
    store = new Store(path, undefined, key);
    assert.equal(store.session('123', 1), secret);
    assert.throws(() => store.session('123', 2), /connect/);
    const db = new DatabaseSync(path);
    db.prepare("UPDATE roblox_sessions SET discord_id = '456'").run(); db.close();
    assert.throws(() => store.session('456', 1), /cannot be read/);
    store.connect('123', { id: 1, name: 'Account' }, secret);
    store.link('123', 2, 'Other'); assert.throws(() => store.session('123', 1), /connect/);
    store.connect('123', { id: 1, name: 'Account' }, secret);
    store.disconnect('123'); assert.throws(() => store.session('123', 1), /connect/); assert.ok(store.get('123'));
    store.connect('123', { id: 1, name: 'Account' }, secret);
    store.forget('123'); assert.throws(() => store.session('123', 1), /connect/); assert.equal(store.get('123'), undefined);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('credentials require an encryption key and reject cookie/header injection without echoing input', async () => {
  const store = new Store(':memory:');
  try {
    const service = new TradingService(store, (() => { throw new Error('Should not request'); }) as typeof fetch);
    await assert.rejects(service.connect('123', secret), /ROBLOX_CREDENTIAL_KEY/);
    for (const value of ['', `${secret}; other=value`, `${secret}\r\nHeader: value`, `${secret} with spaces`]) {
      assert.throws(() => normalizeCookie(value), error => error instanceof Error && !error.message.includes(secret));
    }
    assert.equal(normalizeCookie(` .ROBLOSECURITY=${secret} `), secret);
    const modal = connectModal().toJSON(); assert.equal(modal.components.length, 1);
    assert.equal(JSON.stringify(modal).includes(secret), false);
  } finally { store.close(); }
});

test('send uses distinct fresh v2 IDs, zero Robux, and retries exactly one CSRF challenge', async () => {
  const { store, service, recommendation, state } = await setup();
  try {
    state.send = (body, init) => {
      assert.deepEqual(body, { senderOffer: { userId: 1, robux: 0, collectibleItemInstanceIds: ['9223372036854775807', 'sender-two'] }, recipientOffer: { userId: 2, robux: 0, collectibleItemInstanceIds: ['recipient-one'] } });
      if (state.posts === 1) return json({ errors: [{ code: 9001 }] }, 403, { 'x-csrf-token': 'fresh-csrf' });
      assert.equal(new Headers(init.headers).get('X-CSRF-TOKEN'), 'fresh-csrf'); return json({ tradeId: 902 });
    };
    assert.equal(await service.place(store.get('123')!, recommendation), 902); assert.equal(state.posts, 2);
    await assert.rejects(service.place(store.get('123')!, recommendation), /already sent/); assert.equal(state.posts, 2);
  } finally { store.close(); }
});

test('inventory pagination preserves duplicate quantities, skips held copies and never uses asset IDs', async () => {
  const { fetcher, state, throttle } = api();
  state.inventory = (owner, url) => json({ userId: owner, items: [{ ...item(10, url.searchParams.has('cursor') ? ['free-2'] : ['free-1']), instances: [instance(10, 'held', true), instance(10, url.searchParams.has('cursor') ? 'free-2' : 'free-1')] }], nextPageCursor: url.searchParams.has('cursor') ? '' : 'next' });
  const client = new RobloxTradesClient(secret, fetcher, Date.now() + 120_000, throttle);
  assert.deepEqual(await client.instances(1, [10, 10]), ['free-1', 'free-2']);
  await assert.rejects(client.instances(1, [10, 10, 10]), /unavailable or on hold/);
  state.inventory = owner => json({ userId: owner, items: [], nextPageCursor: 'repeated' });
  await assert.rejects(client.instances(1, [10]), /repeated/);
});

test('expired verification stops before any network request, and repeated CSRF failures stop after one retry', async () => {
  const { store, service, recommendation, state, calls } = await setup();
  try {
    const before = calls.length;
    await assert.rejects(service.place(store.get('123')!, recommendation, Date.now() - 1), /expired/);
    assert.equal(calls.length, before);
    state.send = () => json({ errors: [{ code: 9001 }] }, 403, { 'x-csrf-token': 'still-rejected' });
    await assert.rejects(service.place(store.get('123')!, recommendation), /denied/);
    assert.equal(state.posts, 2);
  } finally { store.close(); }
});

test('identity, eligibility, availability and item limits block sending', async () => {
  const { store, service, recommendation, state } = await setup();
  try {
    state.identity = 99; await assert.rejects(service.place(store.get('123')!, recommendation), /does not match/);
    state.identity = 1; state.eligible = false; await assert.rejects(service.place(store.get('123')!, recommendation), /cannot trade/);
    state.eligible = true; state.allowed = false; await assert.rejects(service.place(store.get('123')!, recommendation), /does not allow/);
    state.allowed = true;
    await assert.rejects(service.place(store.get('123')!, { ...recommendation, give: Array(5).fill(recommendation.give[0]) }), /item limits/);
    await assert.rejects(service.place(store.get('123')!, { ...recommendation, ad: { ...recommendation.ad, requestingRobux: 1 } }), /Robux/);
    state.inventory = owner => json({ userId: owner, items: [], nextPageCursor: '' });
    await assert.rejects(service.place(store.get('123')!, recommendation), /unavailable/);
    assert.equal(state.posts, 0);
  } finally { store.close(); }
});

for (const outcome of ['network', 'server', 'malformed', 'missing-id'] as const) {
  test(`uncertain ${outcome} send is never retried, even through a new service`, async () => {
    const { store, service, recommendation, state, fetcher, throttle } = await setup();
    try {
      state.send = () => {
        if (outcome === 'network') throw new Error(secret);
        if (outcome === 'server') return json({ errors: [{ message: secret }] }, 503);
        if (outcome === 'malformed') return new Response('not-json');
        return json({});
      };
      await assert.rejects(service.place(store.get('123')!, recommendation), error => error instanceof Error && !error.message.includes(secret));
      await assert.rejects(new TradingService(store, fetcher, throttle).place(store.get('123')!, recommendation), /may already have been sent/);
      assert.equal(state.posts, 1);
    } finally { store.close(); }
  });
}

test('definite rejection allows a later explicit click, but challenge and rate limits have no automatic retries', async () => {
  const { store, service, recommendation, state } = await setup();
  try {
    state.send = () => json({ errors: [{ code: 23, message: secret }] }, 403, { 'rblx-challenge-id': 'challenge', 'x-csrf-token': 'csrf' });
    await assert.rejects(service.place(store.get('123')!, recommendation), /verify this trade/); assert.equal(state.posts, 1);
    state.send = () => json({ errors: [{ message: secret }] }, 429);
    await assert.rejects(service.place(store.get('123')!, recommendation), /rate limiting/); assert.equal(state.posts, 2);
    state.send = () => json({ tradeId: 903 });
    assert.equal(await service.place(store.get('123')!, recommendation), 903); assert.equal(state.posts, 3);
  } finally { store.close(); }
});

test('expired sessions are removed and sanitized, and failed connections preserve the previous account', async () => {
  const { store, service, recommendation, state, fetcher, throttle } = await setup();
  try {
    const rejected = new TradingService(store, (async () => json({ errors: [{ message: secret }] }, 401)) as typeof fetch);
    await assert.rejects(rejected.connect('123', 'invalid-session'), /expired or was rejected/); assert.equal(store.session('123', 1), secret);
    await assert.rejects(rejected.place(store.get('123')!, recommendation), /expired or was rejected/); assert.throws(() => store.session('123', 1), /connect/);
    state.eligible = false; await assert.rejects(new TradingService(store, fetcher, throttle).connect('123', secret), /cannot trade/);
    assert.equal(store.get('123')!.robloxId, 1); assert.equal(state.posts, 0);
  } finally { store.close(); }
});

test('send receipts survive process restarts and simultaneous duplicate attempts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'trade-receipts-')), path = join(dir, 'db.sqlite');
  const first = new Store(path, undefined, key), second = new Store(path, undefined, key);
  try {
    first.claimTrade('pending'); assert.throws(() => second.claimTrade('pending'), /may already/);
    first.claimTrade('sent'); first.finishTrade('sent', 904); assert.throws(() => second.claimTrade('sent'), /904/);
  } finally { first.close(); second.close(); }
  const reopened = new Store(path, undefined, key);
  try { assert.throws(() => reopened.claimTrade('pending'), /may already/); assert.throws(() => reopened.claimTrade('sent'), /904/); }
  finally { reopened.close(); rmSync(dir, { recursive: true, force: true }); }
});

function interaction(customId: string, fields?: Record<string, string>, discordId = '123') {
  const calls: { method: string; body?: unknown }[] = [];
  const fake = { user: { id: discordId }, customId, deferred: false, replied: false, message: { flags: { has: () => true } },
    fields: { getTextInputValue: (key: string) => fields?.[key] ?? '' }, isModalSubmit: () => Boolean(fields), isStringSelectMenu: () => false, isFromMessage: () => false,
    async deferReply(body: unknown) { this.deferred = true; calls.push({ method: 'deferReply', body }); },
    async deferUpdate() { this.deferred = true; }, async editReply(body: unknown) { calls.push({ method: 'editReply', body }); },
    async reply(body: unknown) { this.replied = true; calls.push({ method: 'reply', body }); },
    async showModal(body: unknown) { this.replied = true; calls.push({ method: 'showModal', body }); },
  };
  return { fake, calls, i: fake as unknown as MessageComponentInteraction | ModalSubmitInteraction };
}

test('Discord connect → find → Place Trade is private, bound to the search/account and rejects repeated or foreign clicks', async () => {
  const store = new Store(':memory:', undefined, key), mock = api(), search = new SearchService(finderProvider());
  const bot = new Bot(store, search, 60, new TradingService(store, mock.fetcher, mock.throttle));
  try {
    const command = interaction(''); Object.assign(command.fake, { commandName: 'connect' });
    await bot.handle(command.fake as unknown as ChatInputCommandInteraction); assert.equal(command.calls[0]?.method, 'showModal');
    const connect = interaction('tf:connect', { cookie: secret }); await bot.component(connect.i);
    assert.equal(store.get('123')?.robloxId, 1);
    assert.deepEqual(connect.calls[0], { method: 'deferReply', body: { flags: MessageFlags.Ephemeral } });
    assert.equal(JSON.stringify(connect.calls).includes(secret), false);
    const alias = interaction(''); Object.assign(alias.fake, { commandName: 'find', options: { getSubcommand: () => 'trades' } });
    await bot.handle(alias.fake as unknown as ChatInputCommandInteraction); assert.equal(alias.calls.length, 0, 'the removed /find trades command is ignored');
    const finder = interaction(''); Object.assign(finder.fake, { commandName: 'trade', options: { getSubcommand: () => 'find' } });
    await bot.handle(finder.fake as unknown as ChatInputCommandInteraction); assert.match(JSON.stringify(finder.calls), /Find trades/);
    const find = interaction('tf:find:upgrade:u:3'); await bot.component(find.i);
    const output = JSON.stringify(find.calls); const placeId = output.match(/tf:place:[a-f0-9]+:0/)?.[0]; assert.ok(placeId);
    const wrong = interaction(placeId, undefined, '456'); store.link('456', 1, 'OtherDiscord'); await bot.component(wrong.i);
    assert.match(JSON.stringify(wrong.calls), /belongs to another search/); assert.equal(mock.state.posts, 0);
    const tampered = interaction(placeId.replace(/:0$/, ':999')); await bot.component(tampered.i); assert.equal(mock.state.posts, 0);
    const inventory = mock.state.inventory;
    let throttled = false;
    mock.state.inventory = (owner, url) => {
      if (!throttled) { throttled = true; return json({}, 429, { 'retry-after': '5' }); }
      return inventory(owner, url);
    };
    const place = interaction(placeId); await bot.component(place.i);
    assert.deepEqual(place.calls[0], { method: 'deferReply', body: { flags: MessageFlags.Ephemeral } });
    assert.match(JSON.stringify(place.calls), /Outbound trade sent/); assert.equal(mock.state.posts, 1);
    assert.match(JSON.stringify(place.calls), /continue automatically/);
    assert.equal((place.calls.at(-1)?.body as { content: string }).content, '', 'success clears the temporary wait notice');
    const again = interaction(placeId); await bot.component(again.i); assert.match(JSON.stringify(again.calls), /already sent/); assert.equal(mock.state.posts, 1);
    bot['lastSearch'].clear(); await bot.component(interaction('tf:find:upgrade:u:3').i);
    const stale = interaction(placeId); await bot.component(stale.i); assert.match(JSON.stringify(stale.calls), /expired/);
    const cached = bot['results'].get('123')!; cached.at -= 16 * 60_000;
    const expired = interaction(`tf:place:${cached.token}:0`); await bot.component(expired.i); assert.match(JSON.stringify(expired.calls), /expired/);
    cached.at = Date.now(); store.link('123', 2, 'NewAccount');
    const switched = interaction(`tf:place:${cached.token}:0`); await bot.component(switched.i); assert.match(JSON.stringify(switched.calls), /expired/); assert.equal(mock.state.posts, 1);
    const disconnect = interaction(''); Object.assign(disconnect.fake, { commandName: 'disconnect' });
    await bot.handle(disconnect.fake as unknown as ChatInputCommandInteraction); assert.match(JSON.stringify(disconnect.calls), /session removed/);
  } finally { store.close(); }
});

test('result rows with Place Trade stay within Discord limits', async () => {
  const result = await new SearchService(finderProvider()).search(profile());
  const first = result.recommendations[0]!;
  result.recommendations = Array.from({ length: 8 }, (_, index) => ({ ...first, ad: { ...first.ad, userId: index + 2 } }));
  const panel = tradeListMessage(result, { mode: 'upgrade', targetIds: [30], results: 3 }, undefined, 0, undefined, undefined, 'a'.repeat(32));
  assert.ok(panel.components.length <= 5);
  const rows = panel.components.map(row => row.toJSON());
  assert.equal(rows.flatMap(r => r.components).filter(c => 'custom_id' in c && c.custom_id.startsWith('tf:place:')).length, 5);
  for (const row of rows) { assert.ok(row.components.length <= 5); for (const c of row.components) if ('custom_id' in c) assert.ok(c.custom_id.length <= 100); }
});

function challengeResponse(overrides: Record<string, unknown> = {}, kind = 'twostepverification') {
  return json({}, 403, { 'rblx-challenge-id': 'outer-challenge', 'rblx-challenge-type': kind,
    'rblx-challenge-metadata': Buffer.from(JSON.stringify({ userId: '1', challengeId: 'inner-challenge', actionType: 'Generic', ...overrides })).toString('base64') });
}
async function challenge(setupResult: Awaited<ReturnType<typeof setup>>) {
  const { service, state, store, recommendation } = setupResult;
  state.send = () => challengeResponse();
  try { await service.place(store.get('123')!, recommendation, Date.now() + 300_000); assert.fail('Must request verification'); }
  catch (error) { assert.ok(error instanceof TradeVerificationRequired); assert.ok(error.token); return error; }
}

test('authenticator verification continues the issued challenge, rechecks the offer and sends with proof only after user input', async () => {
  const fixture = await setup(); const { store, service, state, calls } = fixture;
  try {
    const required = await challenge(fixture);
    assert.equal(calls.some(c => c.path.endsWith('/authenticator/verify')), false);
    let verifications = 0;
    state.verify = (body, init) => {
      verifications++;
      assert.deepEqual(body, { challengeId: 'inner-challenge', actionType: 7, code: '012345' });
      if (verifications === 1) return json({}, 403, { 'x-csrf-token': 'verify-csrf' });
      assert.equal(new Headers(init.headers).get('X-CSRF-TOKEN'), 'verify-csrf');
      return json({ verificationToken: 'verified-proof' });
    };
    state.continueChallenge = body => {
      assert.equal(body.challengeId, 'outer-challenge'); assert.equal(body.challengeType, 'twostepverification');
      assert.deepEqual(JSON.parse(String(body.challengeMetadata)), { verificationToken: 'verified-proof', rememberDevice: false, challengeId: 'inner-challenge' });
      return json({ challengeType: '' });
    };
    state.send = (_body, init) => {
      const headers = new Headers(init.headers);
      assert.equal(headers.get('rblx-challenge-id'), 'outer-challenge');
      assert.equal(headers.get('rblx-challenge-type'), 'twostepverification');
      assert.deepEqual(JSON.parse(Buffer.from(headers.get('rblx-challenge-metadata')!, 'base64').toString()), { verificationToken: 'verified-proof', rememberDevice: false, challengeId: 'inner-challenge' });
      return json({ tradeId: 905 });
    };
    const before = calls.length;
    assert.equal(await service.verifyAndPlace('123', required.token!, '012345'), 905);
    assert.equal(state.posts, 2, 'initial rejected send and one verified send');
    assert.ok(calls.slice(before).some(c => c.path === '/v1/users/authenticated'));
    assert.equal(calls.slice(before).filter(c => c.path.endsWith('/tradableItems')).length, 2);
    await assert.rejects(service.verifyAndPlace('123', required.token!, '012345'), /expired/);
    const panel = verificationMessage(required);
    assert.equal(JSON.stringify(panel).includes('inner-challenge'), false);
    assert.equal(JSON.stringify(panel).includes('verified-proof'), false);
    assert.equal(verificationModal(required.token!).toJSON().components.length, 1);
  } finally { store.close(); }
});

test('invalid authenticator codes allow a bounded manual retry and never submit a trade', async () => {
  const fixture = await setup(); const { store, service, state, calls } = fixture;
  try {
    const required = await challenge(fixture);
    const before = calls.length;
    await assert.rejects(service.verifyAndPlace('123', required.token!, 'not-a-code'), /six-digit/);
    assert.equal(calls.length, before);
    state.verify = () => json({ errors: [{ code: 10, message: '012345 secret' }] }, 400);
    for (let i = 0; i < 3; i++) await assert.rejects(service.verifyAndPlace('123', required.token!, '012345'), error => error instanceof Error && /code was rejected/.test(error.message) && !error.message.includes('012345'));
    await assert.rejects(service.verifyAndPlace('123', required.token!, '012345'), /expired/);
    assert.equal(state.posts, 1);
    assert.equal(calls.some(c => c.path === '/challenge/v1/continue'), false);
  } finally { store.close(); }
});

test('verification is bound to Discord user, session, Roblox account and expiry; cancellation invalidates it', async () => {
  const fixture = await setup(); const { store, service, state } = fixture;
  try {
    const required = await challenge(fixture);
    store.connect('456', { id: 1, name: 'Other' }, secret);
    await assert.rejects(service.verifyAndPlace('456', required.token!, '012345'), /expired/);
    await assert.rejects(service.verifyAndPlace('123', 'wrong-token', '012345'), /expired/);
    store.connect('123', { id: 1, name: 'Same' }, 'replacement-session');
    await assert.rejects(service.verifyAndPlace('123', required.token!, '012345'), /connection changed/);
    store.connect('123', { id: 1, name: 'Same' }, secret);
    service['pending'].get('123')!.expiresAt = Date.now() - 1;
    await assert.rejects(service.verifyAndPlace('123', required.token!, '012345'), /expired/);
    const fresh = await challenge(fixture); service.cancelVerification('123');
    await assert.rejects(service.verifyAndPlace('123', fresh.token!, '012345'), /expired/);
    const other = await challenge(fixture); store.link('123', 2, 'Switched');
    await assert.rejects(service.verifyAndPlace('123', other.token!, '012345'), /expired/);
    assert.equal(state.posts, 3);
  } finally { store.close(); }
});

for (const failure of ['unavailable-item', 'continue-failed', 'continue-next-challenge', 'verify-rate-limit', 'send-timeout'] as const) {
  test(`verification ${failure} cannot silently send or duplicate a trade`, async () => {
    const fixture = await setup(); const { store, service, state, calls } = fixture;
    try {
      const required = await challenge(fixture);
      state.send = () => { if (failure === 'send-timeout') throw new Error('secret'); assert.fail('Should not reach send'); };
      if (failure === 'unavailable-item') state.inventory = owner => json({ userId: owner, items: [], nextPageCursor: '' });
      if (failure === 'continue-failed') state.continueChallenge = () => json({}, 400);
      if (failure === 'continue-next-challenge') state.continueChallenge = () => json({ challengeType: 'captcha' });
      if (failure === 'verify-rate-limit') state.verify = () => json({}, 429, { 'retry-after': '10' });
      await assert.rejects(service.verifyAndPlace('123', required.token!, '012345'));
      assert.equal(state.posts, failure === 'send-timeout' ? 2 : 1);
      if (failure === 'verify-rate-limit') assert.equal(calls.filter(c => c.path.endsWith('/authenticator/verify')).length, 1);
      await assert.rejects(service.verifyAndPlace('123', required.token!, '012345'), /expired/);
      if (failure === 'send-timeout') await assert.rejects(service.place(store.get('123')!, fixture.recommendation), /may already have been sent/);
    } finally { store.close(); }
  });
}

test('unsupported, malformed and wrong-account challenges only offer the Roblox browser flow', async () => {
  const fixture = await setup(); const { store, service, state, recommendation } = fixture;
  try {
    for (const response of [challengeResponse({}, 'captcha'), challengeResponse({ actionType: 'Login' }), challengeResponse({ userId: '2' }),
      json({}, 403, { 'rblx-challenge-type': 'twostepverification', 'rblx-challenge-metadata': 'not-json' })]) {
      state.send = () => response;
      await assert.rejects(service.place(store.get('123')!, recommendation), error => {
        assert.ok(error instanceof TradeVerificationRequired); assert.equal(error.token, undefined);
        const panel = JSON.stringify(verificationMessage(error));
        assert.match(panel, /Complete trade on Roblox/); assert.doesNotMatch(panel, /verifymodal/); return true;
      });
    }
    assert.equal(parseChallenge(challengeResponse({ actionType: 'PasswordReset' }).headers).details, undefined);
    assert.equal(service['pending'].size, 0);
  } finally { store.close(); }
});

test('Discord shows a private verification panel and code modal, then sends the reviewed offer', async () => {
  const store = new Store(':memory:', undefined, key), mock = api(), service = new TradingService(store, mock.fetcher, mock.throttle);
  const bot = new Bot(store, new SearchService(finderProvider()), 60, service);
  try {
    await service.connect('123', secret);
    const find = interaction('tf:find:upgrade:u:3'); await bot.component(find.i);
    const placeId = JSON.stringify(find.calls).match(/tf:place:[a-f0-9]+:0/)![0];
    mock.state.send = () => challengeResponse();
    const place = interaction(placeId); await bot.component(place.i);
    const panel = JSON.stringify(place.calls); assert.match(panel, /Verify this trade/);
    assert.equal(place.calls[0]?.method, 'deferReply');
    const modalId = panel.match(/tf:verifymodal:[a-f0-9]+/)![0];
    const modal = interaction(modalId); await bot.component(modal.i); assert.equal(modal.calls[0]?.method, 'showModal');
    const submitId = modalId.replace('verifymodal', 'verify');
    mock.state.send = () => json({ tradeId: 906 });
    const submit = interaction(submitId, { code: '012345' }); await bot.component(submit.i);
    assert.deepEqual(submit.calls[0], { method: 'deferReply', body: { flags: MessageFlags.Ephemeral } });
    assert.match(JSON.stringify(submit.calls), /Outbound trade sent/);
    assert.equal(JSON.stringify(submit.calls).includes('012345'), false);
    assert.equal(mock.state.posts, 2);
  } finally { store.close(); }
});

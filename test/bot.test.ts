import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChatInputCommandInteraction } from 'discord.js';
import { Bot } from '../src/bot.js';
import { Store } from '../src/store.js';
import { SearchService } from '../src/search.js';
import { fixtureProvider, profile } from './fixtures.js';

function interaction(sub: string, values: Record<string, string | number | boolean> = {}) {
  const replies: unknown[] = [], followups: unknown[] = [];
  const fake = {
    commandName: 'trade', user: { id: '123' }, deferred: false, replied: false,
    options: {
      getSubcommand: () => sub,
      getString: (key: string) => values[key] ?? null,
      getNumber: (key: string) => values[key] ?? null,
      getInteger: (key: string) => values[key] ?? null,
      getBoolean: (key: string) => values[key] ?? null,
    },
    async deferReply() { this.deferred = true; },
    async editReply(body: unknown) { replies.push(body); },
    async followUp(body: unknown) { followups.push(body); },
    async reply(body: unknown) { replies.push(body); },
  };
  return { i: fake as unknown as ChatInputCommandInteraction, replies, followups };
}
test('Discord link → settings → watch → find persists input and returns an explained recommendation', async () => {
  const store = new Store(':memory:'), bot = new Bot(store, new SearchService(fixtureProvider()));
  for (const [sub, values] of [
    ['link', { user: '1' }], ['settings', { mode: 'upgrade', min_value_gain: 0, exclude_projected: true }], ['watch', { item: '30' }],
  ] as [string, Record<string, string | number | boolean>][]) {
    await bot.handle(interaction(sub, values).i);
  }
  assert.equal(store.get('123')?.preferences.mode, 'upgrade'); assert.deepEqual(store.get('123')?.preferences.targetIds, [30]);
  const find = interaction('find', { results: 1 }); await bot.handle(find.i);
  assert.match(JSON.stringify(find.replies[0]), /1 qualifying/); assert.equal(find.followups.length, 1);
  assert.match(JSON.stringify(find.followups), /Exact advertised/);
  store.close();
});
test('Discord inventory returns CSV, locks prevent outgoing recommendations and forget removes profile', async () => {
  const store = new Store(':memory:'); store.save(profile()); const bot = new Bot(store, new SearchService(fixtureProvider()));
  const inv = interaction('inventory'); await bot.handle(inv.i);
  assert.ok(typeof inv.replies[0] === 'object' && inv.replies[0] && 'files' in inv.replies[0]);
  await bot.handle(interaction('lock', { item: '10' }).i);
  const find = interaction('find'); await bot.handle(find.i);
  assert.match(JSON.stringify(find.replies[0]), /No qualifying/); assert.equal(find.followups.length, 0);
  await bot.handle(interaction('forget').i); assert.equal(store.get('123'), undefined); store.close();
});
test('Discord analyze returns calculations and reports missing copies without fabricated recommendations', async () => {
  for (const [give, valid] of [['10,20', true], ['10,10', false]] as const) {
    const store = new Store(':memory:'); store.save(profile()); const bot = new Bot(store, new SearchService(fixtureProvider()));
    const analyze = interaction('analyze', { partner: '2', give, receive: '30' }); await bot.handle(analyze.i);
    if (valid) assert.match(JSON.stringify(analyze.replies), /110 received − 100 given/);
    else assert.match(JSON.stringify(analyze.replies), /lacks enough available copies/);
    store.close();
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChatInputCommandInteraction, MessageComponentInteraction, ModalSubmitInteraction } from 'discord.js';
import { Bot } from '../src/bot.js';
import { Store } from '../src/store.js';
import { SearchService } from '../src/search.js';
import { ids } from '../src/presentation.js';
import { finderProvider, fixtureProvider, profile } from './fixtures.js';

/** Slash commands are flat and take no options: each one opens a panel or a form. */
function interaction(name: string) {
  const replies: unknown[] = [], followups: unknown[] = [], modals: unknown[] = [];
  const fake = {
    commandName: name, user: { id: '123' }, deferred: false, replied: false,
    async deferReply() { this.deferred = true; },
    async editReply(body: unknown) { replies.push(body); },
    async followUp(body: unknown) { followups.push(body); },
    async reply(body: unknown) { this.replied = true; replies.push(body); },
    async showModal(body: unknown) { this.replied = true; modals.push(body); },
  };
  return { i: fake as unknown as ChatInputCommandInteraction, replies, followups, modals };
}
/** A submitted form or clicked component, as the panels produce them. */
function submit(customId: string, fields: Record<string, string> = {}, values: string[] = []) {
  const replies: unknown[] = [], followups: unknown[] = [];
  const fake = {
    customId, user: { id: '123' }, deferred: false, replied: false, values, message: { flags: { has: () => true } },
    fields: { getTextInputValue: (key: string) => fields[key] ?? '' },
    isModalSubmit: () => Object.keys(fields).length > 0, isButton: () => !values.length && !Object.keys(fields).length, isStringSelectMenu: () => values.length > 0,
    isFromMessage: () => false,
    async deferUpdate() { this.deferred = true; }, async deferReply() { this.deferred = true; },
    async editReply(body: unknown) { replies.push(body); }, async followUp(body: unknown) { followups.push(body); },
    async reply(body: unknown) { this.replied = true; replies.push(body); },
  };
  return { i: fake as unknown as MessageComponentInteraction | ModalSubmitInteraction, replies, followups };
}
test('Discord link → settings → watch → find persists input and returns an explained recommendation', async () => {
  const store = new Store(':memory:'), bot = new Bot(store, new SearchService(finderProvider()));
  const link = interaction('link'); await bot.handle(link.i); assert.equal(link.modals.length, 1); assert.equal(link.replies.length, 0);
  await bot.component(submit(ids.build('link'), { user: '1' }).i);
  assert.equal(store.get('123')?.robloxId, 1);
  const profit = interaction('profit'); await bot.handle(profit.i); assert.match(JSON.stringify(profit.replies[0]), /tf:filtersmodal/);
  const settings = interaction('settings'); await bot.handle(settings.i); assert.match(JSON.stringify(settings.replies[0]), /tf:view:alerts/);
  const watch = interaction('watch'); await bot.handle(watch.i); assert.match(JSON.stringify(watch.replies[0]), /tf:watchmodal/);
  await bot.component(submit(ids.build('addwatch'), { item: '30' }).i);
  assert.deepEqual(store.get('123')?.preferences.targetIds, [30]);
  const panel = interaction('trade'); await bot.handle(panel.i);
  assert.match(JSON.stringify(panel.replies[0]), /Find trades/); assert.equal(panel.followups.length, 0);
  const find = submit(ids.build('find', '-', '-', 1)); await bot.component(find.i);
  assert.match(JSON.stringify(find.replies[0]), /1 person you can trade with/); assert.equal(find.followups.length, 0, 'results are one list, not a card per trade');
  assert.match(JSON.stringify(find.replies[0]), /"url":"https:\/\/www\.roblox\.com\/users\/2\/trade#tradefinder\?give=10,20&get=30"/, 'the trade button carries the exact items for a browser extension to pre-fill');
  assert.match(JSON.stringify(find.replies[0]), /"name":"trade-1\.png"/, 'each listed trade has a rendered card');
  assert.doesNotMatch(JSON.stringify(find.replies[0]), /tf:tld/, 'no details dropdown; the numbered Trade with buttons are the whole list');
  store.close();
});
test('Discord inventory returns the grid image, unknown commands are ignored and delete removes the profile', async () => {
  const store = new Store(':memory:'); store.save(profile()); const bot = new Bot(store, new SearchService(fixtureProvider()));
  const inv = interaction('inventory'); await bot.handle(inv.i);
  assert.ok(typeof inv.replies[0] === 'object' && inv.replies[0] && 'files' in inv.replies[0]);
  // Commands the bot never registered (another bot's, or the removed /find and /trade subcommands) get no reply at all.
  for (const gone of ['lock', 'find']) { const other = interaction(gone); await bot.handle(other.i); assert.equal(other.replies.length, 0); }
  const help = interaction('help'); await bot.handle(help.i); assert.match(JSON.stringify(help.replies[0]), /`\/trade`/); assert.doesNotMatch(JSON.stringify(help.replies[0]), /\/trade find|\/find trades|\/trade [a-z]/);
  const del = interaction('delete'); await bot.handle(del.i);
  assert.match(JSON.stringify(del.replies[0]), /Delete your data/); assert.ok(store.get('123'));
  await bot.component(submit(ids.build('delete', 'yes')).i); assert.equal(store.get('123'), undefined); store.close();
});

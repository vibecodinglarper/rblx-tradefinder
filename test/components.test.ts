import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MessageComponentInteraction, ModalSubmitInteraction } from 'discord.js';
import { Bot } from '../src/bot.js';
import { Store } from '../src/store.js';
import { SearchService } from '../src/search.js';
import { helpMessage, ids, settingsMessage, statusMessage } from '../src/presentation.js';
import { fixtureProvider, profile } from './fixtures.js';

type Kind = 'button' | 'select' | 'modal';
function component(customId: string, kind: Kind = 'button', extra: { values?: string[]; fields?: Record<string, string>; ephemeral?: boolean } = {}) {
  const calls: { method: string; body?: unknown }[] = [];
  const fake = {
    customId, user: { id: '123' }, deferred: false, replied: false, values: extra.values ?? [],
    message: { flags: { has: () => extra.ephemeral ?? true } },
    fields: { getTextInputValue: (key: string) => extra.fields?.[key] ?? '' },
    isModalSubmit: () => kind === 'modal', isButton: () => kind === 'button', isStringSelectMenu: () => kind === 'select',
    async deferUpdate() { this.deferred = true; calls.push({ method: 'deferUpdate' }); },
    async deferReply(body: unknown) { this.deferred = true; calls.push({ method: 'deferReply', body }); },
    async editReply(body: unknown) { calls.push({ method: 'editReply', body }); },
    async followUp(body: unknown) { calls.push({ method: 'followUp', body }); },
    async reply(body: unknown) { this.replied = true; calls.push({ method: 'reply', body }); },
    async showModal(body: unknown) { this.replied = true; calls.push({ method: 'showModal', body }); },
  };
  return { i: fake as unknown as MessageComponentInteraction | ModalSubmitInteraction, calls, last: () => calls.at(-1) };
}
const json = (v: unknown) => JSON.stringify(v);
const customIds = (panel: { components: { toJSON(): unknown }[] }): string[] => json(panel.components.map(c => c.toJSON())).match(/tf:[a-z0-9:,-]+/g) ?? [];

test('every panel uses tf-prefixed custom IDs within Discord limits and foreign IDs are ignored', async () => {
  const user = profile();
  for (const panel of [helpMessage(), settingsMessage(user), statusMessage(user)]) {
    const rows = panel.components.map(c => c.toJSON());
    assert.ok(rows.length <= 5);
    for (const id of customIds(panel)) { assert.ok(id.length <= 100); assert.ok(ids.parse(id)); }
  }
  assert.equal(ids.parse('other:thing'), null);
  assert.equal(ids.decode(ids.encode(123456789012)), 123456789012);
  assert.throws(() => ids.decode('!!'), /no longer valid/);
  const store = new Store(':memory:'), bot = new Bot(store, new SearchService(fixtureProvider()));
  const foreign = component('other:thing'); await bot.component(foreign.i); assert.equal(foreign.calls.length, 0);
  store.close();
});
test('settings buttons and select menu update preferences in place', async () => {
  const store = new Store(':memory:'); store.save(profile()); const bot = new Bot(store, new SearchService(fixtureProvider()));
  const mode = component(ids.build('mode', 'upgrade')); await bot.component(mode.i);
  assert.equal(mode.calls[0]?.method, 'deferUpdate'); assert.equal(store.get('123')?.preferences.mode, 'upgrade');
  assert.match(json(mode.last()?.body), /Mode set to/);
  const projected = component(ids.build('projected')); await bot.component(projected.i);
  assert.equal(store.get('123')?.preferences.excludeProjected, false);
  const demand = component(ids.build('demand'), 'select', { values: ['3'] }); await bot.component(demand.i);
  assert.equal(store.get('123')?.preferences.minDemand, 3);
  const alerts = component(ids.build('alerts', 'on')); await bot.component(alerts.i);
  assert.equal(store.get('123')?.alerts, true); assert.match(json(alerts.last()?.body), /Alerts on/);
  // A DM alert message is not ephemeral, so acting on it must post a fresh private reply instead of editing the alert.
  const fromDm = component(ids.build('alerts', 'off'), 'button', { ephemeral: false }); await bot.component(fromDm.i);
  assert.equal(fromDm.calls[0]?.method, 'deferReply'); assert.equal(store.get('123')?.alerts, false);
  store.close();
});
test('navigation buttons render panels and require a linked account where needed', async () => {
  const store = new Store(':memory:'); const bot = new Bot(store, new SearchService(fixtureProvider()));
  const help = component(ids.build('view', 'calc')); await bot.component(help.i); assert.match(json(help.last()?.body), /How recommendations are calculated/);
  const unlinked = component(ids.build('view', 'status')); await bot.component(unlinked.i); assert.match(json(unlinked.last()?.body), /Link Roblox account/);
  store.save(profile());
  for (const [view, expected] of [['status', /Tradefinder status/], ['settings', /Trade filters/], ['inventory', /inventory\.csv/]] as const) {
    const c = component(ids.build('view', view)); await bot.component(c.i);
    assert.match(json(c.last()?.body), expected); assert.deepEqual((c.last()?.body as { attachments: unknown[] }).attachments, []);
  }
  store.close();
});
test('link modal opens from a button and its submission tracks the account', async () => {
  const store = new Store(':memory:'); const bot = new Bot(store, new SearchService(fixtureProvider()));
  const open = component(ids.build('linkmodal')); await bot.component(open.i); assert.equal(open.last()?.method, 'showModal');
  const submit = component(ids.build('link'), 'modal', { fields: { user: '1' } }); await bot.component(submit.i);
  assert.equal(store.get('123')?.robloxId, 1); assert.match(json(submit.last()?.body), /Tracking ExampleUser/);
  store.close();
});
test('recommendation buttons re-check the exchange, lock given items and re-run the search', async () => {
  const store = new Store(':memory:'); store.save(profile()); const bot = new Bot(store, new SearchService(fixtureProvider()));
  const result = await new SearchService(fixtureProvider()).search(profile());
  const { recommendationMessage } = await import('../src/presentation.js');
  const actions = customIds(recommendationMessage(result.recommendations[0]!, { alert: true }));
  assert.ok(actions.some(id => id.startsWith('tf:recheck:')) && actions.some(id => id.startsWith('tf:lock:')) && actions.includes('tf:alerts:off'));
  const recheck = component(actions.find(id => id.startsWith('tf:recheck:'))!); await bot.component(recheck.i);
  assert.match(json(recheck.last()?.body), /110 received − 100 given/);
  const again = component(ids.build('find', '-', '-', 1)); await bot.component(again.i);
  assert.match(json(again.calls.find(c => c.method === 'editReply')?.body), /wait \d+ more seconds/);
  bot['lastSearch'].clear();
  const again2 = component(ids.build('find', 'upgrade', ids.encode(30), 1)); await bot.component(again2.i);
  assert.match(json(again2.calls.find(c => c.method === 'editReply')?.body), /1 qualifying/); assert.equal(again2.calls.filter(c => c.method === 'followUp').length, 1);
  const lock = component(actions.find(id => id.startsWith('tf:lock:'))!); await bot.component(lock.i);
  assert.deepEqual(store.get('123')?.preferences.lockedIds, [10, 20]); assert.match(json(lock.last()?.body), /Locked \*\*Item 10, Item 20\*\*/);
  store.close();
});

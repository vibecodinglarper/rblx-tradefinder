import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MessageComponentInteraction, ModalSubmitInteraction } from 'discord.js';
import { Bot } from '../src/bot.js';
import { Store } from '../src/store.js';
import { SearchService } from '../src/search.js';
import { findPanel, helpMessage, ids, itemsPanel, profitMessage, settingsMessage } from '../src/presentation.js';
import { finderProvider, fixtureProvider, profile } from './fixtures.js';

type Kind = 'button' | 'select' | 'modal';
function component(customId: string, kind: Kind = 'button', extra: { values?: string[]; fields?: Record<string, string>; ephemeral?: boolean; fromMessage?: boolean } = {}) {
  const calls: { method: string; body?: unknown }[] = [];
  const fake = {
    customId, user: { id: '123' }, deferred: false, replied: false, values: extra.values ?? [],
    message: { flags: { has: () => extra.ephemeral ?? true } },
    fields: { getTextInputValue: (key: string) => extra.fields?.[key] ?? '' },
    isModalSubmit: () => kind === 'modal', isButton: () => kind === 'button', isStringSelectMenu: () => kind === 'select',
    isFromMessage: () => extra.fromMessage ?? true,
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
  user.preferences.targetIds = [30];
  for (const panel of [helpMessage(), profitMessage(user), settingsMessage(user), itemsPanel(user), findPanel({ mode: 'upgrade', targetIds: [30, 10, 20, 40, 999], results: 2 }, user)]) {
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
test('settings links to the alerts panel, which is where the DM toggles live', async () => {
  const store = new Store(':memory:'); store.save(profile()); const bot = new Bot(store, new SearchService(fixtureProvider()));
  // Mode and demand controls are gone from settings, and so are the DM toggles; one tab reaches the panel that has them.
  const settings = component(ids.build('view', 'settings')); await bot.component(settings.i);
  assert.equal(settings.calls[0]?.method, 'deferUpdate'); assert.match(json(settings.last()?.body), /tf:view:alerts/);
  assert.doesNotMatch(json(settings.last()?.body), /tf:mode:|tf:demand|tf:invalerts|tf:alerts:/);
  const tab = component(ids.build('view', 'alerts')); await bot.component(tab.i);
  assert.match(json(tab.last()?.body), /Alerts off/); assert.match(json(tab.last()?.body), /tf:alertrate/); assert.match(json(tab.last()?.body), /tf:invalerts:on/);
  const alerts = component(ids.build('alerts', 'on')); await bot.component(alerts.i);
  assert.equal(store.get('123')?.alerts, true); assert.match(json(alerts.last()?.body), /Alerts on/);
  // A DM alert message is not ephemeral, so acting on it must post a fresh private reply instead of editing the alert.
  const fromDm = component(ids.build('alerts', 'off'), 'button', { ephemeral: false }); await bot.component(fromDm.i);
  assert.equal(fromDm.calls[0]?.method, 'deferReply'); assert.equal(store.get('123')?.alerts, false);
  store.close();
});
test('navigation buttons render panels and require a linked account where needed', async () => {
  const store = new Store(':memory:'); const bot = new Bot(store, new SearchService(fixtureProvider()));
  const help = component(ids.build('view', 'help')); await bot.component(help.i); assert.match(json(help.last()?.body), /tf:view:settings/); assert.doesNotMatch(json(help.last()?.body), /calc|tf:view:profit/);
  const unlinked = component(ids.build('view', 'settings')); await bot.component(unlinked.i);
  assert.match(json(unlinked.last()?.body), /Link your Roblox account first/); assert.match(json(unlinked.last()?.body), /tf:linkmodal/); assert.doesNotMatch(json(unlinked.last()?.body), /Can’t do that/);
  store.save(profile());
  for (const [view, expected] of [['settings', /⚙️ Settings/], ['profit', /Trade profit/], ['inventory', /inventory\.png/]] as const) {
    const c = component(ids.build('view', view)); await bot.component(c.i);
    assert.match(json(c.last()?.body), expected); assert.deepEqual((c.last()?.body as { attachments: unknown[] }).attachments, []);
  }
  store.close();
});
test('link modal opens from a button and its submission tracks the account', async () => {
  const store = new Store(':memory:'); const bot = new Bot(store, new SearchService(fixtureProvider()));
  const open = component(ids.build('linkmodal')); await bot.component(open.i); assert.equal(open.last()?.method, 'showModal');
  const submit = component(ids.build('link'), 'modal', { fields: { user: '1', wanted: 'I30, nonsense item' } }); await bot.component(submit.i);
  assert.equal(store.get('123')?.robloxId, 1); assert.match(json(submit.last()?.body), /Tracking ExampleUser/);
  assert.deepEqual(store.get('123')?.preferences.targetIds, [30]);
  assert.match(json(submit.last()?.body), /Not recognised as wanted items: nonsense item/);
  const plain = component(ids.build('link'), 'modal', { fields: { user: '1' } }); await bot.component(plain.i);
  assert.doesNotMatch(json(plain.last()?.body), /Not recognised/);
  store.close();
});
test('recommendation buttons re-check the exchange and re-run the search', async () => {
  // Affordable on means the price-range question is already answered, so Find searches instead of asking.
  const store = new Store(':memory:'); const answered = profile(); answered.preferences.affordable = true; store.save(answered); const bot = new Bot(store, new SearchService(finderProvider()));
  const result = await new SearchService(fixtureProvider()).search(profile());
  const { recommendationMessage } = await import('../src/presentation.js');
  const actions = customIds(recommendationMessage(result.recommendations[0]!, { alert: true }));
  assert.ok(actions.some(id => id.startsWith('tf:recheck:')) && actions.includes('tf:alerts:off')); assert.ok(!actions.some(id => id.startsWith('tf:lock:')));
  const recheck = component(actions.find(id => id.startsWith('tf:recheck:'))!); await bot.component(recheck.i);
  assert.match(json(recheck.last()?.body), /102 received − 100 given/);
  const again = component(ids.build('find', '-', '-', 1)); await bot.component(again.i);
  assert.match(json(again.calls.find(c => c.method === 'editReply')?.body), /wait \d+ more seconds/);
  bot['lastSearch'].clear();
  const again2 = component(ids.build('find', 'upgrade', ids.encode(30), 1)); await bot.component(again2.i);
  assert.match(json(again2.calls.find(c => c.method === 'editReply')?.body), /1 person you can trade with/); assert.equal(again2.calls.filter(c => c.method === 'followUp').length, 0);
  store.close();
});

test('find panel changes mode, target and result count in place, then searches with those choices', async () => {
  const store = new Store(':memory:'); const user = profile(); user.preferences.targetIds = [30]; store.save(user);
  const bot = new Bot(store, new SearchService(finderProvider()));
  const mode = component(ids.build('fq', 'mode', 'upgrade', '-', 3)); await bot.component(mode.i);
  assert.equal(mode.calls[0]?.method, 'deferUpdate'); assert.match(json(mode.last()?.body), /Find trades/);
  const target = component(ids.build('fq', 'target', 'upgrade', 3), 'select', { values: [ids.encode(30)] }); await bot.component(target.i);
  assert.match(json(target.last()?.body), /Item 30/); assert.match(json(target.last()?.body), new RegExp(`tf:find:upgrade:${ids.encode(30)}:3`));
  const typed = component(ids.build('target', 'upgrade', 1), 'modal', { fields: { item: 'I30' } }); await bot.component(typed.i);
  assert.match(json(typed.last()?.body), /Target set to \*\*Item 30\*\*/);
  const open = component(ids.build('targetmodal', 'upgrade', 1)); await bot.component(open.i); assert.equal(open.last()?.method, 'showModal');
  const search = component(ids.build('find', 'upgrade', ids.encode(30), 1)); await bot.component(search.i);
  assert.match(json(search.calls.find(c => c.method === 'editReply')?.body), /1 person you can trade with/); assert.equal(search.calls.filter(c => c.method === 'followUp').length, 0);
  store.close();
});
test('filters form validates numbers; RAP fields are gone from every form', async () => {
  const store = new Store(':memory:'); store.save(profile()); const bot = new Bot(store, new SearchService(fixtureProvider()));
  const open = component(ids.build('filtersmodal')); await bot.component(open.i); assert.equal(open.last()?.method, 'showModal');
  const fields = { maxLossPct: '3%', maxAdAgeMinutes: '30' };
  const ok = component(ids.build('filters'), 'modal', { fields }); await bot.component(ok.i);
  assert.equal(ok.calls[0]?.method, 'deferUpdate'); assert.match(json(ok.last()?.body), /Profit filters updated/); assert.match(json(ok.last()?.body), /up to \*\*3%\*\* of what I give/);
  assert.deepEqual([store.get('123')?.preferences.minValueGainPct, store.get('123')?.preferences.maxValueGainPct, store.get('123')?.preferences.maxAdAgeMinutes], [-3, null, 30]);
  // Every rejection names the box, says what it accepts and quotes what arrived; nothing is saved meanwhile.
  const bad = component(ids.build('filters'), 'modal', { fields: { ...fields, maxLossPct: '99' } }); await bot.component(bad.i);
  assert.match(json(bad.last()?.body), /\*\*Loss I will accept\*\* must be between 0 and 50; you entered `99`/); assert.equal(store.get('123')?.preferences.minValueGainPct, -3);
  const nan = component(ids.build('filters'), 'modal', { fields: { ...fields, maxAdAgeMinutes: 'lots' } }); await bot.component(nan.i);
  assert.match(json(nan.last()?.body), /\*\*Max ad age\*\* must be a number; you entered `lots`/);
  assert.doesNotMatch(json(nan.last()?.body), /Max overpay|partner loss/);
  const empty = component(ids.build('filters'), 'modal', { fields: { ...fields, maxAdAgeMinutes: '  ' } }); await bot.component(empty.i);
  assert.match(json(empty.last()?.body), /\*\*Max ad age\*\* is required; the box was left empty/);
  const huge = component(ids.build('filters'), 'modal', { fields: { ...fields, maxAdAgeMinutes: '99999' } }); await bot.component(huge.i);
  assert.match(json(huge.last()?.body), /\*\*Max ad age\*\* must be between 1 and 1440; you entered `99999`/);
  assert.equal(store.get('123')?.preferences.maxAdAgeMinutes, 30, 'a rejected form leaves the saved value alone');
  const profit = component(ids.build('view', 'profit')); await bot.component(profit.i);
  assert.doesNotMatch(json(profit.last()?.body), /tf:ratio|Min RAP gain|never used to decide/); assert.match(json(profit.last()?.body), /Trade profit/);
  store.close();
});
test('items panel adds through forms and removes through select menus', async () => {
  const store = new Store(':memory:'); store.save(profile()); const bot = new Bot(store, new SearchService(fixtureProvider()));
  const watch = component(ids.build('addwatch'), 'modal', { fields: { item: 'Item 30' } }); await bot.component(watch.i);
  assert.deepEqual(store.get('123')?.preferences.targetIds, [30]); assert.match(json(watch.last()?.body), /Now watching/);
  const more = component(ids.build('addwatch'), 'modal', { fields: { item: '10, 20' } }); await bot.component(more.i);
  assert.deepEqual(store.get('123')?.preferences.targetIds, [30, 10, 20]); assert.doesNotMatch(json(more.last()?.body), /tf:lockmodal|tf:unlock/);
  const two = component(ids.build('unwatch'), 'select', { values: [ids.encode(10), ids.encode(20)] }); await bot.component(two.i);
  assert.deepEqual(store.get('123')?.preferences.targetIds, [30]); assert.match(json(two.last()?.body), /Removed \*\*Item 10\*\*, \*\*Item 20\*\*/);
  const clear = component(ids.build('unwatch'), 'select', { values: ['all'] }); await bot.component(clear.i);
  assert.deepEqual(store.get('123')?.preferences.targetIds, []); assert.doesNotMatch(json(clear.last()?.body), /tf:unwatch/);
  store.close();
});
test('delete asks for confirmation and only deletes on yes; the old analyze form is gone', async () => {
  const store = new Store(':memory:'); store.save(profile()); const bot = new Bot(store, new SearchService(fixtureProvider()));
  const ask = component(ids.build('delete')); await bot.component(ask.i);
  assert.match(json(ask.last()?.body), /Delete your data\?/); assert.ok(store.get('123'));
  const analyze = component(ids.build('analyze'), 'modal', { fields: { partner: '2', give: '10, 20', receive: '30' }, fromMessage: false }); await bot.component(analyze.i);
  assert.match(json(analyze.last()?.body), /no longer supported/);
  const yes = component(ids.build('delete', 'yes')); await bot.component(yes.i);
  assert.equal(store.get('123'), undefined); assert.match(json(yes.last()?.body), /Your data was deleted/);
  store.close();
});

test('inventory groups copies into quantities, pages through grid and text views, and renders the grid image', async () => {
  const provider = fixtureProvider();
  // 16 copies of item 10 plus one of everything else, across enough distinct items to need two grid pages.
  for (let id = 100; id < 115; id++) provider.itemMap.set(id, { ...provider.itemMap.get(40)!, id, name: `Extra ${id}`, acronym: `E${id}` });
  provider.itemMap.set(10, { ...provider.itemMap.get(10)!, name: 'Anime Hair', rare: true });
  provider.inventories.set(1, { userId: 1, fetchedAt: Date.now(), holdings: [
    ...Array.from({ length: 16 }, (_, i) => ({ assetId: 10, userAssetId: 1000 + i, onHold: i === 0 })),
    ...Array.from({ length: 15 }, (_, i) => ({ assetId: 100 + i, userAssetId: 2000 + i, onHold: false })),
    { assetId: 20, userAssetId: 3000, onHold: false }, { assetId: 999999, userAssetId: 3001, onHold: false },
    // Not tracked by Rolimons: Roblox's own name and recent average price stand in, and it sorts by that RAP.
    { assetId: 888888, userAssetId: 3002, onHold: false, name: 'Roblox Only Hat', robloxRap: 48 },
  ] });
  const store = new Store(':memory:'); const user = profile(); store.save(user);
  const bot = new Bot(store, new SearchService(provider));
  const grid = component(ids.build('view', 'inventory')); await bot.component(grid.i);
  const body = grid.last()?.body as { embeds: { toJSON(): { image?: { url: string }; footer?: { text: string }; title?: string } }[]; files: { name: string }[] };
  assert.equal(body.embeds[0]!.toJSON().image?.url, 'attachment://inventory.png');
  assert.match(body.embeds[0]!.toJSON().title!, /19 items · 34 copies/); assert.equal(body.embeds[0]!.toJSON().footer, undefined);
  assert.deepEqual(body.files.map(f => f.name), ['inventory.png']); assert.doesNotMatch(json(body), /invcsv|Page 1|Each square|Available copies|roblox\.com\/users\/1\/inventory/);
  assert.match(json(body), /tf:inv:grid:1/); assert.match(json(body), /tf:inv:text:0/);
  const next = component(ids.build('inv', 'grid', 1)); await bot.component(next.i);
  assert.equal(next.calls[0]?.method, 'deferUpdate'); assert.match(json(next.last()?.body), /tf:inv:grid:0/); assert.doesNotMatch(json(next.last()?.body), /Page 2/);
  const text = component(ids.build('inv', 'text', 0)); await bot.component(text.i);
  const t = text.last()?.body as { embeds: { toJSON(): { description?: string } }[]; files: { name: string }[] };
  assert.deepEqual(t.files, []);
  const desc = t.embeds[0]!.toJSON().description!;
  assert.match(desc, /\*\*3\.\*\* \[Roblox Only Hat\]\(.*\) · V 48 · RAP 48\n\*\*4\.\*\* \[Extra 100\]/); assert.doesNotMatch(desc, /RAP\)|value = RAP/);
  assert.match(t.embeds[0]!.toJSON().description!, /\*\*1\.\*\* \[Anime Hair\]\(.*\) \*\*16x\*\* · V 50 · RAP 50 · 💎 rare ⏳ 1 on hold/);
  assert.doesNotMatch(t.embeds[0]!.toJSON().description!, /locked/); assert.match(t.embeds[0]!.toJSON().description!, /Item 999999\]\(.*\) · no price · ❔ unpriced/);
  assert.match(json(t), /tf:inv:grid:0/);
  store.close();
});

test('inventory-DM toggle snapshots the current inventory when turned on and clears it when turned off', async () => {
  const store = new Store(':memory:'); store.save(profile()); const bot = new Bot(store, new SearchService(fixtureProvider()));
  const on = component(ids.build('invalerts', 'on')); await bot.component(on.i);
  assert.equal(on.calls[0]?.method, 'deferUpdate'); assert.match(json(on.last()?.body), /Inventory DMs on/); assert.match(json(on.last()?.body), /\*\*2\*\* copies/);
  assert.equal(store.get('123')?.inventoryAlerts, true); assert.equal(store.snapshot('123')?.holdings.length, 2);
  const off = component(ids.build('invalerts', 'off')); await bot.component(off.i);
  assert.match(json(off.last()?.body), /Inventory DMs off/); assert.equal(store.get('123')?.inventoryAlerts, false); assert.equal(store.snapshot('123'), undefined);
  store.close();
});

test('search filters form saves percentage and amount floors that the engine enforces, and blank amounts clear them', async () => {
  const store = new Store(':memory:'); const answered = profile(); answered.preferences.affordable = true; store.save(answered); const bot = new Bot(store, new SearchService(finderProvider()));
  const open = component(ids.build('sfiltersmodal', 'upgrade', '-', 2)); await bot.component(open.i);
  assert.equal(open.last()?.method, 'showModal'); assert.match(json(open.last()?.body), /tf:sfilters:upgrade:-:2/);
  const fields = { downgradeRange: '', upgradeRange: '', receiveRange: '', maxAdAgeMinutes: '60' };
  const save = component(ids.build('sfilters', 'upgrade', '-', 2), 'modal', { fields: { ...fields, upgradeRange: '-1% - 3%' } }); await bot.component(save.i);
  assert.equal(save.calls[0]?.method, 'deferUpdate'); assert.match(json(save.last()?.body), /Filters saved. Upgrade overpay -1% – 3%/); assert.doesNotMatch(json(save.last()?.body), /Extra filters/);
  assert.deepEqual([store.get('123')?.preferences.upgradeOverpayMin, store.get('123')?.preferences.upgradeOverpayMax], [{ value: -1, pct: true }, { value: 3, pct: true }]);
  // The finder fixture upgrade gains 2% (overpay -2%), outside a window that starts at -1%; widening it to -5% lets it through.
  bot['lastSearch'].clear();
  const blocked = component(ids.build('find', 'upgrade', '-', 1)); await bot.component(blocked.i);
  assert.match(json(blocked.calls.find(c => c.method === 'editReply')?.body), /No sendable upgrades/);
  await bot.component(component(ids.build('sfilters', 'upgrade', '-', 2), 'modal', { fields: { ...fields, upgradeRange: '-5% - 3%', downgradeRange: '5% - 5000' } }).i);
  assert.deepEqual([store.get('123')?.preferences.downgradeProfitMin, store.get('123')?.preferences.downgradeProfitMax], [{ value: 5, pct: true }, { value: 5000, pct: false }], 'each side may be a percent or a value');
  bot['lastSearch'].clear();
  const widened = component(ids.build('find', 'upgrade', '-', 1)); await bot.component(widened.i);
  assert.match(json(widened.calls.find(c => c.method === 'editReply')?.body), /1 person you can trade with/);
  // Values work too, and a floor of 0 overpay rejects a trade where you gain.
  const capped = component(ids.build('sfilters', 'upgrade', '-', 2), 'modal', { fields: { ...fields, upgradeRange: '0 - 3%' } }); await bot.component(capped.i);
  bot['lastSearch'].clear();
  const above = component(ids.build('find', 'upgrade', '-', 1)); await bot.component(above.i);
  assert.match(json(above.calls.find(c => c.method === 'editReply')?.body), /No sendable upgrades/, 'an overpay floor of 0 rejects a trade where you gain');
  await bot.component(component(ids.build('sfilters', 'upgrade', '-', 2), 'modal', { fields }).i);
  assert.equal(store.get('123')?.preferences.upgradeOverpayMin, null); assert.equal(store.get('123')?.preferences.upgradeOverpayMax, null);
  bot['lastSearch'].clear();
  const allowed = component(ids.build('find', 'upgrade', '-', 1)); await bot.component(allowed.i);
  assert.match(json(allowed.calls.find(c => c.method === 'editReply')?.body), /1 person you can trade with/);
  store.close();
});

test('ambiguous item names offer a pick list whose selection completes the original action', async () => {
  const provider = fixtureProvider();
  provider.itemMap.set(50, { ...provider.itemMap.get(10)!, id: 50, name: 'Dominus Empyreus', acronym: 'Emp', value: 900 });
  provider.itemMap.set(51, { ...provider.itemMap.get(10)!, id: 51, name: 'Dominus Frigidus', acronym: 'Frig', value: 800 });
  const store = new Store(':memory:'); store.save(profile()); const bot = new Bot(store, new SearchService(provider));
  const watch = component(ids.build('addwatch'), 'modal', { fields: { item: 'dominus' } }); await bot.component(watch.i);
  assert.match(json(watch.last()?.body), /Which item did you mean/); assert.match(json(watch.last()?.body), /tf:pick:addwatch/);
  assert.deepEqual(store.get('123')?.preferences.targetIds, []);
  const pick = component(ids.build('pick', 'addwatch'), 'select', { values: [ids.encode(51)] }); await bot.component(pick.i);
  assert.equal(pick.calls[0]?.method, 'deferUpdate'); assert.deepEqual(store.get('123')?.preferences.targetIds, [51]);
  assert.match(json(pick.last()?.body), /Now watching \*\*Dominus Frigidus \(Frig\) · ID 51\*\*/);
  const target = component(ids.build('target', 'upgrade', 2), 'modal', { fields: { item: 'Dominus' } }); await bot.component(target.i);
  assert.match(json(target.last()?.body), /tf:pick:target:upgrade:2/);
  const pickTarget = component(ids.build('pick', 'target', 'upgrade', 2, ids.encode(30)), 'select', { values: [ids.encode(50)] }); await bot.component(pickTarget.i);
  assert.match(json(pickTarget.last()?.body), /Targets set to \*\*Item 30\*\*.*\*\*Dominus Empyreus\*\* \(Emp\) · ID 50/, 'the pick joins targets resolved before it');
  assert.match(json(pickTarget.last()?.body), new RegExp(`tf:find:upgrade:${ids.encode(30)},${ids.encode(50)}:2`));
  const exact = component(ids.build('addwatch'), 'modal', { fields: { item: 'emp' } }); await bot.component(exact.i);
  assert.deepEqual(store.get('123')?.preferences.targetIds, [51, 50], 'an exact acronym never needs a pick list');
  store.close();
});
test('search results state how many ads were screened and how many offered the target, on the summary and each card', async () => {
  const store = new Store(':memory:'); store.save(profile()); const bot = new Bot(store, new SearchService(finderProvider()));
  const search = component(ids.build('find', 'upgrade', ids.encode(30), 1)); await bot.component(search.i);
  const summary = json(search.calls.find(c => c.method === 'editReply')?.body);
  assert.match(summary, /Screened \*\*1\*\* trade ads going back \d+ min; \*\*1\*\* offered Item 30; verified \*\*1\*\* of 1 promising sellers/);
  assert.match(summary, /🟠 0 slight loss · 🟰 0 even · 🟢 1 slight gain/); assert.doesNotMatch(summary, /tf:tld/);
  assert.match(summary, /"thumbnail":\{"url":"https:\/\/tr\.rbxcdn\.com\/character\/2\.png"\}/, 'the seller card shows their character render');
  assert.doesNotMatch(summary, /more option/); assert.doesNotMatch(summary, /tf:view:items/, 'no Wanted & locked button on the finder');
  assert.match(summary, /\\n🔁 \[Open the trade window with ExampleSeller\]\(https:\/\/www\.roblox\.com\/users\/2\/trade#tradefinder\?give=10,20&get=30\)/);
  const page = component(ids.build('tl', 0)); await bot.component(page.i);
  assert.equal(page.calls[0]?.method, 'deferUpdate'); assert.match(json(page.last()?.body), /1 person you can trade with/);
  bot['results'].clear();
  const expired = component(ids.build('tl', 0)); await bot.component(expired.i); assert.match(json(expired.last()?.body), /search has expired/);
  store.close();
});

test('several targets can be searched at once from the menu or a comma-separated form', async () => {
  const provider = finderProvider();
  provider.adList.push({ ...provider.adList[0]!, id: 701, userId: 3, username: 'Other', offering: [40], requesting: [] });
  provider.inventories.set(3, { userId: 3, fetchedAt: Date.now(), holdings: [{ assetId: 40, userAssetId: 3100, onHold: false }] });
  const store = new Store(':memory:'); const user = profile(); user.preferences.targetIds = [30]; store.save(user);
  const bot = new Bot(store, new SearchService(provider));
  const menu = component(ids.build('fq', 'target', 'upgrade', 3), 'select', { values: ['-', ids.encode(30), ids.encode(40)] }); await bot.component(menu.i);
  assert.match(json(menu.last()?.body), /I want · 2/); assert.match(json(menu.last()?.body), new RegExp(`tf:find:upgrade:${ids.encode(30)},${ids.encode(40)}:3`));
  const typed = component(ids.build('target', 'upgrade', 3, '-'), 'modal', { fields: { item: 'I30, Item 40' } }); await bot.component(typed.i);
  assert.match(json(typed.last()?.body), /Targets set to \*\*Item 30\*\* \(I30\) · ID 30, \*\*Item 40\*\* \(I40\) · ID 40/);
  const tooMany = component(ids.build('target', 'upgrade', 3, '-'), 'modal', { fields: { item: '10,20,30,40,10,20' } }); await bot.component(tooMany.i);
  assert.match(json(tooMany.last()?.body), /up to 5 items/);
  const search = component(ids.build('find', 'upgrade', ids.encodeList([30, 40]), 3)); await bot.component(search.i);
  const summary = json(search.calls.find(c => c.method === 'editReply')?.body);
  assert.match(summary, /Screened \*\*2\*\* trade ads going back \d+ min; \*\*2\*\* offered Item 30, Item 40/);
  assert.match(summary, /1 person you can trade with for Item 30, Item 40/, 'item 40 is worth 45: no bundle of the user\'s items lands within the window');
  assert.deepEqual(store.get('123')?.preferences.targetIds, [30], 'a one-off multi-target search never rewrites the saved wanted list');
  store.close();
});

test('per-item profit rules are set from the items panel, override the general range for that item, and can be removed', async () => {
  const provider = finderProvider();
  const store = new Store(':memory:'); store.save(profile()); const bot = new Bot(store, new SearchService(provider));
  const open = component(ids.build('rulemodal')); await bot.component(open.i); assert.equal(open.last()?.method, 'showModal');
  const rule = component(ids.build('itemrule'), 'modal', { fields: { item: 'I30', range: '2 - 20' } }); await bot.component(rule.i);
  assert.equal(rule.calls[0]?.method, 'deferUpdate'); assert.match(json(rule.last()?.body), /bring in \*\*Item 30\*\* must now profit \*\*2 – 20\*\*/);
  assert.deepEqual(store.get('123')?.preferences.itemRules, { '30': { min: 2, max: 20 } });
  assert.match(json(rule.last()?.body), /Profit rules · 1/); assert.match(json(rule.last()?.body), /tf:unrule/);
  // The general range would reject the fixture's gain of 10, but the rule for the received item takes over.
  await bot.component(component(ids.build('sfilters', 'upgrade', '-', 2), 'modal', { fields: { downgradeRange: '', upgradeRange: '', receiveRange: '', maxAdAgeMinutes: '60' } }).i);
  bot['lastSearch'].clear();
  const ok = component(ids.build('find', 'upgrade', ids.encode(30), 1)); await bot.component(ok.i);
  assert.match(json(ok.calls.find(c => c.method === 'editReply')?.body), /1 person you can trade with/);
  const tighter = component(ids.build('itemrule'), 'modal', { fields: { item: '30', range: '50 to 100' } }); await bot.component(tighter.i);
  bot['lastSearch'].clear();
  const blocked = component(ids.build('find', 'upgrade', ids.encode(30), 1)); await bot.component(blocked.i);
  assert.match(json(blocked.calls.find(c => c.method === 'editReply')?.body), /No sendable upgrades/);
  const ambiguous = component(ids.build('itemrule'), 'modal', { fields: { item: 'item', range: '- 500' } }); await bot.component(ambiguous.i);
  assert.match(json(ambiguous.last()?.body), /tf:pick:itemrule:x:500/);
  const picked = component(ids.build('pick', 'itemrule', 'x', '500'), 'select', { values: [ids.encode(40)] }); await bot.component(picked.i);
  assert.deepEqual(store.get('123')?.preferences.itemRules['40'], { min: null, max: 500 });
  const remove = component(ids.build('unrule'), 'select', { values: [ids.encode(30)] }); await bot.component(remove.i);
  assert.equal(store.get('123')?.preferences.itemRules['30'], undefined); assert.match(json(remove.last()?.body), /Removed the profit rule for \*\*Item 30\*\*/);
  const blank = component(ids.build('itemrule'), 'modal', { fields: { item: '40', range: '' } }); await bot.component(blank.i);
  assert.deepEqual(store.get('123')?.preferences.itemRules, {});
  store.close();
});

test('wanted items can be added several at a time with commas; problems are reported per entry', async () => {
  const provider = fixtureProvider();
  provider.itemMap.set(50, { ...provider.itemMap.get(10)!, id: 50, name: 'Dominus Empyreus', acronym: 'Emp' });
  provider.itemMap.set(51, { ...provider.itemMap.get(10)!, id: 51, name: 'Dominus Frigidus', acronym: 'Frig' });
  const store = new Store(':memory:'); store.save(profile()); const bot = new Bot(store, new SearchService(provider));
  const many = component(ids.build('addwatch'), 'modal', { fields: { item: 'I30, Item 40, totally unknown thing' } }); await bot.component(many.i);
  assert.deepEqual(store.get('123')?.preferences.targetIds, [30, 40]);
  assert.match(json(many.last()?.body), /Now watching \*\*Item 30\*\* \(I30\) · ID 30, \*\*Item 40\*\* \(I40\) · ID 40/); assert.match(json(many.last()?.body), /⚠️ No Rolimons-tracked limited matched/);
  const mixed = component(ids.build('addwatch'), 'modal', { fields: { item: '10\ndominus' } }); await bot.component(mixed.i);
  assert.deepEqual(store.get('123')?.preferences.targetIds, [30, 40, 10], 'resolved entries are saved before the pick list appears');
  assert.match(json(mixed.last()?.body), /Which item did you mean/); assert.match(json(mixed.last()?.body), /tf:pick:addwatch/);
  store.close();
});
test('the upgrade list pages five sellers at a time, orders slight losses before even swaps before slight gains, and links each trade window', async () => {
  const provider = finderProvider();
  // Seven sellers each offering one item for the user's 10 + 20 (value 100); values chosen to land in each bucket of the −5%..+3% window.
  for (let n = 0; n < 7; n++) {
    const id = 300 + n; const value = [102, 100, 96, 103, 101, 99, 97][n]!;
    provider.itemMap.set(id, { ...provider.itemMap.get(30)!, id, name: `Offer ${n}`, acronym: `O${n}`, value, rap: value });
    provider.adList.push({ ...provider.adList[0]!, id: 800 + n, userId: 10 + n, username: `Seller${n}`, offering: [id], requesting: [10, 20] });
    provider.inventories.set(10 + n, { userId: 10 + n, fetchedAt: Date.now(), holdings: [{ assetId: id, userAssetId: 5000 + n, onHold: false }] });
  }
  const store = new Store(':memory:'); const answered = profile(); answered.preferences.affordable = true; store.save(answered); const bot = new Bot(store, new SearchService(provider, 30));
  const search = component(ids.build('find', 'upgrade', ids.encodeList([300, 301, 302, 303, 304]), 3)); await bot.component(search.i);
  const list = json(search.calls.find(c => c.method === 'editReply')?.body);
  assert.match(list, /5 people you can trade with/); assert.match(list, /Page 1\/1/);
  const targeted = component(ids.build('find', 'upgrade', '-', 3)); bot['lastSearch'].clear(); await bot.component(targeted.i);
  const all = json(targeted.calls.find(c => c.method === 'editReply')?.body);
  assert.match(all, /8 people you can trade with/); assert.match(all, /Page 1\/2/); assert.match(all, /tf:tl:1/);
  assert.match(all, /🟠 2 slight loss · 🟰 3 even · 🟢 3 slight gain/);
  const order = [...all.matchAll(/"title":"(\d)\. (🟢|🟰|🟠)/g)].map(m => m[2]);
  assert.deepEqual(order, ['🟠', '🟠', '🟰', '🟰', '🟰'], 'slight losses first because sellers accept them');
  assert.equal((all.match(/"label":"\d · Trade with Seller\d"/g) ?? []).length, 5, 'one Trade with button per card');
  assert.equal((all.match(/attachment:\/\/trade-\d\.png/g) ?? []).length, 5, 'every card on the page is an image');
  const next = component(ids.build('tl', 1)); await bot.component(next.i);
  const page2 = json(next.last()?.body); assert.match(page2, /Page 2\/2/); assert.deepEqual([...page2.matchAll(/"title":"(\d)\. (🟢|🟰|🟠)/g)].map(m => m[2]), ['🟢', '🟢', '🟢']);
  assert.match(page2, /"url":"https:\/\/www\.roblox\.com\/users\/13\/trade#tradefinder\?give=10,20&get=303"/);
  store.close();
});
test('downgrade mode gives one chosen item for a seller bundle worth about +10%, ranked closest to +10% first, and never touches projected items', async () => {
  const provider = fixtureProvider();
  // The user gives item 30 (value 110, they own one). Sellers offer pairs: 60+61 = 121 (+10%), 62+63 = 130 (+18%), 64+65 = 112 (+1.8%, below +5%), 66 projected + 67.
  provider.inventories.set(1, { userId: 1, fetchedAt: Date.now(), holdings: [{ assetId: 30, userAssetId: 100, onHold: false }, { assetId: 10, userAssetId: 101, onHold: false }] });
  const pairs: [number, number, number, number, boolean][] = [[60, 61, 60, 61, false], [62, 63, 65, 65, false], [64, 65, 56, 56, false], [66, 67, 60, 61, true]];
  pairs.forEach(([a, b, va, vb, projected], n) => {
    provider.itemMap.set(a, { ...provider.itemMap.get(40)!, id: a, name: `Part ${a}`, acronym: `P${a}`, value: va, rap: va, projected });
    provider.itemMap.set(b, { ...provider.itemMap.get(40)!, id: b, name: `Part ${b}`, acronym: `P${b}`, value: vb, rap: vb });
    provider.adList.push({ ...provider.adList[0]!, id: 900 + n, userId: 20 + n, username: `Bundler${n}`, offering: [a, b], requesting: [] });
    provider.inventories.set(20 + n, { userId: 20 + n, fetchedAt: Date.now(), holdings: [{ assetId: a, userAssetId: 6000 + n * 2, onHold: false }, { assetId: b, userAssetId: 6001 + n * 2, onHold: false }] });
  });
  const store = new Store(':memory:'); store.save(profile()); const bot = new Bot(store, new SearchService(provider, 30));
  const panel = component(ids.build('fq', 'mode', 'downgrade', '-', 3)); await bot.component(panel.i);
  const body = json(panel.last()?.body);
  assert.match(body, /Find trades · ⬇️ Downgrade/); assert.match(body, /tf:fq:give:downgrade:3/); assert.match(body, /"label":"Item 30"/); assert.match(body, /"disabled":true/, 'search stays disabled until an item is chosen');
  const chosen = component(ids.build('fq', 'give', 'downgrade', 3), 'select', { values: [ids.encode(30)] }); await bot.component(chosen.i);
  assert.match(json(chosen.last()?.body), new RegExp(`tf:find:downgrade:${ids.encode(30)}:3`));
  const notOwned = component(ids.build('target', 'downgrade', 3, '-'), 'modal', { fields: { item: 'I20' } }); await bot.component(notOwned.i);
  assert.match(json(notOwned.last()?.body), /do not have an available copy of \*\*Item 20\*\*/);
  const search = component(ids.build('find', 'downgrade', ids.encode(30), 3)); await bot.component(search.i);
  const list = json(search.calls.find(c => c.method === 'editReply')?.body);
  // 64+65 (+1.82%) is not worth downgrading for, and the projected pair never counts; both real offers survive.
  assert.match(list, /2 people you can trade with to downgrade Item 30/);
  const order = [...list.matchAll(/"title":"(\d)\. (🟢|🟰|🟠) ([+-][\d,]+) value \(([+-][\d.]+)%\)/g)].map(m => m[4]);
  assert.deepEqual(order, ['+10', '+18.18'], 'the profit a downgrade is aiming for comes first');
  assert.doesNotMatch(list, /Part 66|Part 67/, 'a bundle containing a projected item is never proposed');
  assert.match(list, /"url":"https:\/\/www\.roblox\.com\/users\/20\/trade#tradefinder\?give=30&get=60,61"/);
  store.close();
});

test('affordable filter: auto band from own items, custom range from the form, and the Both mode mixes upgrades and downgrades', async () => {
  const store = new Store(':memory:'); const user = profile(); user.preferences.targetIds = [30]; store.save(user);
  const bot = new Bot(store, new SearchService(finderProvider()));
  // Mode buttons are bare words; no explanation of what each mode is.
  const panel = component(ids.build('fq', 'mode', 'upgrade', '-', 3)); await bot.component(panel.i);
  assert.match(json(panel.last()?.body), /"label":"Upgrade"/); assert.match(json(panel.last()?.body), /"label":"Downgrade"/); assert.match(json(panel.last()?.body), /"label":"Both"/);
  assert.doesNotMatch(json(panel.last()?.body), /Give up to|for \*\*1\*\* of theirs/); assert.match(json(panel.last()?.body), /Affordable: off/); assert.match(json(panel.last()?.body), /any value/);
  // Switching the filter on asks for the band rather than guessing one; the toggle waits for that answer.
  const on = component(ids.build('fq', 'afford', 'upgrade', '-', 3)); await bot.component(on.i);
  assert.equal(on.last()?.method, 'showModal'); assert.match(json(on.last()?.body), /tf:range:upgrade:3:panel/);
  assert.equal(store.get('123')?.preferences.affordable, false, 'nothing changes until the form comes back');
  // Blank means "whatever my items can afford": the cheapest own item (50) up to the top four together (100) plus the gain window.
  const auto = component(ids.build('range', 'upgrade', 3, 'panel'), 'modal', { fields: { range: '' } }); await bot.component(auto.i);
  assert.equal(store.get('123')?.preferences.affordable, true); assert.match(json(auto.last()?.body), /Affordable: on/); assert.match(json(auto.last()?.body), /50 – 110 · your best item up to your top four together/);
  const hit = component(ids.build('find', 'upgrade', ids.encode(30), 1)); await bot.component(hit.i);
  assert.match(json(hit.calls.find(c => c.method === 'editReply')?.body), /1 person you can trade with/);
  bot['lastSearch'].clear();
  // A typed range replaces the band; item 30 (102) is above a 90 cap, so nothing qualifies.
  const custom = component(ids.build('sfilters', 'upgrade', '-', 2), 'modal', { fields: { downgradeRange: '', upgradeRange: '', receiveRange: '- 90', maxAdAgeMinutes: '60' } }); await bot.component(custom.i);
  assert.deepEqual([store.get('123')?.preferences.minReceiveValue, store.get('123')?.preferences.maxReceiveValue], [null, 90]); assert.match(json(custom.last()?.body), /≤ 90 · your range/);
  const miss = component(ids.build('find', 'upgrade', ids.encode(30), 1)); await bot.component(miss.i);
  assert.match(json(miss.calls.find(c => c.method === 'editReply')?.body), /No sendable upgrades/);
  bot['lastSearch'].clear();
  // Off again: the stored range is kept but ignored.
  const off = component(ids.build('fq', 'afford', 'upgrade', '-', 3)); await bot.component(off.i);
  assert.equal(store.get('123')?.preferences.affordable, false); assert.match(json(off.last()?.body), /Affordable: off/);
  const both = component(ids.build('find', 'both', '-', 1)); await bot.component(both.i);
  assert.match(json(both.calls.find(c => c.method === 'editReply')?.body), /🔀 1 person you can trade with/); assert.match(json(both.calls.find(c => c.method === 'editReply')?.body), /upgrades and downgrades/);
  store.close();
});

test('picking "Any item in your range" on the finder opens a price-range form whose answer sets the receive range and turns Affordable on', async () => {
  const store = new Store(':memory:'); const user = profile(); user.preferences.targetIds = [30]; store.save(user);
  const bot = new Bot(store, new SearchService(finderProvider()));
  const panel = component(ids.build('fq', 'mode', 'upgrade', '-', 3)); await bot.component(panel.i);
  assert.match(json(panel.last()?.body), /Any item in your range/); assert.doesNotMatch(json(panel.last()?.body), /Any wanted item/);
  const any = component(ids.build('fq', 'target', 'upgrade', 3), 'select', { values: ['-'] }); await bot.component(any.i);
  assert.equal(any.last()?.method, 'showModal'); assert.match(json(any.last()?.body), /tf:range:upgrade:3/); assert.match(json(any.last()?.body), /Value range of items to look for/);
  const answer = component(ids.build('range', 'upgrade', 3), 'modal', { fields: { range: '80 - 120' } }); await bot.component(answer.i);
  assert.equal(answer.calls[0]?.method, 'deferUpdate'); assert.match(json(answer.last()?.body), /Looking for any item worth \*\*80 – 120\*\*/);
  assert.deepEqual([store.get('123')?.preferences.affordable, store.get('123')?.preferences.minReceiveValue, store.get('123')?.preferences.maxReceiveValue], [true, 80, 120]);
  assert.match(json(answer.last()?.body), /80 – 120 · your range/);
  // Specific items alongside "any" still mean the specific items, with no prompt.
  const mixed = component(ids.build('fq', 'target', 'upgrade', 3), 'select', { values: ['-', ids.encode(30)] }); await bot.component(mixed.i);
  assert.equal(mixed.calls[0]?.method, 'deferUpdate'); assert.match(json(mixed.last()?.body), /Item 30/);
  const blank = component(ids.build('range', 'upgrade', 3), 'modal', { fields: { range: '' } }); await bot.component(blank.i);
  assert.match(json(blank.last()?.body), /any item your items can afford/); assert.equal(store.get('123')?.preferences.minReceiveValue, null);
  store.close();
});

test('searching with nothing picked asks for the price range first, then runs that search', async () => {
  const store = new Store(':memory:'); store.save(profile()); const bot = new Bot(store, new SearchService(finderProvider()));
  // No target and no wanted list means "any item in your range", so the band is asked for before any searching happens.
  const ask = component(ids.build('find', 'upgrade', '-', 1)); await bot.component(ask.i);
  assert.equal(ask.last()?.method, 'showModal'); assert.match(json(ask.last()?.body), /tf:range:upgrade:1:find/);
  assert.equal(bot['results'].get('123'), undefined, 'nothing was searched while the question was open');
  const answer = component(ids.build('range', 'upgrade', 1, 'find'), 'modal', { fields: { range: '80 - 120' } }); await bot.component(answer.i);
  assert.deepEqual([store.get('123')?.preferences.minReceiveValue, store.get('123')?.preferences.maxReceiveValue], [80, 120]);
  assert.match(json(answer.calls.find(c => c.method === 'editReply')?.body), /1 person you can trade with/, 'the answer hands straight over to the search');
  // The answer is remembered, so the next search goes ahead without asking again.
  bot['lastSearch'].clear();
  const again = component(ids.build('find', 'upgrade', '-', 1)); await bot.component(again.i);
  assert.notEqual(again.last()?.method, 'showModal'); assert.match(json(again.calls.find(c => c.method === 'editReply')?.body), /1 person you can trade with/);
  store.close();
});

test('the alerts panel sets how many trades each check may DM, next to the on/off toggle', async () => {
  const store = new Store(':memory:'); store.save(profile()); const bot = new Bot(store, new SearchService(fixtureProvider()));
  const panel = component(ids.build('alerts', 'on')); await bot.component(panel.i);
  assert.match(json(panel.last()?.body), /tf:alertrate/, 'the rate picker sits on the same panel as the toggle');
  assert.match(json(panel.last()?.body), /up to \*\*3\*\* per check/);
  const faster = component(ids.build('alertrate'), 'select', { values: ['8'] }); await bot.component(faster.i);
  assert.equal(store.get('123')?.preferences.alertsPerScan, 8);
  assert.match(json(faster.last()?.body), /Sending up to \*\*8\*\* trades per check/); assert.match(json(faster.last()?.body), /at most 240 an hour/);
  // A slower check interval is quoted honestly rather than assuming one scan a minute.
  const slow = new Bot(store, new SearchService(fixtureProvider()), 180);
  const quoted = component(ids.build('alertrate'), 'select', { values: ['1'] }); await slow.component(quoted.i);
  assert.equal(store.get('123')?.preferences.alertsPerScan, 1); assert.match(json(quoted.last()?.body), /a check runs every 3 minutes · at most 20 an hour/);
  store.close();
});

test('the Filters form carries the "any item in your range" box, and typing there is the same setting as the finder form', async () => {
  const store = new Store(':memory:'); store.save(profile()); const bot = new Bot(store, new SearchService(finderProvider()));
  const open = component(ids.build('sfiltersmodal', 'upgrade', '-', 3)); await bot.component(open.i);
  assert.equal(open.last()?.method, 'showModal');
  assert.match(json(open.last()?.body), /Any item in your range/); assert.doesNotMatch(json(open.last()?.body), /Receive value range/);
  assert.match(json(open.last()?.body), /blank = what your items can afford/);
  const save = component(ids.build('sfilters', 'upgrade', '-', 3), 'modal', {
    fields: { downgradeRange: '', upgradeRange: '', receiveRange: '80 - 120', maxAdAgeMinutes: '60' },
  }); await bot.component(save.i);
  assert.deepEqual([store.get('123')?.preferences.affordable, store.get('123')?.preferences.minReceiveValue, store.get('123')?.preferences.maxReceiveValue], [true, 80, 120],
    'the same three preferences the price-range form writes');
  assert.match(json(save.last()?.body), /Any item worth 80 – 120/); assert.match(json(save.last()?.body), /80 – 120 · your range/);
  // Having answered there, the finder searches without asking again.
  const search = component(ids.build('find', 'upgrade', '-', 1)); await bot.component(search.i);
  assert.notEqual(search.last()?.method, 'showModal');
  assert.match(json(search.calls.find(c => c.method === 'editReply')?.body), /1 person you can trade with/);
  store.close();
});

test('every range box rejects what it cannot use and explains why, saving nothing in the meantime', async () => {
  const store = new Store(':memory:'); store.save(profile()); const bot = new Bot(store, new SearchService(finderProvider()));
  const filters = (receiveRange: string, extra: Record<string, string> = {}) => component(ids.build('sfilters', 'upgrade', '-', 3), 'modal', {
    fields: { downgradeRange: '', upgradeRange: '', receiveRange, maxAdAgeMinutes: '60', ...extra },
  });
  for (const [typed, expected] of [
    ['5000 - 1000', /range is backwards: 5,000 is more than 1,000/],
    ['1.2.3', /`1\.2\.3` is not a valid amount/],
    ['1000 - 2000 - 3000', /A range has at most two parts/],
    ['nonsense item', /No Rolimons-tracked limited matched/],
    ['- -5000', /\*\*Any item in your range\*\* must be at least 0/],
  ] as const) {
    const bad = filters(typed); await bot.component(bad.i);
    assert.match(json(bad.last()?.body), expected, `"${typed}" should be explained`);
    assert.equal(store.get('123')?.preferences.minReceiveValue, null, `"${typed}" must not be saved`);
  }
  // Percentages get their own wording, and the per-item rule form is validated the same way.
  const pct = filters('', { upgradeRange: 'abc%' }); await bot.component(pct.i);
  assert.match(json(pct.last()?.body), /`abc%` is not a percentage/);
  const rule = component(ids.build('itemrule'), 'modal', { fields: { item: 'I30', range: '900000000000' } }); await bot.component(rule.i);
  assert.match(json(rule.last()?.body), /\*\*Profit range when receiving\*\* must be at most 1,000,000,000/);
  assert.deepEqual(store.get('123')?.preferences.itemRules, {});
  // The price-range form is the same setting, so it refuses the same values.
  const price = component(ids.build('range', 'upgrade', 3, 'panel'), 'modal', { fields: { range: '- -20' } }); await bot.component(price.i);
  assert.match(json(price.last()?.body), /\*\*Any item in your range\*\* must be at least 0/);
  assert.equal(store.get('123')?.preferences.affordable, false, 'a rejected answer does not switch the filter on either');
  store.close();
});

test('settings links to Rolimons from the username, with no separate Rolimons button', async () => {
  const user = profile();
  const plain = settingsMessage(user);
  assert.equal(plain.embeds[0]!.toJSON().author?.url, 'https://www.rolimons.com/player/1');
  assert.doesNotMatch(json(plain.components.map(c => c.toJSON())), /rolimons/i, 'the link button is gone from the row');
  // Once the logo is uploaded as an application emoji it becomes the author icon; until then the avatar stands in.
  const { setStatIcons } = await import('../src/presentation.js');
  setStatIcons({ rolimonsIcon: 'https://cdn.discordapp.com/emojis/123.png' });
  assert.equal(settingsMessage(user).embeds[0]!.toJSON().author?.icon_url, 'https://cdn.discordapp.com/emojis/123.png');
  setStatIcons({ rolimonsIcon: '' });
  assert.equal(settingsMessage(user, undefined, 'https://tr.rbxcdn.com/a.png').embeds[0]!.toJSON().author?.icon_url, 'https://tr.rbxcdn.com/a.png');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { diffInventory } from '../src/changes.js';
import { Store } from '../src/store.js';
import { Monitor } from '../src/monitor.js';
import { SearchService } from '../src/search.js';
import { alertsMessage, inventoryChangeMessage, settingsMessage } from '../src/presentation.js';
import { renderInventoryChangeCard } from '../src/render.js';
import { fixtureProvider, inventory, item, profile } from './fixtures.js';

const items = new Map([item(10, 50), item(20, 50), item(30, 110)].map(i => [i.id, i]));

test('diffInventory matches copies by unique ID, ignores hold changes and prices untracked items by Roblox RAP', () => {
  const before = [{ assetId: 10, userAssetId: 1, onHold: false }, { assetId: 20, userAssetId: 2, onHold: false }, { assetId: 10, userAssetId: 3, onHold: false }];
  assert.equal(diffInventory(before, before.map(h => ({ ...h, onHold: true })), items), null);
  // Copy 2 (item 20, value 50) left; a copy of item 30 (110) and an untracked hat (Roblox RAP 40) arrived.
  const after = [before[0]!, before[2]!, { assetId: 30, userAssetId: 9, onHold: false }, { assetId: 777, userAssetId: 8, onHold: false, name: 'Plain Hat', robloxRap: 40 }];
  const c = diffInventory(before, after, items)!;
  assert.equal(c.kind, 'trade');
  assert.deepEqual(c.removed.map(x => x.userAssetId), [2]); assert.deepEqual(c.added.map(x => x.userAssetId), [9, 8]);
  assert.equal(c.added[1]!.item.name, 'Plain Hat'); assert.equal(c.added[1]!.item.rap, 40); assert.equal(c.added[1]!.item.value, null);
  assert.equal(c.lost.value, 50); assert.equal(c.gained.value, 150); assert.equal(c.valueGain, 100); assert.equal(c.valueGainPct, 200);
  assert.deepEqual(c.before, { copies: 3, value: 150, rap: 150 }); assert.deepEqual(c.after, { copies: 4, value: 250, rap: 250 });
  assert.equal(c.unpriced, 0);
  // One-sided changes: a sale has no percentage base; a purchase gains from nothing.
  const sold = diffInventory(before, [before[0]!, before[2]!], items)!;
  assert.equal(sold.kind, 'out'); assert.equal(sold.valueGain, -50); assert.equal(sold.valueGainPct, null);
  const bought = diffInventory(before, [...before, { assetId: 30, userAssetId: 9, onHold: false }], items)!;
  assert.equal(bought.kind, 'in'); assert.equal(bought.valueGain, 110); assert.equal(bought.valueGainPct, null);
});
test('inventory-change message and card render for every change kind, with a text fallback when no card is attached', async () => {
  const user = profile();
  const before = [{ assetId: 10, userAssetId: 1, onHold: false }, { assetId: 20, userAssetId: 2, onHold: false }];
  for (const [after, kind, title] of [
    [[before[0]!, { assetId: 30, userAssetId: 9, onHold: false }], 'trade', /🔁 Trade detected · \+60 value \(\+120%\)/],
    [[before[0]!], 'out', /📤 1 copy left your inventory · -50 value/],
    [[...before, { assetId: 30, userAssetId: 9, onHold: false }], 'in', /📥 1 new copy in your inventory · \+110 value/],
  ] as const) {
    const change = diffInventory(before, [...after], items)!;
    assert.equal(change.kind, kind);
    const card = inventoryChangeMessage(user, change, { card: true }).embeds[0]!.toJSON();
    assert.match(card.title!, title); assert.equal(card.image?.url, 'attachment://inventory-change.png');
    const text = inventoryChangeMessage(user, change, { card: false }).embeds[0]!.toJSON();
    assert.ok(text.fields!.some(f => f.name.startsWith('📤 Out')) && text.fields!.some(f => f.name.startsWith('📥 In')));
    assert.match(JSON.stringify(inventoryChangeMessage(user, change).components.map(c => c.toJSON())), /tf:invalerts:off/);
    const png = await renderInventoryChangeCard(change, new Map());
    assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  }
});
test('store persists the inventory-DM flag and snapshots, migrates old databases, and clears snapshots on forget or account switch', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tradefinder-'));
  try {
    const path = join(dir, 'old.sqlite');
    // A database from before inventory alerts existed: no inventory_alerts column, no snapshot table.
    const legacy = new DatabaseSync(path);
    legacy.exec(`CREATE TABLE users (discord_id TEXT PRIMARY KEY, roblox_id INTEGER NOT NULL, username TEXT NOT NULL, preferences TEXT NOT NULL, alerts INTEGER NOT NULL DEFAULT 0, alert_error TEXT);
      INSERT INTO users VALUES ('123', 1, 'Old', '{}', 1, NULL);`);
    legacy.close();
    let store = new Store(path);
    let user = store.get('123')!; assert.equal(user.inventoryAlerts, false); assert.equal(user.alerts, true);
    user.inventoryAlerts = true; store.save(user);
    store.saveSnapshot('123', [{ assetId: 10, userAssetId: 1, onHold: false }], 5); store.close();
    store = new Store(path);
    user = store.get('123')!; assert.equal(user.inventoryAlerts, true); assert.deepEqual(store.inventoryWatchers().map(u => u.discordId), ['123']);
    assert.deepEqual(store.snapshot('123'), { holdings: [{ assetId: 10, userAssetId: 1, onHold: false }], takenAt: 5 });
    store.link('123', 1, 'Renamed'); assert.ok(store.snapshot('123'));
    store.link('123', 2, 'Other'); assert.equal(store.snapshot('123'), undefined); assert.equal(store.get('123')!.inventoryAlerts, false);
    store.saveSnapshot('123', [], 6); store.forget('123'); assert.equal(store.snapshot('123'), undefined);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('monitor takes a baseline first, DMs each verified change once, retries failures and handles a verified empty inventory', async () => {
  const store = new Store(':memory:'); const user = profile(); user.inventoryAlerts = true; store.save(user);
  const provider = fixtureProvider(); const sent: { kind: string; valueGain: number }[] = []; let fail = false;
  const monitor = new Monitor(store, new SearchService(provider), async () => {}, 1000, async (_u, change) => { if (fail) throw new Error('transient'); sent.push({ kind: change.kind, valueGain: change.valueGain }); });
  await monitor.tick(); assert.equal(sent.length, 0); assert.equal(store.snapshot(user.discordId)?.holdings.length, 2);
  await monitor.tick(); assert.equal(sent.length, 0);
  // Copy of item 20 traded for a copy of item 30 (+60).
  provider.inventories.set(1, { ...inventory(1, [10]), holdings: [{ assetId: 10, userAssetId: 100, onHold: false }, { assetId: 30, userAssetId: 500, onHold: false }] });
  fail = true; await monitor.tick(); assert.equal(sent.length, 0); assert.match(store.get(user.discordId)?.alertError ?? '', /Inventory check failed/);
  fail = false; await monitor.tick(); assert.deepEqual(sent, [{ kind: 'trade', valueGain: 60 }]);
  await monitor.tick(); assert.equal(sent.length, 1);
  provider.inventories.set(1, inventory(1, [])); await monitor.tick(); assert.equal(sent.length, 2);
  assert.equal(sent[1]!.kind, 'out');
  assert.equal(store.snapshot(user.discordId)?.holdings.length, 0);
  // Blocked DMs switch the feature off; a user who turned it off mid-scan is not told anything.
  const blocked = new Monitor(store, new SearchService(provider), async () => {}, 1000, async () => { throw Object.assign(new Error('blocked'), { code: 50007 }); });
  provider.inventories.set(1, inventory(1, [10, 20, 30])); await blocked.tick();
  assert.equal(store.get(user.discordId)?.inventoryAlerts, false); assert.match(store.get(user.discordId)?.alertError ?? '', /DMs are blocked/);
  await monitor.tick(); assert.equal(sent.length, 2);
  await monitor.stop(); await blocked.stop(); store.close();
});

test('inventory DMs rebaseline legacy snapshots, track bundle UUIDs and preserve snapshots when verification fails', async () => {
  const store = new Store(':memory:'), user = profile(); user.inventoryAlerts = true; store.save(user);
  const provider = fixtureProvider(), original = provider.inventory.bind(provider);
  store.saveSnapshot(user.discordId, inventory(1, [10]).holdings, 1);
  provider.inventory = async (id, age, viewer) => {
    assert.equal(age, 0); assert.equal(viewer?.discordId, user.discordId);
    return original(id);
  };
  const bundle = { assetId: 10, userAssetId: 'bundle', collectibleItemInstanceId: 'bundle',
    itemTarget: { itemType: 'Bundle' as const, targetId: '999' }, onHold: false, tradable: true };
  provider.inventories.set(1, { ...inventory(1, [10]), holdings: [bundle] });
  let sent = 0;
  const monitor = new Monitor(store, new SearchService(provider), async () => {}, 1000, async (_user, change) => {
    sent++; assert.equal(change.removed[0]!.tradable, false);
    const text = JSON.stringify(inventoryChangeMessage(user, change).embeds[0]!.toJSON());
    assert.match(text, /Not tradable/);
  });
  try {
    await monitor.tick(); assert.equal(sent, 0); assert.equal(store.snapshot(user.discordId)?.verified, true);
    const saved = store.snapshot(user.discordId);
    provider.inventories.set(1, { ...inventory(1, []), tradabilityError: 'Verification failed.' });
    await monitor.tick(); assert.equal(sent, 0); assert.deepEqual(store.snapshot(user.discordId), saved);
    provider.inventories.set(1, inventory(1, []));
    await monitor.tick(); assert.equal(sent, 1);
  } finally { await monitor.stop(); store.close(); }
});

test('a different authenticated copy is detected even when the legacy public row stays stale', () => {
  const old = { ...inventory(1, [10]).holdings[0]!, collectibleItemInstanceId: 'sold' };
  const current = { ...old, collectibleItemInstanceId: 'bought' };
  const change = diffInventory([old], [current], items)!;
  assert.equal(change.removed[0]!.collectibleItemInstanceId, 'sold');
  assert.equal(change.added[0]!.collectibleItemInstanceId, 'bought');
  // A copy that left keeps the status it had when last seen.
  assert.equal(change.removed[0]!.tradable, true);
  assert.equal(change.added[0]!.tradable, true);
});
test('inventory recaps ignore permanently untradable copies but still report held ones, labelled On hold', async () => {
  const tradable = { assetId: 10, userAssetId: 1, onHold: false, tradable: true };
  const classic = { assetId: 20, userAssetId: 2, onHold: false, tradable: false };
  const held = { assetId: 30, userAssetId: 3, onHold: true, tradable: false };
  // An untradable copy leaving, arriving or both is not a change worth a DM, and never counts in the totals.
  assert.equal(diffInventory([tradable, classic], [tradable], items), null);
  assert.equal(diffInventory([tradable], [tradable, classic], items), null);
  const change = diffInventory([tradable, classic], [held, { ...classic, userAssetId: 4 }], items)!;
  assert.equal(change.kind, 'trade');
  assert.deepEqual(change.removed.map(c => c.userAssetId), [1]);
  assert.deepEqual(change.added.map(c => c.userAssetId), [3]);
  assert.deepEqual(change.before, { copies: 1, value: 50, rap: 50 });
  assert.deepEqual(change.after, { copies: 1, value: 110, rap: 110 });
  const text = inventoryChangeMessage(profile(), change, { card: false }).embeds[0]!.toJSON();
  const fields = JSON.stringify(text.fields);
  assert.match(fields, /⏳ On hold/);
  assert.doesNotMatch(fields, /Not tradable/);
  const png = await renderInventoryChangeCard(change, new Map());
  assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
});
test('the alerts panel owns both DM toggles and their history; settings only links to it', () => {
  const user = profile();
  const alertsJson = () => JSON.stringify(alertsMessage(user).components.map(c => c.toJSON()));
  assert.match(alertsJson(), /tf:invalerts:on/);
  user.inventoryAlerts = true;
  assert.match(alertsJson(), /tf:invalerts:off/);
  assert.match(JSON.stringify(alertsMessage(user).embeds[0]!.toJSON()), /Inventory DMs/);
  assert.match(JSON.stringify(alertsMessage(user).embeds[0]!.toJSON()), /none yet/);
  assert.match(JSON.stringify(alertsMessage(user, 60, undefined, 1_700_000_000_000).embeds[0]!.toJSON()), /<t:1700000000:R>/);
  user.alertError = 'DMs are blocked.';
  assert.match(JSON.stringify(alertsMessage(user).embeds[0]!.toJSON()), /Last alert issue/);
  // Settings carries no DM controls of its own, just a tab to the panel that does.
  const settings = JSON.stringify(settingsMessage(user).components.map(c => c.toJSON()));
  assert.match(settings, /tf:view:alerts/);
  assert.doesNotMatch(settings, /tf:invalerts|tf:alerts:|tf:mode:|tf:demand/);
  assert.doesNotMatch(JSON.stringify(settingsMessage(user).embeds[0]!.toJSON()), /Inventory DMs|Min demand|"name":"Mode"/);
});

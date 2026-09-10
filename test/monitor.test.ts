import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Monitor } from '../src/monitor.js';
import { SearchService } from '../src/search.js';
import { fixtureProvider, profile } from './fixtures.js';

test('SQLite saves preferences and deduplication across restarts; forget removes both', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tradefinder-'));
  try {
    const path = join(dir, 'test.sqlite'); let store = new Store(path);
    const user = profile(); user.preferences.targetIds = [30]; store.save(user); store.markSent(user.discordId, 'abc'); store.close();
    store = new Store(path); assert.deepEqual(store.get(user.discordId)?.preferences.targetIds, [30]); assert.equal(store.seen(user.discordId, 'abc'), true);
    assert.equal(store.seen(user.discordId, 'abc', Date.now() + 86_400_001), false);
    store.forget(user.discordId); assert.equal(store.get(user.discordId), undefined); assert.equal(store.seen(user.discordId, 'abc'), false); store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('linking same account preserves settings; switching accounts clears targets and alerts', () => {
  const store = new Store(':memory:'); const user = profile(); user.alerts = true; user.preferences.targetIds = [30]; store.save(user);
  assert.equal(store.link(user.discordId, user.robloxId, 'Renamed').alerts, true);
  const changed = store.link(user.discordId, 99, 'Different'); assert.equal(changed.alerts, false); assert.deepEqual(changed.preferences.targetIds, []); store.close();
});
test('monitor requires opt-in, deduplicates recommendations, and persists delivery history', async () => {
  const store = new Store(':memory:'); const user = profile(); store.save(user); let sends = 0;
  const monitor = new Monitor(store, new SearchService(fixtureProvider()), async () => { sends++; });
  await monitor.tick(); assert.equal(sends, 0);
  user.alerts = true; store.save(user);
  await Promise.all([monitor.tick(), monitor.tick()]); await monitor.tick(); assert.equal(sends, 1);
  await monitor.stop(); store.close();
});
test('failed DM is not marked sent, retries transient errors and disables blocked DMs', async () => {
  const store = new Store(':memory:'); const user = profile(); user.alerts = true; store.save(user); let calls = 0;
  const monitor = new Monitor(store, new SearchService(fixtureProvider()), async () => { calls++; if (calls === 1) throw new Error('transient'); });
  await monitor.tick(); assert.equal(store.get(user.discordId)?.alerts, true); assert.match(store.get(user.discordId)?.alertError ?? '', /delivery failed/);
  await monitor.tick(); assert.equal(calls, 2); assert.equal(store.get(user.discordId)?.alertError, null);
  store.forget(user.discordId); store.save(user);
  const blocked = new Monitor(store, new SearchService(fixtureProvider()), async () => { throw Object.assign(new Error('blocked'), { code: 50007 }); });
  await blocked.tick(); assert.equal(store.get(user.discordId)?.alerts, false); assert.match(store.get(user.discordId)?.alertError ?? '', /DMs are blocked/);
  await monitor.stop(); await blocked.stop(); store.close();
});
test('disabling alerts, changing preferences or forgetting during a search prevents delivery', async () => {
  for (const action of ['disable', 'change', 'forget']) {
    const store = new Store(':memory:'); const user = profile(); user.alerts = true; store.save(user);
    const provider = fixtureProvider(), original = provider.inventory.bind(provider); let sent = false;
    provider.inventory = async id => {
      if (id === 2) {
        if (action === 'forget') store.forget(user.discordId);
        else { const current = store.get(user.discordId)!; if (action === 'disable') current.alerts = false; else current.preferences.targetIds = [999]; store.save(current); }
      }
      return original(id);
    };
    const monitor = new Monitor(store, new SearchService(provider), async () => { sent = true; });
    await monitor.tick(); assert.equal(sent, false);
    if (action === 'forget') assert.equal(store.get(user.discordId), undefined);
    await monitor.stop(); store.close();
  }
});

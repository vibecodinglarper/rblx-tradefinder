import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { startHealthServer, type HealthReport } from '../src/health.js';

const ok = (): HealthReport => ({ discord: true, lastScanAt: Date.now(), archive: { count: 12, minutes: 90, bytes: 2 * 1048576 } });

test('the health endpoint reports readiness without leaking anything, and fails a wedged process', async () => {
  let state = ok();
  // Port 0 means "switched off" in the config, so the test binds a real high port instead of an ephemeral one.
  const port = 23000 + Math.floor(Math.random() * 2000);
  const server = startHealthServer(port, () => state)!;
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  assert.equal((server.address() as AddressInfo).port, port);
  const call = async (path = '/health', method = 'GET') => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method });
    return { status: response.status, body: await response.text() };
  };
  const healthy = await call();
  assert.equal(healthy.status, 200);
  const json = JSON.parse(healthy.body);
  assert.equal(json.status, 'ok'); assert.equal(json.discord, 'connected');
  assert.deepEqual(json.archive, { ads: 12, reachMinutes: 90, megabytes: 2 });
  assert.doesNotMatch(healthy.body, /token|discord_id|\d{17,}/i, 'nothing about the account or its users is exposed');
  // A gateway drop and a monitor that has stopped finishing scans both read as unhealthy, so a platform restarts it.
  state = { ...ok(), discord: false };
  assert.equal((await call()).status, 503);
  state = { ...ok(), lastScanAt: Date.now() - 3_600_000 };
  assert.equal((await call()).status, 503);
  // Starting up, before any scan has finished, is healthy.
  state = { ...ok(), lastScanAt: null };
  assert.equal((await call()).status, 200);
  assert.equal((await call('/healthz')).status, 200);
  assert.equal((await call('/nope')).status, 404);
  assert.equal((await call('/health', 'POST')).status, 405);
  assert.equal((await call('/health', 'HEAD')).body, '');
  assert.equal(startHealthServer(0, ok), null, 'port 0 leaves it switched off');
  await new Promise(resolve => server.close(resolve));
});

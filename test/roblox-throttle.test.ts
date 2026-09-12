import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inventoryRoute, retryDelay, robloxRoute, RobloxThrottle } from '../src/roblox-throttle.js';
import { RobloxRateLimitError, RobloxTradesClient, type TradeRequest } from '../src/trading.js';

const epoch = 1_000_000;
function clock() {
  let now = epoch;
  const sleeps: number[] = [];
  return { now: () => now, sleeps, sleep: async (ms: number) => { sleeps.push(ms); now += ms; } };
}
function inventory(owner: number) {
  const itemTarget = { itemType: 'Asset', targetId: '10' };
  return new Response(JSON.stringify({ userId: owner, items: [{ itemTarget, instances: [{ itemTarget, collectibleItemInstanceId: `instance-${owner}`, isOnHold: false }] }], nextPageCursor: '' }));
}
const body: TradeRequest = { senderOffer: { userId: 1, robux: 0, collectibleItemInstanceIds: ['one'] }, recipientOffer: { userId: 2, robux: 0, collectibleItemInstanceIds: ['two'] } };
const limited = (after = '5') => new Response(JSON.stringify({ errors: [{ code: 0 }] }), { status: 429, headers: { 'retry-after': after } });

test('sender and recipient inventory requests share pacing across users, clients and cursor pages', async () => {
  const timer = clock(), throttle = new RobloxThrottle(timer), starts: number[] = [];
  let finishFirst!: () => void;
  const gate = new Promise<void>(resolve => { finishFirst = resolve; });
  const fetcher: typeof fetch = async url => {
    starts.push(timer.now());
    if (starts.length === 1) await gate;
    return inventory(Number(new URL(String(url)).pathname.split('/')[3]));
  };
  const sender = new RobloxTradesClient('secret', fetcher, epoch + 120_000, throttle);
  const recipient = new RobloxTradesClient('secret', fetcher, epoch + 120_000, throttle);
  const reads = Promise.all([sender.instances(1, [10]), recipient.instances(2, [10])]);
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(starts.length, 1, 'only one inventory request may be in flight');
  finishFirst();
  assert.deepEqual(await reads, [['instance-1'], ['instance-2']]);
  assert.ok(starts[1]! - starts[0]! >= 5500);
  assert.equal(robloxRoute('/v2/users/123/tradableItems?cursor=private'), inventoryRoute);
});

test('an inventory 429 waits out Retry-After and retries the read automatically with progress', async () => {
  const timer = clock(), throttle = new RobloxThrottle(timer), starts: number[] = [], progress: string[] = [];
  const client = new RobloxTradesClient('secret', async (_url, init) => {
    assert.equal(init?.method, 'GET'); starts.push(timer.now());
    return starts.length === 1 ? limited('7') : inventory(1);
  }, epoch + 120_000, throttle, async message => { progress.push(message); });
  assert.deepEqual(await client.instances(1, [10]), ['instance-1']);
  assert.equal(starts.length, 2); assert.ok(starts[1]! - starts[0]! >= 7000);
  assert.match(progress[0]!, /wait 7 seconds during inventory checks/);
});

test('persistent read throttling stops after two retries with the correct operation and remaining wait', async () => {
  const timer = clock(); let requests = 0;
  const client = new RobloxTradesClient('secret', async () => { requests++; return limited(); }, epoch + 120_000, new RobloxThrottle(timer));
  await assert.rejects(client.instances(1, [10]), error => error instanceof RobloxRateLimitError && error.retryAt === timer.now() + 5000 && /inventory checks.*5 seconds/.test(error.message));
  assert.equal(requests, 3);
});

test('a long Retry-After stops immediately instead of waiting beyond the offer lifetime', async () => {
  const timer = clock(); let requests = 0;
  const client = new RobloxTradesClient('secret', async () => { requests++; return limited('300'); }, epoch + 120_000, new RobloxThrottle(timer));
  await assert.rejects(client.instances(1, [10]), /300 seconds/);
  assert.equal(requests, 1); assert.deepEqual(timer.sleeps, []);
});

test('trade POSTs are never retried on 429 and their cooldown carries over to the next explicit attempt', async () => {
  const timer = clock(), throttle = new RobloxThrottle(timer), starts: number[] = [];
  const fetcher: typeof fetch = async () => {
    starts.push(timer.now());
    return starts.length === 1 ? limited('10') : new Response(JSON.stringify({ tradeId: 123 }));
  };
  const client = new RobloxTradesClient('secret', fetcher, epoch + 120_000, throttle);
  await assert.rejects(client.send(body), /trade sending.*10 seconds/);
  assert.equal(starts.length, 1);
  const later = new RobloxTradesClient('secret', fetcher, epoch + 120_000, throttle);
  assert.equal(await later.send(body), 123);
  assert.equal(starts.length, 2); assert.ok(starts[1]! - starts[0]! >= 10_000);
});

test('a queued request that would outlive its deadline never reaches Roblox', async () => {
  const timer = clock(), throttle = new RobloxThrottle(timer);
  throttle.pause(inventoryRoute, 30_000);
  const client = new RobloxTradesClient('secret', async () => { assert.fail('Expired request must not run'); }, epoch + 10_000, throttle);
  await assert.rejects(client.instances(1, [10]), /expired/);
  assert.deepEqual(timer.sleeps, []);
});

test('Retry-After supports seconds, HTTP dates and a safe fallback', () => {
  assert.equal(retryDelay('5', epoch), 5000);
  assert.equal(retryDelay(new Date(epoch + 12_000).toUTCString(), epoch), 12_000);
  assert.equal(retryDelay(null, epoch), 5000);
  assert.equal(retryDelay('not-a-date', epoch), 5000);
  assert.equal(retryDelay('0', epoch), 1000);
});

test('GET error code 14 is not mislabeled as a trade-send limit', async () => {
  let requests = 0;
  const client = new RobloxTradesClient('secret', async () => {
    requests++; return new Response(JSON.stringify({ errors: [{ code: 14 }] }), { status: 400 });
  }, epoch + 120_000, new RobloxThrottle(clock()));
  await assert.rejects(client.instances(1, [10]), /HTTP 400/);
  assert.equal(requests, 1);
});

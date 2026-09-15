import { AttachmentBuilder, Client, Events, GatewayIntentBits } from 'discord.js';
import { config } from './config.js';
import { Providers } from './providers.js';
import { TradingService } from './trading.js';
import { SearchService } from './search.js';
import { Store } from './store.js';
import { Bot } from './bot.js';
import { Monitor } from './monitor.js';
import { startHealthServer, type HealthReport } from './health.js';
import { openFirestore } from './firestore.js';
import { alertMessage, inventoryChangeMessage, setStatIcons } from './presentation.js';
import { bucketOf } from './engine.js';
import { iconPng, renderInventoryChangeCard, renderTradeCard } from './render.js';

/** Uploads the Rolimons and old Robux icons as application emojis once, then uses them in text panels. */
async function ensureIcons(client: Client): Promise<void> {
  try {
    const app = client.application;
    if (!app) return;
    const existing = await app.emojis.fetch();
    const emoji = async (name: string, file: string) =>
      existing.find(e => e.name === name) ?? await app.emojis.create({ name, attachment: await iconPng(file) });
    const rolimons = await emoji('rolimons', 'rolimons.svg');
    const robux = await emoji('robux', 'robux-2014.svg');
    // Embed author lines take an image URL, not an emoji tag, so the same upload is kept in both shapes.
    setStatIcons({ value: `<:${rolimons.name}:${rolimons.id}>`, rap: `<:${robux.name}:${robux.id}>`,
      rolimonsIcon: `https://cdn.discordapp.com/emojis/${rolimons.id}.png` });
  } catch (error) { console.error('Icon emojis unavailable; using text labels:', error instanceof Error ? error.message : 'Unknown error'); }
}

/** Hosted logs are read in an aggregator long after the fact, where an untimed line says very little. */
function stampLogs(): void {
  for (const level of ['log', 'warn', 'error'] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => original(new Date().toISOString(), ...args);
  }
}

async function main() {
  stampLogs();
  const env = config();
  const policy = { hours: env.AD_ARCHIVE_HOURS, maxAds: env.AD_ARCHIVE_MAX_ADS };
  const store = new Store(env.DATABASE_PATH, policy, env.ROBLOX_CREDENTIAL_KEY);
  // With a service account the ad archive lives in Firestore, so it follows the bot from host to host; without one it stays in SQLite.
  const firestore = env.FIREBASE_SERVICE_ACCOUNT || env.FIREBASE_SERVICE_ACCOUNT_JSON
    ? openFirestore({ serviceAccountPath: env.FIREBASE_SERVICE_ACCOUNT, serviceAccountJson: env.FIREBASE_SERVICE_ACCOUNT_JSON, prefix: env.FIRESTORE_PREFIX }, policy) : null;
  const archive = firestore?.archive ?? store;
  if (firestore) {
    const loaded = await firestore.archive.load();
    // First start after switching over: carry the SQLite window across rather than beginning the day empty.
    const seeded = loaded ? 0 : firestore.archive.saveAds(store.recentAds(policy.hours * 3_600_000));
    const a = firestore.archive.stats();
    console.log(`Firestore archive loaded from project ${firestore.projectId}: ${loaded} ads${seeded ? ` (seeded ${seeded} from SQLite)` : ''}, back ${a.minutes} min.`);
  }
  const client = new Client({ intents: [GatewayIntentBits.Guilds], allowedMentions: { parse: [] } });
  const trading = new TradingService(store);
  const providers = new Providers(undefined, (owner, viewer, maxAgeMs) => trading.inventory(owner, viewer, maxAgeMs));
  const search = new SearchService(providers, env.MAX_SELLERS_PER_SEARCH, archive);
  // The API holds about three minutes of ads, so polling every 60 s captures every ad with margin even without the trades page.
  let lastCollectedAt = 0;
  const collect = async () => {
    try {
      const added = archive.saveAds((await providers.ads()).data);
      // Roll the window forward on the same beat the ads arrive on, so the newest always displace the oldest.
      archive.prune();
      if (archive !== store) store.prune();
      const now = Date.now();
      if (lastCollectedAt && now - lastCollectedAt > 170_000) console.warn(`Ad feed gap: ${Math.round((now - lastCollectedAt) / 1000)} s between successful polls; some ads may be missing.`);
      lastCollectedAt = now;
      if (added) {
        const a = archive.stats();
        console.log(`Archived ${added} new trade ads (${a.count} of max ${a.maxAds} kept, back ${a.minutes} min, ${(a.bytes / 1048576).toFixed(1)} MB ${a.storage === 'firestore' ? 'in Firestore' : 'on disk'}).`);
      }
    } catch (error) { console.error('Ad collection failed:', error instanceof Error ? error.message : 'Unknown error'); }
  };
  const collector = setInterval(() => { void collect(); }, 60_000);
  const bot = new Bot(store, search, env.POLL_INTERVAL_SECONDS, trading);
  const monitor = new Monitor(store, search, async (id, r, owner) => {
    const user = await client.users.fetch(id);
    // Same card as the trade finder; the rendered image is decoration, so a render failure falls back to text.
    const character = await providers.character(r.ad.userId).catch(() => null);
    let files: AttachmentBuilder[] = [];
    try {
      const thumbnails = await providers.thumbnails([...r.give, ...r.receive].map(c => c.assetId)).catch(() => new Map<number, Buffer>());
      files = [new AttachmentBuilder(await renderTradeCard(r, thumbnails, bucketOf(r)), { name: 'trade-1.png' })];
    } catch (error) { console.error('Alert card failed:', error instanceof Error ? error.message : 'Unknown error'); }
    // The DM's Place Trade button sends this exact offer; the bot keeps it for 15 minutes under a token the button carries.
    const placeToken = bot.alertOffer(id, r, owner.robloxId);
    await user.send({ ...alertMessage(r, { card: files.length > 0, character, placeToken }), files });
    console.log(`Alert DM sent to ${id}: seller ${r.ad.userId}, ${r.valueGain >= 0 ? '+' : ''}${r.valueGain} value.`);
  }, env.POLL_INTERVAL_SECONDS * 1000, async (user, change, checkedAt) => {
    const recipient = await client.users.fetch(user.discordId);
    const avatar = await providers.avatar(user.robloxId).catch(() => null);
    // The rendered card is decoration: if it fails, the text version still goes out.
    let files: AttachmentBuilder[] = [];
    try {
      const thumbnails = await providers.thumbnails([...change.removed, ...change.added].map(c => c.assetId)).catch(() => new Map<number, Buffer>());
      files = [new AttachmentBuilder(await renderInventoryChangeCard(change, thumbnails), { name: 'inventory-change.png' })];
    } catch (error) { console.error('Inventory change card failed:', error instanceof Error ? error.message : 'Unknown error'); }
    await recipient.send({ ...inventoryChangeMessage(user, change, { avatar, card: files.length > 0, checkedAt }), files });
    console.log(`Inventory DM sent to ${user.discordId}: ${change.removed.length} out, ${change.added.length} in.`);
  });
  const report = (): HealthReport => ({ discord: client.isReady(), lastScanAt: monitor.lastCompletedAt, archive: archive.stats(), archiveError: firestore?.archive.lastError ?? null });
  const health = startHealthServer(env.HEALTH_PORT, report);
  // The heartbeat is the same report, written to Firestore each minute so the console shows the bot is alive.
  const beat = async () => { try { await firestore?.heartbeat.beat(report(), { archiveError: firestore.archive.lastError }); } catch (error) { console.error('Heartbeat failed:', error instanceof Error ? error.message : 'Unknown error'); } };
  const pulse = firestore ? setInterval(() => { void beat(); }, 60_000) : undefined;
  // The watchdog covers hosts with no health-check probe: a gateway that stays down or scans that stop finishing end the
  // process, and the supervisor (compose's restart policy, systemd, the platform) brings it straight back.
  const staleMs = env.WATCHDOG_MINUTES * 60_000;
  let lastReadyAt = Date.now();
  const watchdog = staleMs ? setInterval(() => {
    const now = Date.now();
    if (client.isReady()) lastReadyAt = now;
    const gatewayDown = now - lastReadyAt > staleMs;
    const scansStalled = monitor.lastCompletedAt !== null && now - monitor.lastCompletedAt > staleMs + env.POLL_INTERVAL_SECONDS * 1000;
    if (!gatewayDown && !scansStalled) return;
    console.error(`Watchdog: ${gatewayDown ? 'gateway down' : 'scans stalled'} for over ${env.WATCHDOG_MINUTES} min; exiting for restart.`);
    void stop(1);
  }, 60_000) : undefined;
  client.once(Events.ClientReady, ready => { console.log(`Tradefinder connected as ${ready.user.tag}`); lastReadyAt = Date.now(); void ensureIcons(client); void collect(); monitor.start(); void beat(); });
  client.on(Events.InteractionCreate, interaction => {
    const task = interaction.isChatInputCommand() ? bot.handle(interaction)
      : interaction.isMessageComponent() || interaction.isModalSubmit() ? bot.component(interaction) : undefined;
    void task?.catch(error => console.error('Interaction error:', error instanceof Error ? error.name : 'Unknown error'));
  });
  client.on(Events.Error, error => console.error('Discord client error:', error.name));
  let closing = false;
  const stop = async (code = 0) => {
    if (closing) return;
    closing = true;
    console.log('Stopping trade monitor…');
    clearInterval(collector); clearInterval(pulse); clearInterval(watchdog);
    health?.close();
    await monitor.stop();
    client.destroy(); store.close();
    // The last poll's buckets may still be in flight; give them a moment rather than dropping them on the floor.
    if (firestore) await Promise.race([firestore.archive.settle().then(() => code ? undefined : firestore.heartbeat.stopped()), new Promise(r => setTimeout(r, 10_000))]).catch(() => undefined);
    process.exit(code);
  };
  process.once('SIGINT', () => { void stop(); }); process.once('SIGTERM', () => { void stop(); });
  try { await client.login(env.DISCORD_TOKEN); }
  catch { clearInterval(collector); clearInterval(pulse); clearInterval(watchdog); health?.close(); await monitor.stop(); client.destroy(); store.close(); throw new Error('Discord login failed. Check DISCORD_TOKEN in .env.'); }
}
void main().catch(error => {
  // Do not dump request objects, environment variables or authentication headers.
  console.error(error instanceof Error ? error.message : 'Startup failed.');
  process.exitCode = 1;
});

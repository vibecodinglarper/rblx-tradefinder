import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { UserError } from './domain.js';
import { defaults, parsePreferences, preferencesSchema, type Holding, type TradeAd, type UserProfile } from './domain.js';

/** How much of the ad feed to keep, and how many rows that may ever become. Both are set from the environment. */
export interface ArchivePolicy { hours: number; maxAds: number }
export const DEFAULT_ARCHIVE: ArchivePolicy = { hours: 24, maxAds: 100_000 };

interface Row { discord_id: string; roblox_id: number; username: string; preferences: string; alerts: number; alert_error: string | null; inventory_alerts: number }
/** The last inventory seen for a user, kept so the monitor can tell which copies left or arrived since. */
export interface InventorySnapshot { holdings: Holding[]; takenAt: number }
export class Store {
  private db: DatabaseSync;
  private archiveMs: number;
  constructor(path: string, private archive: ArchivePolicy = DEFAULT_ARCHIVE, private credentialKey?: string) {
    if (credentialKey && !/^[a-f0-9]{64}$/i.test(credentialKey)) throw new Error('ROBLOX_CREDENTIAL_KEY must contain 64 hexadecimal characters.');
    this.archiveMs = archive.hours * 3_600_000;
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS users (
        discord_id TEXT PRIMARY KEY, roblox_id INTEGER NOT NULL, username TEXT NOT NULL,
        preferences TEXT NOT NULL, alerts INTEGER NOT NULL DEFAULT 0, alert_error TEXT
      );
      CREATE TABLE IF NOT EXISTS alerts (
        discord_id TEXT NOT NULL, signature TEXT NOT NULL, sent_at INTEGER NOT NULL,
        PRIMARY KEY(discord_id, signature)
      );
      CREATE TABLE IF NOT EXISTS ads (id INTEGER PRIMARY KEY, created_at INTEGER NOT NULL, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS ads_created ON ads(created_at);
      CREATE TABLE IF NOT EXISTS roblox_sessions (discord_id TEXT PRIMARY KEY, roblox_id INTEGER NOT NULL, ciphertext TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS trade_sends (signature TEXT PRIMARY KEY, state TEXT NOT NULL, trade_id INTEGER, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS inventory_snapshots (discord_id TEXT PRIMARY KEY, holdings TEXT NOT NULL, taken_at INTEGER NOT NULL);`);
    // Databases created before inventory alerts existed lack the column; add it in place.
    const columns = (this.db.prepare('PRAGMA table_info(users)').all() as unknown as { name: string }[]).map(c => c.name);
    if (!columns.includes('inventory_alerts')) this.db.exec('ALTER TABLE users ADD COLUMN inventory_alerts INTEGER NOT NULL DEFAULT 0');
    // The ad archive is a rolling window: rows are deleted constantly, so the file has to be able to give space back.
    // Without incremental auto-vacuum SQLite keeps every page it has ever used, and the file only ever grows.
    const mode = (this.db.prepare('PRAGMA auto_vacuum').get() as { auto_vacuum: number } | undefined)?.auto_vacuum;
    if (mode === 0) { this.db.exec('PRAGMA auto_vacuum = INCREMENTAL'); this.db.exec('VACUUM'); }
  }
  /** Where the archive lives and how much of it there is, for the panels that report on it. */
  stats(now = Date.now()): { count: number; minutes: number; perHour: number; bytes: number; retentionHours: number; maxAds: number } {
    const { count, minutes } = this.adCoverage(now);
    const pages = (this.db.prepare('PRAGMA page_count').get() as { page_count: number }).page_count;
    const size = (this.db.prepare('PRAGMA page_size').get() as { page_size: number }).page_size;
    return { count, minutes, perHour: minutes ? Math.round(count / (minutes / 60)) : 0,
      bytes: pages * size, retentionHours: this.archive.hours, maxAds: this.archive.maxAds };
  }
  /** Rolimons only serves the last few minutes of ads, so every poll is archived; searches then screen the whole archive. */
  saveAds(ads: TradeAd[]): number {
    const insert = this.db.prepare('INSERT OR IGNORE INTO ads VALUES (?, ?, ?)');
    let added = 0;
    this.db.exec('BEGIN');
    try { for (const ad of ads) added += Number(insert.run(ad.id, ad.createdAt, JSON.stringify(ad)).changes); this.db.exec('COMMIT'); }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return added;
  }
  recentAds(maxAgeMs: number, now = Date.now()): TradeAd[] {
    const rows = this.db.prepare('SELECT payload FROM ads WHERE created_at > ? ORDER BY created_at DESC').all(now - Math.min(maxAgeMs, this.archiveMs)) as unknown as { payload: string }[];
    return rows.map(row => JSON.parse(row.payload) as TradeAd);
  }
  adCount(): number { return Number((this.db.prepare('SELECT COUNT(*) AS n FROM ads').get() as { n: number }).n); }
  /** How much of the recent past the archive covers: ad count and the age of the oldest ad, in minutes. */
  adCoverage(now = Date.now()): { count: number; minutes: number } {
    const row = this.db.prepare('SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM ads').get() as { n: number; oldest: number | null };
    return { count: Number(row.n), minutes: row.oldest ? Math.round((now - Number(row.oldest)) / 60_000) : 0 };
  }
  private decode(row: Row): UserProfile {
    return { discordId: row.discord_id, robloxId: row.roblox_id, username: row.username,
      preferences: preferencesSchema.parse(JSON.parse(row.preferences)), alerts: Boolean(row.alerts), alertError: row.alert_error, inventoryAlerts: Boolean(row.inventory_alerts) };
  }
  get(id: string): UserProfile | undefined {
    const row = this.db.prepare('SELECT * FROM users WHERE discord_id = ?').get(id) as Row | undefined;
    return row ? this.decode(row) : undefined;
  }
  save(user: UserProfile): void {
    const preferences = parsePreferences(user.preferences);
    this.db.prepare(`INSERT INTO users (discord_id, roblox_id, username, preferences, alerts, alert_error, inventory_alerts) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(discord_id) DO UPDATE SET roblox_id=excluded.roblox_id, username=excluded.username,
      preferences=excluded.preferences, alerts=excluded.alerts, alert_error=excluded.alert_error, inventory_alerts=excluded.inventory_alerts`)
      .run(user.discordId, user.robloxId, user.username, JSON.stringify(preferences), Number(user.alerts), user.alertError, Number(user.inventoryAlerts));
  }
  link(discordId: string, robloxId: number, username: string): UserProfile {
    const existing = this.get(discordId);
    const user: UserProfile = existing?.robloxId === robloxId ? { ...existing, username }
      : { discordId, robloxId, username, preferences: defaults(), alerts: false, alertError: null, inventoryAlerts: false };
    if (existing?.robloxId !== robloxId) { this.disconnect(discordId); this.db.prepare('DELETE FROM alerts WHERE discord_id = ?').run(discordId); this.clearSnapshot(discordId); }
    this.save(user); return user;
  }
  subscribers(): UserProfile[] { return (this.db.prepare('SELECT * FROM users WHERE alerts = 1').all() as unknown as Row[]).map(row => this.decode(row)); }
  /** Users who asked to be told when their inventory changes. */
  inventoryWatchers(): UserProfile[] { return (this.db.prepare('SELECT * FROM users WHERE inventory_alerts = 1').all() as unknown as Row[]).map(row => this.decode(row)); }
  snapshot(discordId: string): InventorySnapshot | undefined {
    const row = this.db.prepare('SELECT holdings, taken_at FROM inventory_snapshots WHERE discord_id = ?').get(discordId) as { holdings: string; taken_at: number } | undefined;
    return row ? { holdings: JSON.parse(row.holdings) as Holding[], takenAt: Number(row.taken_at) } : undefined;
  }
  saveSnapshot(discordId: string, holdings: Holding[], now = Date.now()): void {
    this.db.prepare('INSERT OR REPLACE INTO inventory_snapshots VALUES (?, ?, ?)').run(discordId, JSON.stringify(holdings), now);
  }
  clearSnapshot(discordId: string): void { this.db.prepare('DELETE FROM inventory_snapshots WHERE discord_id = ?').run(discordId); }
  requireCredentialKey(): Buffer {
    if (!this.credentialKey) throw new UserError('Account connections are unavailable until the bot operator configures ROBLOX_CREDENTIAL_KEY.');
    return Buffer.from(this.credentialKey, 'hex');
  }
  connect(discordId: string, roblox: { id: number; name: string }, cookie: string): void {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.requireCredentialKey(), iv);
    cipher.setAAD(Buffer.from(`${discordId}:${roblox.id}`));
    const encrypted = Buffer.concat([cipher.update(cookie, 'utf8'), cipher.final()]);
    const ciphertext = Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
    this.db.exec('BEGIN');
    try {
      this.link(discordId, roblox.id, roblox.name);
      this.db.prepare('INSERT OR REPLACE INTO roblox_sessions VALUES (?, ?, ?)').run(discordId, roblox.id, ciphertext);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  session(discordId: string, robloxId: number): string {
    const row = this.db.prepare('SELECT roblox_id, ciphertext FROM roblox_sessions WHERE discord_id = ?').get(discordId) as { roblox_id: number; ciphertext: string } | undefined;
    if (!row || row.roblox_id !== robloxId) throw new UserError('Use /connect to authorize sending trades from this Roblox account first.');
    try {
      const data = Buffer.from(row.ciphertext, 'base64');
      const decipher = createDecipheriv('aes-256-gcm', this.requireCredentialKey(), data.subarray(0, 12));
      decipher.setAAD(Buffer.from(`${discordId}:${robloxId}`));
      decipher.setAuthTag(data.subarray(12, 28));
      return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8');
    } catch { throw new UserError('The saved connection cannot be read. Use /connect again.'); }
  }
  disconnect(discordId: string): void { this.db.prepare('DELETE FROM roblox_sessions WHERE discord_id = ?').run(discordId); }
  /** Claim before the POST. A crash or ambiguous response leaves a durable block against resending. */
  claimTrade(signature: string): void {
    this.db.prepare("DELETE FROM trade_sends WHERE signature = ? AND state = 'sent' AND created_at < ?").run(signature, Date.now() - 86_400_000);
    if (!this.db.prepare("INSERT OR IGNORE INTO trade_sends VALUES (?, 'pending', NULL, ?)").run(signature, Date.now()).changes) {
      const row = this.db.prepare('SELECT trade_id FROM trade_sends WHERE signature = ?').get(signature) as { trade_id: number | null };
      throw new UserError(row.trade_id ? `This trade was already sent (trade ${row.trade_id}). Check your outbound trades.` : 'This trade may already have been sent. Check your outbound trades in Roblox; automatic resending is blocked.');
    }
  }
  finishTrade(signature: string, tradeId: number): void { this.db.prepare("UPDATE trade_sends SET state = 'sent', trade_id = ? WHERE signature = ?").run(tradeId, signature); }
  releaseTrade(signature: string): void { this.db.prepare("DELETE FROM trade_sends WHERE signature = ? AND state = 'pending'").run(signature); }
  seen(id: string, signature: string, now = Date.now()): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM alerts WHERE discord_id = ? AND signature = ? AND sent_at > ?').get(id, signature, now - 86_400_000));
  }
  /** How many alerts a user has been sent inside the window; the monitor uses it as a rate limit. */
  /** When the user last got an alert DM, or null. */
  lastSentAt(id: string): number | null {
    const row = this.db.prepare('SELECT MAX(sent_at) AS at FROM alerts WHERE discord_id = ?').get(id) as { at: number | null };
    return row.at ? Number(row.at) : null;
  }
  sentCount(id: string, windowMs: number, now = Date.now()): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS n FROM alerts WHERE discord_id = ? AND sent_at > ?').get(id, now - windowMs) as { n: number }).n);
  }
  markSent(id: string, signature: string, now = Date.now()): void {
    this.db.prepare('INSERT OR REPLACE INTO alerts VALUES (?, ?, ?)').run(id, signature, now);
  }
  /**
   * Rolls the archive forward: anything past the retention window goes, and whatever survives is capped at the newest
   * `maxAds` rows, so arriving ads displace the oldest ones however busy the feed gets. Freed pages are handed back to
   * the filesystem a little at a time rather than left as permanent slack in the file.
   */
  prune(now = Date.now()): void {
    this.db.prepare("DELETE FROM trade_sends WHERE state = 'sent' AND created_at <= ?").run(now - 86_400_000);
    this.db.prepare('DELETE FROM alerts WHERE sent_at <= ?').run(now - 86_400_000);
    this.db.prepare('DELETE FROM ads WHERE created_at <= ?').run(now - this.archiveMs);
    this.db.prepare('DELETE FROM ads WHERE id IN (SELECT id FROM ads ORDER BY created_at DESC LIMIT -1 OFFSET ?)').run(this.archive.maxAds);
    this.db.exec('PRAGMA incremental_vacuum(256)');
  }
  forget(id: string): void {
    this.db.exec('BEGIN');
    try { this.disconnect(id); this.db.prepare('DELETE FROM users WHERE discord_id = ?').run(id); this.db.prepare('DELETE FROM alerts WHERE discord_id = ?').run(id); this.clearSnapshot(id); this.db.exec('COMMIT'); }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close(): void { this.db.close(); }
}

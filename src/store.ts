import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { defaults, preferencesSchema, type UserProfile } from './domain.js';

interface Row { discord_id: string; roblox_id: number; username: string; preferences: string; alerts: number; alert_error: string | null }
export class Store {
  private db: DatabaseSync;
  constructor(path: string) {
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
      );`);
  }
  private decode(row: Row): UserProfile {
    return { discordId: row.discord_id, robloxId: row.roblox_id, username: row.username,
      preferences: preferencesSchema.parse(JSON.parse(row.preferences)), alerts: Boolean(row.alerts), alertError: row.alert_error };
  }
  get(id: string): UserProfile | undefined {
    const row = this.db.prepare('SELECT * FROM users WHERE discord_id = ?').get(id) as Row | undefined;
    return row ? this.decode(row) : undefined;
  }
  save(user: UserProfile): void {
    const preferences = preferencesSchema.parse(user.preferences);
    this.db.prepare(`INSERT INTO users VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(discord_id) DO UPDATE SET roblox_id=excluded.roblox_id, username=excluded.username,
      preferences=excluded.preferences, alerts=excluded.alerts, alert_error=excluded.alert_error`)
      .run(user.discordId, user.robloxId, user.username, JSON.stringify(preferences), Number(user.alerts), user.alertError);
  }
  link(discordId: string, robloxId: number, username: string): UserProfile {
    const existing = this.get(discordId);
    const user: UserProfile = existing?.robloxId === robloxId ? { ...existing, username }
      : { discordId, robloxId, username, preferences: defaults(), alerts: false, alertError: null };
    if (existing?.robloxId !== robloxId) this.db.prepare('DELETE FROM alerts WHERE discord_id = ?').run(discordId);
    this.save(user); return user;
  }
  subscribers(): UserProfile[] { return (this.db.prepare('SELECT * FROM users WHERE alerts = 1').all() as unknown as Row[]).map(row => this.decode(row)); }
  seen(id: string, signature: string, now = Date.now()): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM alerts WHERE discord_id = ? AND signature = ? AND sent_at > ?').get(id, signature, now - 86_400_000));
  }
  markSent(id: string, signature: string, now = Date.now()): void {
    this.db.prepare('INSERT OR REPLACE INTO alerts VALUES (?, ?, ?)').run(id, signature, now);
  }
  prune(now = Date.now()): void { this.db.prepare('DELETE FROM alerts WHERE sent_at <= ?').run(now - 86_400_000); }
  forget(id: string): void {
    this.db.exec('BEGIN');
    try { this.db.prepare('DELETE FROM users WHERE discord_id = ?').run(id); this.db.prepare('DELETE FROM alerts WHERE discord_id = ?').run(id); this.db.exec('COMMIT'); }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close(): void { this.db.close(); }
}

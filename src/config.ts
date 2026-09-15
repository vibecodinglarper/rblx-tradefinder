import { z } from 'zod';

const schema = z.object({
  DISCORD_TOKEN: z.string().min(20),
  DISCORD_CLIENT_ID: z.string().regex(/^\d+$/),
  DISCORD_GUILD_ID: z.string().regex(/^\d+$/).optional(),
  DATABASE_PATH: z.string().default('./data/tradefinder.sqlite'),
  ROBLOX_CREDENTIAL_KEY: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
  POLL_INTERVAL_SECONDS: z.coerce.number().int().min(60).max(3600).default(180),
  MAX_SELLERS_PER_SEARCH: z.coerce.number().int().min(1).max(100).default(30),
  /** The rolling ad archive: how far back it reaches, and the hard row cap that bounds it however busy the feed is. */
  AD_ARCHIVE_HOURS: z.coerce.number().int().min(1).max(48).default(24),
  AD_ARCHIVE_MAX_ADS: z.coerce.number().int().min(1000).max(1_000_000).default(100_000),
  /** Port for the health endpoint a hosting platform polls. Set to 0 to leave it off. */
  HEALTH_PORT: z.coerce.number().int().min(0).max(65535).default(0),
  /** Firestore keeps the ad archive and a heartbeat when a service account is given; otherwise the archive stays in SQLite. */
  FIREBASE_SERVICE_ACCOUNT: z.string().min(1).optional(),
  FIREBASE_SERVICE_ACCOUNT_JSON: z.string().min(2).optional(),
  FIRESTORE_PREFIX: z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}$/i).default('tradefinder'),
  /** Minutes the gateway may stay down or scans may stall before the process exits for its supervisor to restart it. 0 disables. */
  WATCHDOG_MINUTES: z.coerce.number().int().min(0).max(120).default(10),
});
export function config() {
  const result = schema.safeParse({ ...process.env, DISCORD_GUILD_ID: process.env.DISCORD_GUILD_ID || undefined, ROBLOX_CREDENTIAL_KEY: process.env.ROBLOX_CREDENTIAL_KEY || undefined,
    FIREBASE_SERVICE_ACCOUNT: process.env.FIREBASE_SERVICE_ACCOUNT || undefined, FIREBASE_SERVICE_ACCOUNT_JSON: process.env.FIREBASE_SERVICE_ACCOUNT_JSON || undefined });
  if (!result.success) throw new Error(`Invalid configuration: ${result.error.issues.map(i => i.path.join('.')).join(', ')}. See .env.example.`);
  return result.data;
}

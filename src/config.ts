import { z } from 'zod';

const schema = z.object({
  DISCORD_TOKEN: z.string().min(20),
  DISCORD_CLIENT_ID: z.string().regex(/^\d+$/),
  DISCORD_GUILD_ID: z.string().regex(/^\d+$/).optional(),
  DATABASE_PATH: z.string().default('./data/tradefinder.sqlite'),
  POLL_INTERVAL_SECONDS: z.coerce.number().int().min(60).max(3600).default(180),
  MAX_SELLERS_PER_SEARCH: z.coerce.number().int().min(1).max(100).default(30),
  /** The rolling ad archive: how far back it reaches, and the hard row cap that bounds it however busy the feed is. */
  AD_ARCHIVE_HOURS: z.coerce.number().int().min(1).max(48).default(24),
  AD_ARCHIVE_MAX_ADS: z.coerce.number().int().min(1000).max(1_000_000).default(100_000),
  /** Port for the health endpoint a hosting platform polls. Set to 0 to leave it off. */
  HEALTH_PORT: z.coerce.number().int().min(0).max(65535).default(0),
});
export function config() {
  const result = schema.safeParse({ ...process.env, DISCORD_GUILD_ID: process.env.DISCORD_GUILD_ID || undefined });
  if (!result.success) throw new Error(`Invalid configuration: ${result.error.issues.map(i => i.path.join('.')).join(', ')}. See .env.example.`);
  return result.data;
}

import { z } from 'zod';

const schema = z.object({
  DISCORD_TOKEN: z.string().min(20),
  DISCORD_CLIENT_ID: z.string().regex(/^\d+$/),
  DISCORD_GUILD_ID: z.string().regex(/^\d+$/).optional(),
  DATABASE_PATH: z.string().default('./data/tradefinder.sqlite'),
  POLL_INTERVAL_SECONDS: z.coerce.number().int().min(60).max(3600).default(180),
  MAX_SELLERS_PER_SEARCH: z.coerce.number().int().min(1).max(30).default(12),
});
export function config() {
  const result = schema.safeParse({ ...process.env, DISCORD_GUILD_ID: process.env.DISCORD_GUILD_ID || undefined });
  if (!result.success) throw new Error(`Invalid configuration: ${result.error.issues.map(i => i.path.join('.')).join(', ')}. See .env.example.`);
  return result.data;
}

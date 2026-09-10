import { z } from 'zod';

export const idSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const modeSchema = z.enum(['any', 'upgrade', 'downgrade']);
export type Mode = z.infer<typeof modeSchema>;
export const preferencesSchema = z.object({
  mode: modeSchema.default('any'),
  minValueGainPct: z.number().min(-50).max(1000).default(0),
  minRapGainPct: z.number().min(-100).max(1000).default(-10),
  maxOverpayPct: z.number().min(0).max(50).default(5),
  maxPartnerLossPct: z.number().min(0).max(50).default(15),
  minDemand: z.number().int().min(-1).max(4).default(-1),
  maxRapValueRatio: z.number().min(1).max(10).default(1.4),
  excludeProjected: z.boolean().default(true),
  maxAdAgeMinutes: z.number().int().min(1).max(1440).default(60),
  targetIds: z.array(idSchema).max(20).default([]),
  lockedIds: z.array(idSchema).max(100).default([]),
});
export type Preferences = z.infer<typeof preferencesSchema>;
export const defaults = (): Preferences => preferencesSchema.parse({});
export interface Item {
  id: number; name: string; acronym: string; rap: number; value: number | null;
  demand: number; trend: number; projected: boolean; hyped: boolean; rare: boolean;
}
export interface Holding { assetId: number; userAssetId: number; onHold: boolean }
export interface Inventory { userId: number; holdings: Holding[]; fetchedAt: number }
export interface TradeAd {
  id: number; createdAt: number; userId: number; username: string;
  offering: number[]; requesting: number[]; tags: number[]; offeringRobux: number; requestingRobux: number;
}
export interface Snapshot<T> { data: T; fetchedAt: number }
export interface UserProfile {
  discordId: string; robloxId: number; username: string; preferences: Preferences;
  alerts: boolean; alertError: string | null;
}
export const effectiveValue = (item: Item): number => item.value ?? item.rap;
export class UserError extends Error {}
export function parseId(input: string): number {
  if (!/^\d+$/.test(input)) throw new UserError('Use a numeric Roblox user or item ID.');
  const result = idSchema.safeParse(Number(input));
  if (!result.success) throw new UserError('That ID is outside the supported range.');
  return result.data;
}

import { z } from 'zod';

export const idSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const modeSchema = z.enum(['any', 'upgrade', 'downgrade']);
export type Mode = z.infer<typeof modeSchema>;
/** One end of a shape-specific window: a percentage of what you give, or an absolute value. */
export const boundSchema = z.object({ value: z.number().min(-1_000_000_000).max(1_000_000_000), pct: z.boolean() });
export type Bound = z.infer<typeof boundSchema>;
export const preferencesSchema = z.object({
  mode: modeSchema.default('any'),
  /** -5 by default: the finder lists small losses (to -5%), even swaps and gains, each labelled. */
  minValueGainPct: z.number().min(-50).max(1000).default(-5),
  /** Upper bound on value gain %, used by the finder's modes (null = none). */
  maxValueGainPct: z.number().min(-50).max(1000).nullable().default(null),
  minRapGainPct: z.number().min(-100).max(1000).default(-10),
  /** Absolute value-gain window (profit range) and RAP floor in Rolimons units; null means unbounded on that side. */
  minValueGain: z.number().min(-100_000_000).max(1_000_000_000).nullable().default(null),
  maxValueGain: z.number().min(-100_000_000).max(1_000_000_000).nullable().default(null),
  minRapGain: z.number().min(-100_000_000).max(1_000_000_000).nullable().default(null),
  /** Per-item profit windows keyed by item ID: when a trade receives that item, its window replaces the general one. */
  itemRules: z.record(z.string().regex(/^\d+$/), z.object({
    min: z.number().min(-100_000_000).max(1_000_000_000).nullable().default(null),
    max: z.number().min(-100_000_000).max(1_000_000_000).nullable().default(null),
  })).default({}),
  /**
   * Limits the value of what you receive. With no custom range the finder works out what your items can afford
   * (cheapest item up to your four most valuable together); a custom range replaces that.
   */
  affordable: z.boolean().default(false),
  minReceiveValue: z.number().min(0).max(1_000_000_000).nullable().default(null),
  maxReceiveValue: z.number().min(0).max(1_000_000_000).nullable().default(null),
  /** Downgrades (you receive more copies than you give): the profit you want, as % of what you give or as value. */
  downgradeProfitMin: boundSchema.nullable().default(null),
  downgradeProfitMax: boundSchema.nullable().default(null),
  /** Upgrades (you give more copies than you get): how much more you give than you get; negative means you gain. */
  upgradeOverpayMin: boundSchema.nullable().default(null),
  upgradeOverpayMax: boundSchema.nullable().default(null),
  maxOverpayPct: z.number().min(0).max(50).default(5),
  maxPartnerLossPct: z.number().min(0).max(50).default(15),
  minDemand: z.number().int().min(-1).max(4).default(-1),
  maxRapValueRatio: z.number().min(1).max(10).default(1.4),
  excludeProjected: z.boolean().default(true),
  maxAdAgeMinutes: z.number().int().min(1).max(1440).default(60),
  /** How many trade DMs one alert check may send; set on the alerts panel next to the on/off toggle. */
  alertsPerScan: z.number().int().min(1).max(10).default(3),
  targetIds: z.array(idSchema).max(100).default([]),
});
export type Preferences = z.infer<typeof preferencesSchema>;
/** Safety net behind `alertsPerScan`: a ceiling that scales with the chosen rate so a busy hour cannot flood a DM inbox. */
export const alertHourlyCap = (perScan: number): number => Math.max(60, perScan * 30);
/** The form box each preference is typed into, so a rejected value names the box the user was looking at. */
const FIELD_LABELS: Record<string, string> = {
  mode: 'Mode',
  minValueGainPct: 'Loss I will accept', maxValueGainPct: 'Loss I will accept',
  minRapGainPct: 'RAP gain', minRapGain: 'RAP gain',
  minValueGain: 'Profit range', maxValueGain: 'Profit range',
  itemRules: 'Profit range when receiving',
  minReceiveValue: 'Any item in your range', maxReceiveValue: 'Any item in your range',
  downgradeProfitMin: 'Downgrade profit range', downgradeProfitMax: 'Downgrade profit range',
  upgradeOverpayMin: 'Upgrade overpay range', upgradeOverpayMax: 'Upgrade overpay range',
  maxOverpayPct: 'Max overpay', maxPartnerLossPct: 'Max partner loss',
  minDemand: 'Minimum demand', maxRapValueRatio: 'Max RAP/value ratio',
  maxAdAgeMinutes: 'Max ad age', alertsPerScan: 'How many trades per check',
  targetIds: 'Wanted items', affordable: 'Any item in your range',
};
const limit = (n: unknown): string => (typeof n === 'number' ? n.toLocaleString('en-US') : String(n));
/** What a rejected box accepts, in the same terms the form asked for it. */
function explain(issue: { code: string; message: string; minimum?: unknown; maximum?: unknown; expected?: string }): string {
  if (issue.code === 'too_small') return `must be at least ${limit(issue.minimum)}.`;
  if (issue.code === 'too_big') return `must be at most ${limit(issue.maximum)}.`;
  if (issue.code === 'invalid_type' && issue.expected === 'int') return 'must be a whole number.';
  if (issue.code === 'invalid_type') return `must be a ${issue.expected}.`;
  if (issue.code === 'invalid_value') return 'is not one of the choices offered.';
  return issue.message;
}
/**
 * Every form that changes preferences goes through here. A rejected value comes back as a `UserError` naming the box
 * and the limit it broke, so nothing is saved half-valid and nothing surfaces as an unexplained failure.
 */
export function parsePreferences(candidate: unknown): Preferences {
  const result = preferencesSchema.safeParse(candidate);
  if (result.success) return result.data;
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const issue of result.error.issues) {
    const label = FIELD_LABELS[String(issue.path[0] ?? '')] ?? String(issue.path[0] ?? 'That value');
    if (seen.has(label)) continue;
    seen.add(label);
    problems.push(`**${label}** ${explain(issue as Parameters<typeof explain>[0])}`);
  }
  throw new UserError(problems.slice(0, 4).join('\n'));
}
export const defaults = (): Preferences => preferencesSchema.parse({});
export interface Item {
  id: number; name: string; acronym: string; rap: number; value: number | null;
  demand: number; trend: number; projected: boolean; hyped: boolean; rare: boolean;
}
/** Roblox reports a name and recent average price per copy; they are the fallback when Rolimons does not track the item. */
export interface Holding { assetId: number; userAssetId: number; onHold: boolean; name?: string; robloxRap?: number | null }
export interface Inventory { userId: number; holdings: Holding[]; fetchedAt: number }
export interface TradeAd {
  id: number; createdAt: number; userId: number; username: string;
  offering: number[]; requesting: number[]; tags: number[]; offeringRobux: number; requestingRobux: number;
}
export interface Snapshot<T> { data: T; fetchedAt: number }
export interface UserProfile {
  discordId: string; robloxId: number; username: string; preferences: Preferences;
  alerts: boolean; alertError: string | null;
  /** DM a recap whenever copies leave or join the public inventory (a trade went through, an item sold, a purchase). */
  inventoryAlerts: boolean;
}
export const effectiveValue = (item: Item): number => item.value ?? item.rap;
export class UserError extends Error {}
/** Raised when a command needs a tracked Roblox account and none is linked; rendered as a link-first panel, not an error. */
export class NotLinkedError extends UserError {}
export function parseId(input: string): number {
  if (!/^\d+$/.test(input)) throw new UserError('Use a numeric Roblox user or item ID.');
  const result = idSchema.safeParse(Number(input));
  if (!result.success) throw new UserError('That ID is outside the supported range.');
  return result.data;
}

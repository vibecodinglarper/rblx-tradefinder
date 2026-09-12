import { effectiveValue, UserError, type Bound, type Item } from './domain.js';
import { resolveItem } from './providers.js';

/** A profit window in Rolimons value; null on either side means unbounded. */
export interface Range { min: number | null; max: number | null }

/**
 * One amount typed by a user: a number ("1000", "1,000", "-500"), or an item whose Rolimons value is used
 * ("Valk", "STF", "1365767"), optionally multiplied ("2x STF", "0.5 Valk").
 */
export function parseAmount(text: string, items: Map<number, Item>): number {
  const raw = text.trim().replace(/,/g, '');
  if (!raw) throw new UserError('Enter an amount or an item name.');
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  // Digits, signs and dots alone were meant to be a number, so say that rather than hunting for an item of that name.
  if (/^[-+.\d\s]+$/.test(raw)) throw new UserError(`\`${text.trim().slice(0, 20)}\` is not a valid amount. Type a number like \`5000\`, or an item name like \`Valk\`.`);
  const multiplied = /^(-?\d+(?:\.\d+)?)\s*[x×*]?\s+(.+)$/i.exec(raw) ?? /^(-?\d+(?:\.\d+)?)\s*[x×*]\s*(.+)$/i.exec(raw);
  const factor = multiplied ? Number(multiplied[1]) : 1;
  const item = resolveItem(multiplied ? multiplied[2]! : raw, items);
  return Math.round(factor * effectiveValue(item));
}
/**
 * A range typed as "min", "min - max", "min to max", "min..max" or "- max" (the dash must be spaced or it reads as a sign).
 * Each side accepts anything `parseAmount` does; a blank string clears the range.
 */
function splitRange(raw: string): [string, string] {
  const parts = raw.split(/\s+-\s+|\s*(?:–|—|\.\.|\bto\b)\s*/i);
  if (parts.length > 2) throw new UserError('A range has at most two parts, like `1000 - 5000` or `STF to Valk`.');
  const leadingDash = /^-\s+/.test(raw);
  const [first = '', second = ''] = leadingDash ? ['', raw.replace(/^-\s+/, '')] : parts;
  return [first.trim(), second.trim()];
}
export function parseRange(text: string, items: Map<number, Item>): Range {
  const raw = text.trim();
  if (!raw) return { min: null, max: null };
  const [first, second] = splitRange(raw);
  const min = first ? parseAmount(first, items) : null;
  const max = second ? parseAmount(second, items) : null;
  if (min !== null && max !== null && max < min) throw new UserError(`The range is backwards: ${min.toLocaleString('en-US')} is more than ${max.toLocaleString('en-US')}.`);
  return { min, max };
}
/** One side of a mixed range: "5%" or "-3%" is a percentage; anything else is an amount or an item. */
export function parseBound(text: string, items: Map<number, Item>): Bound {
  const raw = text.trim();
  if (/%$/.test(raw)) {
    const body = raw.slice(0, -1).replace(/,/g, '').trim();
    if (!/^-?\d+(\.\d+)?$/.test(body)) throw new UserError(`\`${raw.slice(0, 20)}\` is not a percentage. Type something like \`5%\` or \`-2.5%\`.`);
    return { value: Number(body), pct: true };
  }
  return { value: parseAmount(raw, items), pct: false };
}
export interface MixedRange { min: Bound | null; max: Bound | null }
/** A range whose sides may each be a percentage or an amount: "5% - 25%", "1000 - 5000", "-5% - 3%", "- 20000". */
export function parseMixedRange(text: string, items: Map<number, Item>): MixedRange {
  const raw = text.trim();
  if (!raw) return { min: null, max: null };
  const [first, second] = splitRange(raw);
  const min = first ? parseBound(first, items) : null;
  const max = second ? parseBound(second, items) : null;
  if (min && max && min.pct === max.pct && max.value < min.value) throw new UserError(`The range is backwards: ${formatBound(min)} is more than ${formatBound(max)}.`);
  return { min, max };
}
export const formatBound = (b: Bound): string => (b.pct ? `${b.value}%` : b.value.toLocaleString('en-US'));
export const formatMixedRange = (r: MixedRange): string =>
  r.min && r.max ? `${formatBound(r.min)} – ${formatBound(r.max)}` : r.min ? `≥ ${formatBound(r.min)}` : r.max ? `≤ ${formatBound(r.max)}` : 'any';
/** Text for a form box: what the user typed, more or less. */
export const mixedRangeText = (r: MixedRange): string => {
  const side = (b: Bound) => (b.pct ? `${b.value}%` : String(b.value));
  return r.min && r.max ? `${side(r.min)} - ${side(r.max)}` : r.min ? side(r.min) : r.max ? `- ${side(r.max)}` : '';
};
export const formatRange = (r: Range, fmt = (n: number) => n.toLocaleString('en-US')): string =>
  r.min !== null && r.max !== null ? `${fmt(r.min)} – ${fmt(r.max)}` : r.min !== null ? `≥ ${fmt(r.min)}` : r.max !== null ? `≤ ${fmt(r.max)}` : 'any';

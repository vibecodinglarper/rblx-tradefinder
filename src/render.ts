import { createCanvas, loadImage, type Image, type SKRSContext2D } from '@napi-rs/canvas';
import { readFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { InventoryEntry } from './inventory.js';

/** Rolimons logo for value and the 2014 Robux "R$" for RAP; SVGs are upscaled before rasterising so they stay crisp. */
const ICON = 18;
function svgIcon(name: string, size: number): Promise<Image | null> {
  // Works from both src/ (tsx) and dist/src/ (compiled): the assets folder sits at the repository root.
  const here = fileURLToPath(import.meta.url);
  const root = here.includes(`${sep}dist${sep}src${sep}`) ? dirname(dirname(dirname(here))) : dirname(dirname(here));
  const path = join(root, 'assets', name);
  const source = readFileSync(path, 'utf8').replace(/width="[^"]+"/, `width="${size}"`).replace(/height="[^"]+"/, `height="${size}"`);
  return loadImage(Buffer.from(source)).catch(() => null);
}
let icons: Promise<{ rolimons: Image | null; robux: Image | null }> | undefined;
function loadIcons() {
  icons ??= Promise.all([svgIcon('rolimons.svg', ICON * 4), svgIcon('robux-2014.svg', ICON * 4)]).then(([rolimons, robux]) => ({ rolimons, robux }));
  return icons;
}
/** 128 px PNG of an asset icon, the format Discord accepts for application emojis. */
export async function iconPng(name: string): Promise<Buffer> {
  const image = await svgIcon(name, 128);
  if (!image) throw new Error(`Icon ${name} could not be rasterised.`);
  const canvas = createCanvas(128, 128); canvas.getContext('2d').drawImage(image, 0, 0, 128, 128);
  return canvas.toBuffer('image/png');
}

const COLS = 4, CARD = 210, GAP = 14, THUMB = 150, CARD_H = 292;
const FONT = 'sans-serif';
const TAG_COLORS: Record<string, string> = { Tradable: '#238636', 'On hold': '#fee75c', 'Not tradable': '#b42332', 'Tradability unknown': '#4e5058', rare: '#5865f2', projected: '#ed4245', hyped: '#f47b67', unpriced: '#4e5058', 'on hold': '#fee75c', 'value = rap': '#3ba55d' };
const fmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 0 });

function rounded(ctx: SKRSContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
function clipText(ctx: SKRSContext2D, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(`${s}…`).width > max) s = s.slice(0, -1);
  return `${s}…`;
}
/** Draws one page of inventory cards: thumbnail square, name with quantity, value and RAP, then tag chips. */
export async function renderInventoryGrid(entries: InventoryEntry[], thumbnails: Map<number, Buffer>): Promise<Buffer> {
  const { rolimons, robux } = await loadIcons();
  const rows = Math.max(1, Math.ceil(entries.length / COLS));
  const width = GAP + COLS * (CARD + GAP), height = GAP + rows * (CARD_H + GAP);
  const canvas = createCanvas(width, height); const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#313338'; ctx.fillRect(0, 0, width, height);
  const images = new Map(await Promise.all([...thumbnails].map(async ([id, bytes]) => [id, await loadImage(bytes).catch(() => null)] as const)));
  entries.forEach((e, index) => {
    const x = GAP + (index % COLS) * (CARD + GAP), y = GAP + Math.floor(index / COLS) * (CARD_H + GAP);
    ctx.fillStyle = '#2b2d31'; rounded(ctx, x, y, CARD, CARD_H, 12); ctx.fill();
    // Thumbnail square (placeholder tile when the CDN image is unavailable).
    const tx = x + (CARD - THUMB) / 2, ty = y + 12;
    ctx.fillStyle = '#1e1f22'; rounded(ctx, tx, ty, THUMB, THUMB, 10); ctx.fill();
    const image = images.get(e.assetId);
    if (image) { ctx.save(); rounded(ctx, tx, ty, THUMB, THUMB, 10); ctx.clip(); ctx.drawImage(image, tx, ty, THUMB, THUMB); ctx.restore(); }
    else { ctx.fillStyle = '#4e5058'; ctx.font = `bold 48px ${FONT}`; ctx.textAlign = 'center'; ctx.fillText('?', tx + THUMB / 2, ty + THUMB / 2 + 17); ctx.textAlign = 'left'; }
    if (e.quantity > 1) {
      ctx.font = `bold 15px ${FONT}`; const label = `×${e.quantity}`; const w = ctx.measureText(label).width + 14;
      ctx.fillStyle = '#5865f2'; rounded(ctx, tx + THUMB - w - 6, ty + 6, w, 24, 8); ctx.fill();
      ctx.fillStyle = '#ffffff'; ctx.fillText(label, tx + THUMB - w + 1, ty + 23);
    }
    // Name, then value and RAP beneath.
    ctx.fillStyle = '#f2f3f5'; ctx.font = `bold 15px ${FONT}`;
    ctx.fillText(clipText(ctx, e.quantity > 1 ? `${e.name} ${e.quantity}x` : e.name, CARD - 24), x + 12, ty + THUMB + 24);
    // Value with the Rolimons logo, RAP with the old Robux icon; text labels stand in if an icon failed to load.
    ctx.font = `13px ${FONT}`; ctx.fillStyle = '#b5bac1';
    const py = ty + THUMB + 44;
    if (e.value === null) ctx.fillText('No price data', x + 12, py);
    else {
      let px = x + 12;
      const stat = (icon: Image | null, label: string, text: string) => {
        if (icon) { ctx.drawImage(icon, px, py - ICON + 4, ICON, ICON); px += ICON + 4; }
        else { ctx.fillText(label, px, py); px += ctx.measureText(label).width + 4; }
        ctx.fillStyle = '#f2f3f5'; ctx.fillText(text, px, py); px += ctx.measureText(text).width + 12; ctx.fillStyle = '#b5bac1';
      };
      stat(rolimons, 'V', fmt(e.value));
      stat(robux, 'RAP', fmt(e.rap ?? 0));
    }
    // Tag chips.
    let cx = x + 12, cy = ty + THUMB + 56;
    ctx.font = `bold 11px ${FONT}`;
    for (const tag of e.tags) {
      const text = tag.toUpperCase(); const w = ctx.measureText(text).width + 12;
      if (cx + w > x + CARD - 8) { cx = x + 12; cy += 23; }
      if (cy + 18 > y + CARD_H - 8) break;
      const color = TAG_COLORS[tag] ?? (/^\d+\/\d+ tradable$/.test(tag) ? TAG_COLORS.Tradable! : TAG_COLORS['on hold']!);
      ctx.fillStyle = color; rounded(ctx, cx, cy, w, 18, 6); ctx.fill();
      ctx.fillStyle = color === '#fee75c' ? '#1e1f22' : '#ffffff'; ctx.fillText(text, cx + 6, cy + 13);
      cx += w + 6;
    }
  });
  return canvas.toBuffer('image/png');
}

// ---------- Trade cards ----------
import { effectiveValue, tradabilityTag } from './domain.js';
import type { Recommendation, PricedCopy, Totals } from './engine.js';
import type { InventoryChange } from './changes.js';

const T = { thumb: 118, cell: 132, gap: 10, pad: 18, header: 58, totals: 74, arrow: 96 };
const BUCKET_COLOR = { gain: '#57f287', even: '#b5bac1', loss: '#f0a95a' } as const;
type Cell = { copy: PricedCopy; count: number };
/** Identical copies collapse into one square with a ×N badge, like the inventory grid. */
function cells(copies: PricedCopy[]): Cell[] {
  const map = new Map<string, Cell>();
  for (const copy of copies) {
    const key = `${copy.itemTarget?.itemType ?? 'Asset'}:${copy.itemTarget?.targetId ?? copy.assetId}:${tradabilityTag(copy)}`;
    const c = map.get(key); if (c) c.count++; else map.set(key, { copy, count: 1 });
  }
  return [...map.values()];
}
/** Words on a two-sided card: the column headers, the totals-strip labels and the verdict under the arrow. */
export interface CardLabels { left: string; right: string; leftTotal: string; rightTotal: string; verdict: string }
export interface Exchange { give: PricedCopy[]; receive: PricedCopy[]; giving: Totals; receiving: Totals; valueGain: number; valueGainPct: number | null; rapGain: number }
const TRADE_LABELS = { gain: 'GAIN', even: 'EVEN', loss: 'SMALL LOSS' } as const;
/**
 * A Rolimons-style trade ad card: what you give on the left, what you get on the right, thumbnails with value and RAP
 * beneath each square, per-side totals, and the value difference in the middle.
 */
export function renderTradeCard(r: Recommendation, thumbnails: Map<number, Buffer>, bucket: 'gain' | 'even' | 'loss'): Promise<Buffer> {
  return renderExchangeCard(r, thumbnails, bucket, { left: 'YOU GIVE', right: 'YOU GET', leftTotal: 'TOTAL GIVEN', rightTotal: 'TOTAL RECEIVED', verdict: TRADE_LABELS[bucket] });
}
/** The same card for a detected inventory change: copies that left on the left, copies that arrived on the right. */
export function renderInventoryChangeCard(c: InventoryChange, thumbnails: Map<number, Buffer>): Promise<Buffer> {
  const bucket = c.valueGain > 0 ? 'gain' : c.valueGain < 0 ? 'loss' : 'even';
  const verdict = c.kind === 'trade' ? (bucket === 'gain' ? 'GAINED' : bucket === 'loss' ? 'LOST' : 'EVEN') : c.kind === 'out' ? 'LEFT' : 'ARRIVED';
  return renderExchangeCard({ give: c.removed, receive: c.added, giving: c.lost, receiving: c.gained, valueGain: c.valueGain, valueGainPct: c.valueGainPct, rapGain: c.rapGain },
    thumbnails, bucket, { left: 'OUT', right: 'IN', leftTotal: 'TOTAL OUT', rightTotal: 'TOTAL IN', verdict });
}
async function renderExchangeCard(r: Exchange, thumbnails: Map<number, Buffer>, bucket: 'gain' | 'even' | 'loss', labels: CardLabels): Promise<Buffer> {
  const { rolimons, robux } = await loadIcons();
  const give = cells(r.give), receive = cells(r.receive);
  const perRow = 2, rows = Math.max(1, Math.ceil(Math.max(give.length, receive.length) / perRow));
  const sideW = perRow * T.cell + (perRow - 1) * T.gap;
  const width = T.pad * 2 + sideW * 2 + T.arrow;
  const rowH = T.thumb + 62;
  const height = T.header + rows * rowH + (rows - 1) * T.gap + T.totals + T.pad;
  const canvas = createCanvas(width, height); const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#313338'; ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#2b2d31'; rounded(ctx, 6, 6, width - 12, height - 12, 14); ctx.fill();
  const images = new Map(await Promise.all([...thumbnails].map(async ([id, bytes]) => [id, await loadImage(bytes).catch(() => null)] as const)));
  // Column headers.
  const leftX = T.pad, rightX = T.pad + sideW + T.arrow;
  ctx.font = `bold 15px ${FONT}`; ctx.fillStyle = '#f2f3f5';
  ctx.fillText(labels.left, leftX, 34); ctx.fillText(labels.right, rightX, 34);
  const leftW = ctx.measureText(labels.left).width, rightW = ctx.measureText(labels.right).width;
  ctx.font = `12px ${FONT}`; ctx.fillStyle = '#b5bac1';
  ctx.fillText(`${r.give.length} cop${r.give.length === 1 ? 'y' : 'ies'}`, leftX + leftW + 10, 34); ctx.fillText(`${r.receive.length} cop${r.receive.length === 1 ? 'y' : 'ies'}`, rightX + rightW + 10, 34);
  const stat = (x: number, y: number, icon: Image | null, label: string, text: string, color = '#f2f3f5') => {
    let px = x;
    ctx.font = `12px ${FONT}`;
    if (icon) { ctx.drawImage(icon, px, y - 14, 16, 16); px += 20; } else { ctx.fillStyle = '#b5bac1'; ctx.fillText(label, px, y); px += ctx.measureText(label).width + 4; }
    ctx.fillStyle = color; ctx.font = `bold 12px ${FONT}`; ctx.fillText(text, px, y); return px + ctx.measureText(text).width + 10;
  };
  const drawSide = (list: Cell[], x0: number) => list.forEach((cell, i) => {
    const x = x0 + (i % perRow) * (T.cell + T.gap), y = T.header + Math.floor(i / perRow) * (rowH + T.gap);
    const item = cell.copy.item;
    ctx.fillStyle = '#1e1f22'; rounded(ctx, x, y, T.cell, rowH - 4, 10); ctx.fill();
    const tx = x + (T.cell - T.thumb) / 2, ty = y + 6;
    ctx.fillStyle = '#232428'; rounded(ctx, tx, ty, T.thumb, T.thumb, 8); ctx.fill();
    const image = images.get(cell.copy.assetId);
    if (image) { ctx.save(); rounded(ctx, tx, ty, T.thumb, T.thumb, 8); ctx.clip(); ctx.drawImage(image, tx, ty, T.thumb, T.thumb); ctx.restore(); }
    if (cell.count > 1) {
      ctx.font = `bold 13px ${FONT}`; const label = `×${cell.count}`; const w = ctx.measureText(label).width + 12;
      ctx.fillStyle = '#5865f2'; rounded(ctx, tx + T.thumb - w - 5, ty + 5, w, 21, 7); ctx.fill(); ctx.fillStyle = '#fff'; ctx.fillText(label, tx + T.thumb - w + 1, ty + 20);
    }
    const status = tradabilityTag(cell.copy);
    ctx.font = `bold 9px ${FONT}`;
    const statusText = status === 'Tradability unknown' ? 'UNVERIFIED' : status.toUpperCase();
    const sw = ctx.measureText(statusText).width + 8;
    const statusColor = TAG_COLORS[status]!;
    ctx.fillStyle = statusColor; rounded(ctx, tx + 4, ty + T.thumb - 37, sw, 14, 4); ctx.fill();
    ctx.fillStyle = statusColor === '#fee75c' ? '#1e1f22' : '#fff'; ctx.fillText(statusText, tx + 8, ty + T.thumb - 27);
    const flags = [item.rare && 'RARE', item.projected && 'PROJ', item.hyped && 'HYPED', item.value === null && 'VALUE = RAP'].filter(Boolean) as string[];
    if (flags.length) {
      ctx.font = `bold 9px ${FONT}`; let fx = tx + 5;
      for (const f of flags) { const w = ctx.measureText(f).width + 8; ctx.fillStyle = f === 'RARE' ? '#5865f2' : f === 'PROJ' ? '#ed4245' : f === 'VALUE = RAP' ? '#3ba55d' : '#f47b67'; rounded(ctx, fx, ty + T.thumb - 19, w, 14, 4); ctx.fill(); ctx.fillStyle = '#fff'; ctx.fillText(f, fx + 4, ty + T.thumb - 9); fx += w + 4; }
    }
    ctx.font = `bold 12px ${FONT}`; ctx.fillStyle = '#f2f3f5';
    ctx.fillText(clipText(ctx, item.name, T.cell - 14), x + 7, ty + T.thumb + 18);
    let px = stat(x + 7, ty + T.thumb + 36, rolimons, 'V', fmt(effectiveValue(item)));
    ctx.font = `bold 12px ${FONT}`;
    if (px + 60 <= x + T.cell) stat(px, ty + T.thumb + 36, robux, 'RAP', fmt(item.rap));
    else stat(x + 7, ty + T.thumb + 52, robux, 'RAP', fmt(item.rap));
  });
  drawSide(give, leftX); drawSide(receive, rightX);
  // An empty side (a sale, a purchase) gets a quiet placeholder instead of blank space.
  for (const [list, x0] of [[give, leftX], [receive, rightX]] as const) {
    if (list.length) continue;
    ctx.fillStyle = '#1e1f22'; rounded(ctx, x0, T.header, sideW, rowH - 4, 10); ctx.fill();
    ctx.fillStyle = '#4e5058'; ctx.font = `bold 14px ${FONT}`; ctx.textAlign = 'center'; ctx.fillText('nothing', x0 + sideW / 2, T.header + rowH / 2); ctx.textAlign = 'left';
  }
  // Middle arrow and value difference.
  const midX = T.pad + sideW + T.arrow / 2, midY = T.header + (rows * rowH + (rows - 1) * T.gap) / 2;
  ctx.fillStyle = '#4e5058'; ctx.font = `bold 34px ${FONT}`; ctx.textAlign = 'center'; ctx.fillText('→', midX, midY + 12);
  const color = BUCKET_COLOR[bucket];
  ctx.font = `bold 14px ${FONT}`; ctx.fillStyle = color;
  ctx.fillText(`${r.valueGain >= 0 ? '+' : ''}${fmt(r.valueGain)}`, midX, midY + 40);
  if (r.valueGainPct !== null) { ctx.font = `12px ${FONT}`; ctx.fillText(`${r.valueGainPct >= 0 ? '+' : ''}${r.valueGainPct.toFixed(1)}%`, midX, midY + 58); }
  ctx.textAlign = 'left';
  // Totals strip.
  const ty = height - T.pad - T.totals + 8;
  ctx.fillStyle = '#1e1f22'; rounded(ctx, T.pad, ty, width - T.pad * 2, T.totals - 8, 10); ctx.fill();
  ctx.font = `11px ${FONT}`; ctx.fillStyle = '#b5bac1'; ctx.fillText(labels.leftTotal, leftX + 12, ty + 20); ctx.fillText(labels.rightTotal, rightX + 12, ty + 20);
  let px = stat(leftX + 12, ty + 44, rolimons, 'V', fmt(r.giving.value)); stat(px, ty + 44, robux, 'RAP', fmt(r.giving.rap));
  px = stat(rightX + 12, ty + 44, rolimons, 'V', fmt(r.receiving.value)); stat(px, ty + 44, robux, 'RAP', fmt(r.receiving.rap));
  ctx.textAlign = 'center'; ctx.font = `bold 12px ${FONT}`; ctx.fillStyle = color;
  ctx.fillText(labels.verdict, midX, ty + 24);
  ctx.font = `11px ${FONT}`; ctx.fillStyle = '#b5bac1'; ctx.fillText(`RAP ${r.rapGain >= 0 ? '+' : ''}${fmt(r.rapGain)}`, midX, ty + 44);
  ctx.textAlign = 'left';
  return canvas.toBuffer('image/png');
}

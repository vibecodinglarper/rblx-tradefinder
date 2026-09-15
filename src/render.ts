import { createCanvas, loadImage, type Image, type SKRSContext2D } from '@napi-rs/canvas';
import { readFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { InventoryEntry } from './inventory.js';

/** Rolimons logo for value and the 2014 Robux "R$" for RAP; SVGs are upscaled before rasterising so they stay crisp. */
const ICON = 16;
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

// ---------- Shared scale ----------
// One type scale (20 / 15 / 13 / 11), one radius for cards and one for chips, and the Discord dark palette throughout.
const FONT = 'sans-serif';
const SIZE = { title: 20, body: 15, small: 13, chip: 11 } as const;
const RADIUS = { card: 12, chip: 6 } as const;
const PAD = 16;
const COLOR = { bg: '#313338', card: '#2b2d31', well: '#1e1f22', thumb: '#232428', text: '#f2f3f5', muted: '#b5bac1', faint: '#4e5058', badge: '#5865f2' } as const;
const CHIP_COLORS: Record<string, string> = {
  'on hold': '#fee75c', rare: '#5865f2', proj: '#ed4245', projected: '#ed4245', hyped: '#f47b67', unpriced: '#4e5058',
};
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
/** Word-wraps `text` into at most `lines` lines of `max` px, ellipsising the last one; uses the current font. */
function wrap(ctx: SKRSContext2D, text: string, max: number, lines: number): string[] {
  // A single word wider than the line (long acronym-free names) is broken mid-word rather than allowed past the edge.
  const words = text.split(/\s+/).filter(Boolean).flatMap(word => {
    const parts: string[] = [];
    while (ctx.measureText(word).width > max && word.length > 1) {
      let cut = word.length - 1;
      while (cut > 1 && ctx.measureText(word.slice(0, cut)).width > max) cut--;
      parts.push(word.slice(0, cut)); word = word.slice(cut);
    }
    return [...parts, word];
  });
  const out: string[] = [];
  let line = '';
  for (let i = 0; i < words.length; i++) {
    const candidate = line ? `${line} ${words[i]}` : words[i]!;
    if (ctx.measureText(candidate).width <= max || !line) line = candidate;
    else { out.push(line); line = words[i]!; }
    if (out.length === lines - 1) { out.push(clipText(ctx, [line, ...words.slice(i + 1)].join(' '), max)); return out; }
  }
  if (line) out.push(line);
  return out;
}
/** Draws a thumbnail into a rounded square (or a "?" tile when the image is missing). */
function thumbnail(ctx: SKRSContext2D, image: Image | null | undefined, x: number, y: number, size: number): void {
  ctx.fillStyle = COLOR.thumb; rounded(ctx, x, y, size, size, RADIUS.card - 2); ctx.fill();
  if (image) { ctx.save(); rounded(ctx, x, y, size, size, RADIUS.card - 2); ctx.clip(); ctx.drawImage(image, x, y, size, size); ctx.restore(); return; }
  ctx.fillStyle = COLOR.faint; ctx.font = `bold ${Math.round(size / 3)}px ${FONT}`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('?', x + size / 2, y + size / 2); ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
}
/** ×N quantity badge in the top-right corner of a thumbnail. */
function countBadge(ctx: SKRSContext2D, count: number, tx: number, ty: number, size: number): void {
  ctx.font = `bold ${SIZE.small}px ${FONT}`; const label = `×${count}`; const w = Math.ceil(ctx.measureText(label).width) + 12;
  ctx.fillStyle = COLOR.badge; rounded(ctx, tx + size - w - 6, ty + 6, w, 22, RADIUS.chip); ctx.fill();
  ctx.fillStyle = '#ffffff'; ctx.textBaseline = 'middle'; ctx.fillText(label, tx + size - w, ty + 17); ctx.textBaseline = 'alphabetic';
}
const CHIP_H = 18;
/** Measures a chip's width for the current chip font. */
function chipWidth(ctx: SKRSContext2D, text: string): number { ctx.font = `bold ${SIZE.chip}px ${FONT}`; return Math.ceil(ctx.measureText(text).width) + 12; }
/** One flag chip; `backing` adds a dark halo so it reads on light thumbnails. */
function chip(ctx: SKRSContext2D, text: string, x: number, y: number, color: string, backing = false): number {
  const w = chipWidth(ctx, text);
  if (backing) { ctx.fillStyle = 'rgba(0, 0, 0, 0.55)'; rounded(ctx, x - 2, y - 2, w + 4, CHIP_H + 4, RADIUS.chip + 2); ctx.fill(); }
  ctx.fillStyle = color; rounded(ctx, x, y, w, CHIP_H, RADIUS.chip); ctx.fill();
  ctx.fillStyle = color === '#fee75c' ? COLOR.well : '#ffffff'; ctx.textBaseline = 'middle'; ctx.fillText(text, x + 6, y + CHIP_H / 2 + 0.5); ctx.textBaseline = 'alphabetic';
  return w;
}
/**
 * Flag chips stacked from the bottom-left corner of a thumbnail, wrapping upwards when a row overflows.
 * Rows beyond what fits in the square are dropped rather than drawn over the top edge.
 */
function thumbChips(ctx: SKRSContext2D, chips: { text: string; color: string }[], tx: number, ty: number, size: number): void {
  const rows: { text: string; color: string }[][] = [[]];
  let rowW = 0;
  for (const c of chips) {
    const w = chipWidth(ctx, c.text);
    if (rowW && rowW + 4 + w > size - 12) { rows.push([]); rowW = 0; }
    rows[rows.length - 1]!.push(c); rowW += (rowW ? 4 : 0) + w;
  }
  rows.forEach((row, i) => {
    const y = ty + size - 6 - CHIP_H - i * (CHIP_H + 6);
    if (y < ty + 6) return;
    let x = tx + 6;
    for (const c of row) x += chip(ctx, c.text, x, y, c.color, true) + 4;
  });
}
type Stat = { icon: Image | null; label: string; text: string };
/** Width of an icon+number run at the given size, so callers can size cells before drawing. */
function statWidth(ctx: SKRSContext2D, stats: Stat[], size: number): number {
  let w = 0;
  stats.forEach((s, i) => {
    ctx.font = `bold ${size}px ${FONT}`;
    const iconW = s.icon ? ICON + 5 : (ctx.font = `${size}px ${FONT}`, ctx.measureText(s.label).width + 4);
    ctx.font = `bold ${size}px ${FONT}`;
    w += (i ? 12 : 0) + iconW + ctx.measureText(s.text).width;
  });
  return Math.ceil(w);
}
/**
 * Draws icon+number runs on one line, vertically centred on `cy`. When the run would pass `maxX` the numbers are
 * shortened rather than drawn past the edge; a text label stands in for an icon that failed to load.
 */
function statLine(ctx: SKRSContext2D, stats: Stat[], x: number, cy: number, size: number, maxX: number, color: string = COLOR.text): number {
  let px = x;
  ctx.textBaseline = 'middle';
  stats.forEach((s, i) => {
    if (i) px += 12;
    if (s.icon) { ctx.drawImage(s.icon, px, cy - ICON / 2, ICON, ICON); px += ICON + 5; }
    else { ctx.font = `${size}px ${FONT}`; ctx.fillStyle = COLOR.muted; ctx.fillText(s.label, px, cy); px += ctx.measureText(s.label).width + 4; }
    ctx.font = `bold ${size}px ${FONT}`; ctx.fillStyle = color;
    const text = clipText(ctx, s.text, Math.max(0, maxX - px));
    ctx.fillText(text, px, cy); px += ctx.measureText(text).width;
  });
  ctx.textBaseline = 'alphabetic';
  return px;
}

// ---------- Inventory grid ----------
const COLS = 4, CARD = 210, THUMB = 150, GAP = 14, NAME_LH = 18;
const CARD_H = 12 + THUMB + 10 + NAME_LH * 2 + 8 + 24 + 8 + CHIP_H * 2 + 6 + 12;
/** Draws one page of inventory cards: thumbnail square, two-line name, value and RAP, then tag chips. */
export async function renderInventoryGrid(entries: InventoryEntry[], thumbnails: Map<number, Buffer>): Promise<Buffer> {
  const { rolimons, robux } = await loadIcons();
  const rows = Math.max(1, Math.ceil(entries.length / COLS));
  const width = GAP + COLS * (CARD + GAP), height = GAP + rows * (CARD_H + GAP);
  const canvas = createCanvas(width, height); const ctx = canvas.getContext('2d');
  ctx.fillStyle = COLOR.bg; ctx.fillRect(0, 0, width, height);
  const images = new Map(await Promise.all([...thumbnails].map(async ([id, bytes]) => [id, await loadImage(bytes).catch(() => null)] as const)));
  entries.forEach((e, index) => {
    const x = GAP + (index % COLS) * (CARD + GAP), y = GAP + Math.floor(index / COLS) * (CARD_H + GAP);
    ctx.fillStyle = COLOR.card; rounded(ctx, x, y, CARD, CARD_H, RADIUS.card); ctx.fill();
    const tx = x + (CARD - THUMB) / 2, ty = y + 12;
    thumbnail(ctx, images.get(e.assetId), tx, ty, THUMB);
    if (e.quantity > 1) countBadge(ctx, e.quantity, tx, ty, THUMB);
    // Name on up to two lines.
    ctx.fillStyle = COLOR.text; ctx.font = `bold ${SIZE.body}px ${FONT}`; ctx.textBaseline = 'top';
    const nameTop = ty + THUMB + 10;
    wrap(ctx, e.name, CARD - 24, 2).forEach((line, i) => ctx.fillText(line, x + 12, nameTop + i * NAME_LH));
    ctx.textBaseline = 'alphabetic';
    // Value with the Rolimons logo, RAP with the old Robux icon; text labels stand in if an icon failed to load.
    const statY = nameTop + NAME_LH * 2 + 8 + 12;
    let cy = statY + 12 + 8;
    if (e.value === null) { ctx.font = `${SIZE.small}px ${FONT}`; ctx.fillStyle = COLOR.muted; ctx.textBaseline = 'middle'; ctx.fillText('No price data', x + 12, statY); ctx.textBaseline = 'alphabetic'; }
    else {
      // Nine-digit values do not share a 210 px card with their RAP; the pair then takes two lines instead of clipping.
      const pair = [{ icon: rolimons, label: 'V', text: fmt(e.value) }, { icon: robux, label: 'RAP', text: fmt(e.rap ?? 0) }];
      if (statWidth(ctx, pair, SIZE.small) <= CARD - 24) statLine(ctx, pair, x + 12, statY, SIZE.small, x + CARD - 12);
      else { pair.forEach((s, i) => statLine(ctx, [s], x + 12, statY + i * NAME_LH, SIZE.small, x + CARD - 12)); cy += NAME_LH; }
    }
    // Tag chips: a plain "Tradable" says nothing now that untradable copies are hidden, so only the exceptions are shown.
    let cx = x + 12;
    for (const tag of e.tags) {
      if (tag === 'Tradable' || tag === 'Tradability unknown') continue;
      const text = tag.toUpperCase(); const w = chipWidth(ctx, text);
      if (cx > x + 12 && cx + w > x + CARD - 12) { cx = x + 12; cy += CHIP_H + 6; }
      if (cy + CHIP_H > y + CARD_H - 10) break;
      const color = CHIP_COLORS[tag] ?? CHIP_COLORS['on hold']!;
      cx += chip(ctx, text, cx, cy, color) + 6;
    }
  });
  return canvas.toBuffer('image/png');
}

// ---------- Trade cards ----------
import { effectiveValue, tradabilityTag } from './domain.js';
import type { Bucket, Recommendation, PricedCopy, Totals } from './engine.js';
import type { InventoryChange } from './changes.js';

const T = { thumb: 124, cellPad: 10, gap: 10, header: 60, totals: 70, middle: 128, perRow: 2, nameLH: 17 };
/** Pill colour per value outcome; hex strings because the canvas takes CSS colours, unlike the embed palette. */
const BUCKET_COLOR: Record<Bucket, string> = { gain: '#57f287', even: '#b5bac1', loss: '#f0a95a' };
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
/** Words on a two-sided card: the column headers, the totals-strip labels and the verdict under the value delta ('' for none). */
export interface CardLabels { left: string; right: string; leftTotal: string; rightTotal: string; verdict: string }
export interface Exchange { give: PricedCopy[]; receive: PricedCopy[]; giving: Totals; receiving: Totals; valueGain: number; valueGainPct: number | null; rapGain: number }
/**
 * A Rolimons-style trade ad card: what you give on the left, what you get on the right, thumbnails with value and RAP
 * beneath each square, per-side totals, and the value difference in the middle. The pill colour already says
 * gain / even / loss, so a trade card carries no verdict word.
 */
export function renderTradeCard(r: Recommendation, thumbnails: Map<number, Buffer>, bucket: Bucket): Promise<Buffer> {
  return renderExchangeCard(r, thumbnails, bucket, { left: 'YOU GIVE', right: 'YOU GET', leftTotal: 'TOTAL GIVEN', rightTotal: 'TOTAL RECEIVED', verdict: '' });
}
/** The same card for a detected inventory change: copies that left on the left, copies that arrived on the right. */
export function renderInventoryChangeCard(c: InventoryChange, thumbnails: Map<number, Buffer>): Promise<Buffer> {
  const bucket = c.valueGain > 0 ? 'gain' : c.valueGain < 0 ? 'loss' : 'even';
  // A two-sided change is coloured like a trade; a one-sided one needs the word, since the colour alone cannot say what happened.
  const verdict = c.kind === 'trade' ? '' : c.kind === 'out' ? 'LEFT' : 'ARRIVED';
  return renderExchangeCard({ give: c.removed, receive: c.added, giving: c.lost, receiving: c.gained, valueGain: c.valueGain, valueGainPct: c.valueGainPct, rapGain: c.rapGain },
    thumbnails, bucket, { left: 'OUT', right: 'IN', leftTotal: 'TOTAL OUT', rightTotal: 'TOTAL IN', verdict });
}
async function renderExchangeCard(r: Exchange, thumbnails: Map<number, Buffer>, bucket: Bucket, labels: CardLabels): Promise<Buffer> {
  const { rolimons, robux } = await loadIcons();
  const give = cells(r.give), receive = cells(r.receive);
  const all = [...give, ...receive];
  const rows = Math.max(1, Math.ceil(Math.max(give.length, receive.length) / T.perRow));
  let ctx = createCanvas(1, 1).getContext('2d'); // measurement only; the real canvas is sized below
  const stats = (item: PricedCopy['item']): Stat[] => [{ icon: rolimons, label: 'V', text: fmt(effectiveValue(item)) }, { icon: robux, label: 'RAP', text: fmt(item.rap) }];
  const totals = (t: Totals): Stat[] => [{ icon: rolimons, label: 'V', text: fmt(t.value) }, { icon: robux, label: 'RAP', text: fmt(t.rap) }];
  // The cell is as wide as the thumbnail, or wider when a value + RAP line needs the room, so the pair never wraps or clips.
  const widestStat = Math.max(0, ...all.map(c => statWidth(ctx, stats(c.copy.item), SIZE.small)));
  const cellW = Math.max(T.thumb + T.cellPad * 2, widestStat + T.cellPad * 2);
  const cellH = T.cellPad + T.thumb + 10 + T.nameLH * 2 + 6 + 20 + T.cellPad;
  const sideW = T.perRow * cellW + (T.perRow - 1) * T.gap;
  const itemsH = rows * cellH + (rows - 1) * T.gap;
  // The middle column grows to fit the delta pill; a totals column must also fit its own value + RAP line.
  const deltaText = `${r.valueGain >= 0 ? '+' : ''}${fmt(r.valueGain)}`;
  const pctText = r.valueGainPct === null ? null : `${r.valueGainPct >= 0 ? '+' : ''}${r.valueGainPct.toFixed(1)}%`;
  const pillLines = [pctText, labels.verdict || null].filter((s): s is string => Boolean(s));
  const pillW = Math.max(statWidth(ctx, [{ icon: rolimons, label: 'V', text: deltaText }], SIZE.body), ...pillLines.map(l => { ctx.font = `bold ${SIZE.small}px ${FONT}`; return ctx.measureText(l).width; })) + 28;
  const pillH = 12 + 22 + pillLines.length * 18 + 12;
  const middleW = Math.max(T.middle, Math.ceil(pillW) + 16);
  const width = PAD * 2 + sideW * 2 + middleW;
  const height = T.header + itemsH + PAD + T.totals + PAD;
  const canvas = createCanvas(width, height); ctx = canvas.getContext('2d');
  ctx.fillStyle = COLOR.bg; ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = COLOR.card; rounded(ctx, 4, 4, width - 8, height - 8, RADIUS.card); ctx.fill();
  const images = new Map(await Promise.all([...thumbnails].map(async ([id, bytes]) => [id, await loadImage(bytes).catch(() => null)] as const)));
  // Column headers, left-aligned with the cells beneath them; the copy count is a muted suffix.
  const leftX = PAD, rightX = PAD + sideW + middleW;
  const header = (text: string, count: number, x: number) => {
    ctx.textBaseline = 'alphabetic';
    ctx.font = `bold ${SIZE.title}px ${FONT}`; ctx.fillStyle = COLOR.text; ctx.fillText(text, x, T.header - 22);
    const w = ctx.measureText(text).width;
    ctx.font = `${SIZE.small}px ${FONT}`; ctx.fillStyle = COLOR.muted; ctx.fillText(clipText(ctx, `${count} cop${count === 1 ? 'y' : 'ies'}`, sideW - w - 10), x + w + 10, T.header - 22);
  };
  header(labels.left, r.give.length, leftX); header(labels.right, r.receive.length, rightX);
  const drawSide = (list: Cell[], x0: number) => list.forEach((cell, i) => {
    const x = x0 + (i % T.perRow) * (cellW + T.gap), y = T.header + Math.floor(i / T.perRow) * (cellH + T.gap);
    const item = cell.copy.item;
    ctx.fillStyle = COLOR.well; rounded(ctx, x, y, cellW, cellH, RADIUS.card); ctx.fill();
    const tx = x + (cellW - T.thumb) / 2, ty = y + T.cellPad;
    thumbnail(ctx, images.get(cell.copy.assetId), tx, ty, T.thumb);
    if (cell.count > 1) countBadge(ctx, cell.count, tx, ty, T.thumb);
    // Only the exceptions get a chip: untradable copies are never shown, so "tradable" would say nothing.
    const flags: { text: string; color: string }[] = [];
    if (tradabilityTag(cell.copy) === 'On hold') flags.push({ text: 'ON HOLD', color: CHIP_COLORS['on hold']! });
    if (item.rare) flags.push({ text: 'RARE', color: CHIP_COLORS.rare! });
    if (item.projected) flags.push({ text: 'PROJ', color: CHIP_COLORS.proj! });
    if (item.hyped) flags.push({ text: 'HYPED', color: CHIP_COLORS.hyped! });
    thumbChips(ctx, flags, tx, ty, T.thumb);
    // Name on up to two lines, then value and RAP on one line beneath.
    const nameTop = ty + T.thumb + 10;
    ctx.fillStyle = COLOR.text; ctx.font = `bold ${SIZE.small}px ${FONT}`; ctx.textBaseline = 'top';
    wrap(ctx, item.name, cellW - T.cellPad * 2, 2).forEach((line, li) => ctx.fillText(line, x + T.cellPad, nameTop + li * T.nameLH));
    ctx.textBaseline = 'alphabetic';
    statLine(ctx, stats(item), x + T.cellPad, nameTop + T.nameLH * 2 + 6 + 10, SIZE.small, x + cellW - T.cellPad);
  });
  drawSide(give, leftX); drawSide(receive, rightX);
  // An empty side (a sale, a purchase) gets a placeholder cell instead of blank space.
  for (const [list, x0] of [[give, leftX], [receive, rightX]] as const) {
    if (list.length) continue;
    ctx.fillStyle = COLOR.well; rounded(ctx, x0, T.header, sideW, cellH, RADIUS.card); ctx.fill();
    const size = T.thumb; const tx = x0 + (sideW - size) / 2, ty = T.header + T.cellPad;
    ctx.fillStyle = COLOR.thumb; rounded(ctx, tx, ty, size, size, RADIUS.card - 2); ctx.fill();
    ctx.fillStyle = COLOR.faint; ctx.font = `bold ${SIZE.body}px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('nothing', x0 + sideW / 2, ty + size / 2);
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  }
  // Middle column: an arrow above a pill with the value delta, both centred on the item area.
  const color = BUCKET_COLOR[bucket];
  const midX = PAD + sideW + middleW / 2, midY = T.header + itemsH / 2;
  const arrowH = 18, stackH = arrowH + 14 + pillH;
  const arrowY = midY - stackH / 2 + arrowH / 2;
  ctx.strokeStyle = COLOR.faint; ctx.lineWidth = 3; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.beginPath(); ctx.moveTo(midX - 16, arrowY); ctx.lineTo(midX + 16, arrowY); ctx.moveTo(midX + 7, arrowY - 9); ctx.lineTo(midX + 16, arrowY); ctx.lineTo(midX + 7, arrowY + 9); ctx.stroke();
  const pillX = midX - pillW / 2, pillY = arrowY + arrowH / 2 + 14;
  ctx.fillStyle = `${color}29`; rounded(ctx, pillX, pillY, pillW, pillH, RADIUS.card); ctx.fill();
  const deltaW = statWidth(ctx, [{ icon: rolimons, label: 'V', text: deltaText }], SIZE.body);
  statLine(ctx, [{ icon: rolimons, label: 'V', text: deltaText }], midX - deltaW / 2, pillY + 12 + 11, SIZE.body, pillX + pillW, color);
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  pillLines.forEach((line, i) => {
    ctx.font = i === 0 && pctText ? `${SIZE.small}px ${FONT}` : `bold ${SIZE.small}px ${FONT}`; ctx.fillStyle = color;
    ctx.fillText(line, midX, pillY + 12 + 22 + i * 18 + 9);
  });
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  // Totals strip: one column per side, label above value + RAP, aligned with the item columns.
  const sy = T.header + itemsH + PAD;
  ctx.fillStyle = COLOR.well; rounded(ctx, PAD, sy, width - PAD * 2, T.totals, RADIUS.card); ctx.fill();
  for (const [label, t, x] of [[labels.leftTotal, r.giving, leftX], [labels.rightTotal, r.receiving, rightX]] as const) {
    ctx.font = `${SIZE.chip}px ${FONT}`; ctx.fillStyle = COLOR.muted; ctx.textBaseline = 'middle';
    ctx.fillText(clipText(ctx, label, sideW - 24), x + 12, sy + 20);
    statLine(ctx, totals(t), x + 12, sy + 46, SIZE.body, x + sideW - 12);
  }
  return canvas.toBuffer('image/png');
}

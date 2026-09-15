import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, escapeMarkdown, ModalBuilder, StringSelectMenuBuilder,
  TextInputBuilder, TextInputStyle, type BaseMessageOptions,
} from 'discord.js';
import { alertHourlyCap, defaults as defaultPreferences, effectiveValue, idSchema, modeSchema, tradabilityTag, UserError, type Item, type Mode, type Preferences, type UserProfile } from './domain.js';
import { bucketOf, downgradeWindow, upgradeWindow, type Bucket, type Evaluation, type PricedCopy, type Recommendation } from './engine.js';
import type { ArchiveStats, SearchResult } from './search.js';
import { formatRange, formatMixedRange, mixedRangeText, type Range } from './amounts.js';
import { PAGE_SIZE, type InventoryEntry, type InventoryView } from './inventory.js';
import type { InventoryChange } from './changes.js';
import type { TradeVerificationRequired } from './trading.js';

// ---------- Shared styling ----------
const Colors = { brand: 0x5865f2, success: 0x57f287, warning: 0xfee75c, danger: 0xed4245, muted: 0x99aab5 } as const;
/** Discord's size limits for the pieces of an embed and its components. */
const LIMIT = { description: 4096, field: 1024, footer: 2048, button: 80, option: 100, author: 256 } as const;
export const number = (n: number): string => n.toLocaleString('en-US', { maximumFractionDigits: 2 });
const signed = (n: number): string => `${n >= 0 ? '+' : ''}${number(n)}`;
const time = (ms: number) => `<t:${Math.floor(ms / 1000)}:R>`;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const DEMAND = ['Terrible', 'Low', 'Normal', 'High', 'Amazing'];
const demandLabel = (d: number) => DEMAND[d] ?? 'Unknown';
const MODE_ICON: Record<string, string> = { any: '🔀', both: '🔀', upgrade: '⬆️', downgrade: '⬇️', swap: '🔁' };
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** How a trade's value outcome is shown everywhere: the list, alert DMs and the summary counts all use the same icon, word and colour. */
const BUCKET: Record<Bucket, { icon: string; label: string; color: number }> = {
  gain: { icon: '🟢', label: 'Slight gain', color: Colors.success },
  even: { icon: '🟰', label: 'Even', color: Colors.muted },
  loss: { icon: '🟠', label: 'Slight loss', color: Colors.warning },
};
export const links = {
  profile: (id: number) => `https://www.roblox.com/users/${id}/profile`,
  trade: (id: number) => `https://www.roblox.com/users/${id}/trade`,
  /** Roblox ignores the hash, so the exact items ride along for a browser extension to pre-fill the trade window. */
  tradeWith: (id: number, give: number[], receive: number[]) => `https://www.roblox.com/users/${id}/trade#tradefinder?give=${give.join(',')}&get=${receive.join(',')}`,
  inventory: (id: number) => `https://www.roblox.com/users/${id}/inventory`,
  player: (id: number) => `https://www.rolimons.com/player/${id}`,
  item: (id: number) => `https://www.rolimons.com/item/${id}`,
};
const footer = (text: string) => ({ text: clip(text, LIMIT.footer) });
/** Avatar URLs come from the Roblox thumbnails API and may be unavailable; embeds must still render without them. */
export type Avatar = string | null | undefined;
const author = (name: string, url: string | null, avatar: Avatar) => ({ name: clip(name, LIMIT.author), ...(url ? { url } : {}), ...(avatar ? { iconURL: avatar } : {}) });
const withThumbnail = (embed: EmbedBuilder, avatar: Avatar) => (avatar ? embed.setThumbnail(avatar) : embed);
const message = (embed: EmbedBuilder, ...rows: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[]) => ({
  embeds: [embed], components: rows.filter(r => r.components.length), allowedMentions: { parse: [] as never[] },
});

/**
 * Rolimons logo and old Robux icon as application emojis, set at startup; plain labels until then.
 * `rolimonsIcon` is the same logo as a plain image URL, for embed author lines, which cannot render emoji.
 */
const statIcons = { value: 'V', rap: 'RAP', rolimonsIcon: '' };
export function setStatIcons(icons: Partial<typeof statIcons>): void { Object.assign(statIcons, icons); }

// ---------- Custom IDs ----------
/** Every interactive component carries a `tf:` custom ID so the router can ignore foreign components. */
export const ids = {
  build: (...parts: (string | number)[]) => `tf:${parts.join(':')}`,
  parse: (customId: string): { action: string; args: string[] } | null => {
    if (!customId.startsWith('tf:')) return null;
    const [, action = '', ...args] = customId.split(':');
    return { action, args };
  },
  encode: (n: number) => n.toString(36),
  encodeList: (ns: number[]) => ns.map(n => n.toString(36)).join(','),
  decode: (s: string): number => {
    const parsed = /^[0-9a-z]{1,12}$/.test(s) ? idSchema.safeParse(parseInt(s, 36)) : null;
    if (!parsed?.success) throw new UserError('This button is no longer valid. Run the command again.');
    return parsed.data;
  },
  decodeList: (s: string): number[] => s.split(',').filter(Boolean).map(ids.decode),
};

// ---------- Component helpers ----------
const link = (label: string, url: string, emoji?: string) => {
  const b = new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(clip(label, LIMIT.button)).setURL(url);
  return emoji ? b.setEmoji(emoji) : b;
};
const button = (customId: string, label: string, style = ButtonStyle.Secondary, emoji?: string, disabled = false) => {
  const b = new ButtonBuilder().setCustomId(customId).setLabel(clip(label, LIMIT.button)).setStyle(style).setDisabled(disabled);
  return emoji ? b.setEmoji(emoji) : b;
};
const row = (...buttons: ButtonBuilder[]) => new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons.slice(0, 5));
const selectRow = (menu: StringSelectMenuBuilder) => new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
/** Buttons shared between panels. Labels are verb first; the two DM toggles are the exception, reading as state (green on, red off). */
const nav = {
  settings: () => button(ids.build('view', 'settings'), 'Open settings', ButtonStyle.Secondary, '⚙️'),
  inventory: () => button(ids.build('view', 'inventory'), 'Show inventory', ButtonStyle.Secondary, '🎒'),
  help: () => button(ids.build('view', 'help'), 'Show help', ButtonStyle.Secondary, '❓'),
  find: () => button(ids.build('fq', 'show', '-', '-', 3), 'Find trades', ButtonStyle.Primary, '🔎'),
  items: () => button(ids.build('view', 'items'), 'Edit wanted items', ButtonStyle.Secondary, '⭐'),
  link: () => button(ids.build('linkmodal'), 'Link Roblox account', ButtonStyle.Primary, '🔗'),
  rolimons: (robloxId: number) => link('Open Rolimons', links.player(robloxId), '📈'),
  alerts: (on: boolean) => on
    ? button(ids.build('alerts', 'off'), 'Trade alerts: on', ButtonStyle.Success, '🔔')
    : button(ids.build('alerts', 'on'), 'Trade alerts: off', ButtonStyle.Danger, '🔕'),
  inventoryAlerts: (on: boolean) => on
    ? button(ids.build('invalerts', 'off'), 'Inventory DMs: on', ButtonStyle.Success, '🎒')
    : button(ids.build('invalerts', 'on'), 'Inventory DMs: off', ButtonStyle.Danger, '🎒'),
  /** Opens the alerts panel rather than flipping anything: settings points here instead of carrying DM toggles of its own. */
  alertsPage: () => button(ids.build('view', 'alerts'), 'Open alerts', ButtonStyle.Secondary, '🔔'),
  stopAlerts: () => button(ids.build('alerts', 'off'), 'Stop alerts', ButtonStyle.Danger, '🔕'),
};

// ---------- Trade rendering ----------
function itemLine(c: PricedCopy): string {
  const status = tradabilityTag(c);
  const flags = [status === 'On hold' && tagLabel(status), c.item.projected && '📈 projected', c.item.hyped && '🔥 hyped', c.item.rare && '💎 rare'].filter(Boolean).join(' · ');
  return `**[${escapeMarkdown(clip(c.item.name, 60))}](${links.item(c.assetId)})**\n`
    + `\`V ${number(effectiveValue(c.item))}\` \`RAP ${number(c.item.rap)}\` · ${demandLabel(c.item.demand)} demand\n`
    + `ID ${c.assetId} · Copy ${c.userAssetId}${flags ? ` · ${flags}` : ''}`;
}
/** One side of an exchange, one item per paragraph, cut to a field's size with a count of what was left out. */
function side(copies: PricedCopy[]): string {
  const lines: string[] = [];
  for (const c of copies) {
    const next = [...lines, itemLine(c)].join('\n\n');
    if (next.length > 1000) { lines.push(`…and ${copies.length - lines.length} more`); break; }
    lines.push(itemLine(c));
  }
  return clip(lines.join('\n\n'), LIMIT.field) || '—';
}
const bullets = (lines: string[]) => clip(lines.map(l => `• ${l}`).join('\n'), LIMIT.field);
/** The full maths of one exchange: both sides item by item, then value, RAP and balance tiles. Used by Re-check. */
function evaluationEmbed(r: Evaluation): EmbedBuilder {
  const gainIcon = r.valueGain > 0 ? '🟢' : r.valueGain < 0 ? '🔴' : '⚪';
  return new EmbedBuilder().setColor(r.passes ? Colors.success : Colors.warning)
    .setTitle(`${MODE_ICON[r.mode]} ${cap(r.mode)} · ${r.passes ? '✅ Meets your filters' : '⚠️ Outside your filters'}`)
    .addFields(
      { name: `📤 You give · ${r.give.length}`, value: side(r.give), inline: true },
      { name: `📥 You receive · ${r.receive.length}`, value: side(r.receive), inline: true },
      ...(r.passes ? [] : [{ name: '🚫 Why it fails', value: bullets(r.failures) }]),
      { name: `${gainIcon} Value`, value: `${number(r.receiving.value)} received − ${number(r.giving.value)} given\n= **${signed(r.valueGain)}** (${signed(r.valueGainPct)}%)`, inline: true },
      { name: '📊 RAP', value: `${number(r.receiving.rap)} received − ${number(r.giving.rap)} given\n= **${signed(r.rapGain)}** (${signed(r.rapGainPct)}%)`, inline: true },
      { name: '⚖️ Balance', value: `Your overpay **${number(r.overpayPct)}%**\nPartner loss **${number(r.partnerLossPct)}%**\nDemand ${number(r.giving.demand)} → ${number(r.receiving.demand)}`, inline: true },
      ...(r.warnings.length ? [{ name: '🔍 Before you send', value: bullets(r.warnings) }] : []),
    );
}
/** The Re-check button for a specific exchange; left out when the item lists would not fit in a custom ID. */
function recheckButton(partnerId: number, give: PricedCopy[], receive: PricedCopy[]): ButtonBuilder[] {
  const id = ids.build('recheck', ids.encode(partnerId), ids.encodeList(give.map(c => c.assetId)), ids.encodeList(receive.map(c => c.assetId)));
  return id.length <= 100 ? [button(id, 'Re-check now', ButtonStyle.Primary, '🔄')] : [];
}
/** The Re-check result: one exchange evaluated against both live inventories. */
export function analysisMessage(r: Evaluation, partner: { id: number; name: string }, avatar?: Avatar) {
  const embed = withThumbnail(evaluationEmbed(r), avatar)
    .setAuthor(author(`Proposed exchange with ${partner.name}`, links.profile(partner.id), avatar))
    .setDescription('Checked against both live inventories and your filters.')
    .setTimestamp();
  return message(embed,
    row(link('Open Roblox trade', links.trade(partner.id), '🔁'), nav.rolimons(partner.id)),
    row(...recheckButton(partner.id, r.give, r.receive)));
}

// ---------- Search ----------
/** Up to MAX_TARGETS items can be searched for at once; the limit keeps custom IDs under Discord's 100 characters. */
export const MAX_TARGETS = 5;
export interface SearchQuery { mode: Mode | null; targetIds: number[]; results: number }
const targetNames = (targetIds: number[], items?: Map<number, Item>) => targetIds.map(id => escapeMarkdown(clip(items?.get(id)?.name ?? `Item ${id}`, 40)));
/** Serialises a search query into custom-ID parts: mode, comma-separated base-36 target IDs (or -), result count. */
export const queryState = (q: SearchQuery): [string, string, number] => [q.mode === 'any' ? 'both' : q.mode ?? '-', q.targetIds.length ? ids.encodeList(q.targetIds) : '-', q.results];
export function parseQuery(mode = '-', targets = '-', results = '3'): SearchQuery {
  return { mode: mode === '-' || mode === 'any' ? null : mode === 'both' ? 'any' : modeSchema.parse(mode), targetIds: targets === '-' ? [] : [...new Set(ids.decodeList(targets))].slice(0, MAX_TARGETS), results: Math.min(3, Math.max(1, Number(results) || 3)) };
}
/** The query carried by a custom ID's trailing parts, in `queryState` order. */
export const queryFromArgs = (args: string[]): SearchQuery => parseQuery(args[0], args[1], args[2]);

// ---------- Trade list and alert DMs ----------
interface SellerEntry { index: number; best: Recommendation; alternatives: number }
const LIST_PAGE = 5;
/** One entry per seller (their best-scoring exchange), in the finder's own order, so the first exchange seen per seller is its best. */
function groupBySeller(recommendations: Recommendation[]): SellerEntry[] {
  const bySeller = new Map<number, SellerEntry>();
  for (const r of recommendations) {
    const entry = bySeller.get(r.ad.userId);
    if (!entry) bySeller.set(r.ad.userId, { index: 0, best: r, alternatives: 0 });
    else entry.alternatives++;
  }
  return [...bySeller.values()].map((e, index) => ({ ...e, index }));
}
/** Item names with ×N for repeats, for compact give/get fields. */
const names = (copies: PricedCopy[]) => {
  const counts = new Map<string, number>();
  for (const c of copies) counts.set(c.item.name, (counts.get(c.item.name) ?? 0) + 1);
  return [...counts].map(([name, n]) => `${escapeMarkdown(clip(name, 30))}${n > 1 ? ` ×${n}` : ''}`).join(', ') || '—';
};
const tradeUrl = (r: Recommendation) => links.tradeWith(r.ad.userId, r.give.map(c => c.assetId), r.receive.map(c => c.assetId));
const tradeWithButton = (r: Recommendation, prefix = '') => link(`${prefix}Trade with ${r.ad.username}`, tradeUrl(r), '🔁');
/**
 * One seller's best exchange, the same way on the trade list and in an alert DM: the outcome in the title, the seller
 * line, the rendered trade-<n>.png when there is one (else both sides as text), and when tradability was last checked.
 * The trade-window link lives on the Trade with button, so it is not repeated in the text.
 */
function sellerCard(r: Recommendation, prefix: string, card: string | null, character: Avatar, detailed = false): EmbedBuilder {
  const { icon, label, color } = BUCKET[bucketOf(r)];
  const embed = withThumbnail(new EmbedBuilder().setColor(color), character)
    .setTitle(`${prefix} ${icon} ${signed(r.valueGain)} value (${signed(r.valueGainPct)}%) · ${label}`)
    .setDescription(`**${escapeMarkdown(clip(r.ad.username, 20))}** · [Profile](${links.profile(r.ad.userId)}) · [Rolimons](${links.player(r.ad.userId)}) · ad ${time(r.ad.createdAt)}`);
  if (card) embed.setImage(`attachment://${card}`);
  // Five list cards share one 6,000-character message budget, so only a lone DM gets the per-item detail.
  else embed.addFields({ name: '📤 You give', value: (detailed ? side : names)(r.give) || '—', inline: true }, { name: '📥 You get', value: (detailed ? side : names)(r.receive) || '—', inline: true });
  return embed.addFields({ name: '🕒 Tradability checked', value: `Your items ${time(r.ownInventoryAt)} · Their items ${time(r.partnerInventoryAt)}` });
}
const PLACE_TRADE_NOTE = 'sends that offer with 0 Robux through your connected account (/connect); offers stay sendable for 15 minutes.';
/** A recommendation DM: the trade finder's seller card plus the Place Trade and Stop alerts buttons. `card` says whether trade-1.png is attached. */
export function alertMessage(r: Recommendation, options: { card?: boolean; character?: Avatar; placeToken?: string } = {}) {
  const embed = sellerCard(r, '🔔', options.card ? 'trade-1.png' : null, options.character, true).setTimestamp(r.ad.createdAt);
  if (options.placeToken) embed.setDescription(`${embed.data.description}\n**Place Trade** ${PLACE_TRADE_NOTE}`);
  // The Place Trade button sends exactly this offer through the bot; the token is looked up on click, so nothing else rides in the ID.
  return message(embed,
    row(tradeWithButton(r)),
    row(...(options.placeToken ? [button(ids.build('placealert', options.placeToken), 'Place Trade', ButtonStyle.Success)] : []), nav.stopAlerts()));
}
export const listPage = (result: SearchResult, page: number) => {
  const entries = groupBySeller(result.recommendations);
  const pages = Math.max(1, Math.ceil(entries.length / LIST_PAGE));
  const current = Math.min(Math.max(0, page), pages - 1);
  return { entries, pages, current, shown: entries.slice(current * LIST_PAGE, current * LIST_PAGE + LIST_PAGE) };
};
export interface TradeListOptions {
  items?: Map<number, Item>; page?: number;
  /** One rendered PNG per shown entry, keyed by entry index and attached as trade-<index+1>.png; a card falls back to text when absent. */
  cards?: Map<number, Buffer>;
  /** Seller character renders by Roblox user ID. */
  characters?: Map<number, string>;
  /** Present when the user can send through the bot: adds a numbered Place Trade button per seller. */
  sendToken?: string;
}
/** The finder's result: a summary of what was screened, then one seller card per row with Trade with / Place Trade buttons. */
export function tradeListMessage(result: SearchResult, query: SearchQuery, options: TradeListOptions = {}) {
  const { items, page = 0, cards = new Map<number, Buffer>(), characters = new Map<number, string>(), sendToken } = options;
  const { entries, pages, current, shown } = listPage(result, page);
  const counts = { gain: 0, even: 0, loss: 0 };
  for (const e of entries) counts[bucketOf(e.best)]++;
  const mode = findMode(query);
  const targetList = targetNames(query.targetIds, items);
  const target = targetList.length ? targetList.join(', ') : 'your wanted items';
  const screened = `Screened **${number(result.adsScanned)}** trade ads going back ${result.coverageMinutes} min`;
  const verified = `verified **${result.sellersChecked}** of ${result.candidateSellers} promising sellers.`;
  const scanned = mode === 'upgrade'
    ? `${screened}; **${number(result.adsOfferingTarget)}** offered ${targetList.length ? target : 'a wanted item'}; ${verified}`
    : mode === 'downgrade'
    ? `${screened} for bundles worth about +10% over ${targetList.length > 1 ? 'any one of ' : ''}${target}; ${verified}`
    : `${screened} for upgrades and downgrades${targetList.length ? ` involving ${target}` : ''}; ${verified}`;
  const tally = (['loss', 'even', 'gain'] as const).map(b => `${BUCKET[b].icon} ${counts[b]} ${BUCKET[b].label.toLowerCase()}`).join(' · ');
  const summary = mode === 'upgrade' ? `${tally} · slight losses first.` : mode === 'downgrade' ? 'Closest to +10% first.' : `${tally}.`;
  // "Both" with nothing picked has no subject to name; otherwise the title says what the list is for.
  const about = mode === 'both' && !targetList.length ? '' : ` ${clip(target, 60)}`;
  const embed = new EmbedBuilder().setColor(entries.length ? Colors.success : Colors.muted)
    .setTitle(entries.length
      ? `${MODE_ICON[mode]} ${plural(entries.length, 'person', 'people')} you can trade with${about && (mode === 'downgrade' ? ' to downgrade' : ' for')}${about}`
      : `🔎 No sendable ${mode === 'both' ? 'trades' : `${mode}s`}${about && ' for'}${about} right now`)
    .setDescription(clip(`${scanned}\n${entries.length ? summary : 'Nothing your items can cover right now. Try other items or check back later.'}${sendToken && entries.length ? `\n**Place Trade** ${PLACE_TRADE_NOTE}` : ''}`, LIMIT.description))
    .setFooter(footer(`Page ${current + 1}/${pages}`))
    .setTimestamp(result.pricesAt);
  const cardEmbeds = shown.map(e => sellerCard(e.best, `${e.index + 1}.`, cards.has(e.index) ? `trade-${e.index + 1}.png` : null, characters.get(e.best.ad.userId)));
  const state = queryState(query);
  const pager = (p: number, label: string, emoji: string, disabled: boolean) => button(ids.build('tl', p), label, ButtonStyle.Secondary, emoji, disabled);
  const panel = message(embed,
    row(...shown.map(e => tradeWithButton(e.best, `${e.index + 1} · `))),
    row(...(sendToken ? shown.map(e => button(ids.build('place', sendToken, e.index), `${e.index + 1} · Place Trade`, ButtonStyle.Success)) : [])),
    ...(pages > 1 ? [row(pager(current - 1, 'Previous', '◀️', current === 0), button(ids.build('tl', current), `Page ${current + 1} / ${pages}`, ButtonStyle.Secondary, '📄', true), pager(current + 1, 'Next', '▶️', current >= pages - 1))] : []),
    row(button(ids.build('find', ...state), 'Search again', ButtonStyle.Primary, '🔁'), button(ids.build('fq', 'show', ...state), 'Change search', ButtonStyle.Secondary, '🎛️'),
      button(ids.build('sfiltersmodal', ...state), 'Edit filters', ButtonStyle.Secondary, '🎚️')));
  return { ...panel, embeds: [embed, ...cardEmbeds] };
}
export function expiredSearchMessage() {
  const embed = new EmbedBuilder().setColor(Colors.muted).setTitle('⌛ Search expired')
    .setDescription('Results are kept for 15 minutes so prices and inventories stay fresh. Run the search again for a current list.');
  return message(embed, row(nav.find()));
}

// ---------- Find panel ----------
type Coverage = ArchiveStats | undefined;
const reach = (minutes: number) => (minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`);
/**
 * What the archive holds right now. It is a rolling window kept on the bot's own disk: ads past the retention window
 * are deleted, and once the row cap is reached each new ad displaces the oldest one.
 */
const coverageLine = (c: Coverage) => {
  if (!c?.count) return 'Archive filling up; the live feed is used meanwhile';
  const rolling = c.maxAds ? ` of ${number(c.maxAds)} kept` : '';
  const rate = c.perHour ? ` · ~${number(c.perHour)}/h` : '';
  const size = c.bytes ? ` · ${(c.bytes / 1048576).toFixed(1)} MB on disk` : '';
  return `${number(c.count)} ads${rolling} · back ${reach(c.minutes)}${rate}${size}`;
};
/** An item the user could give away in downgrade mode. */
export interface GiveChoice { id: number; name: string; value: number }
type FindMode = 'upgrade' | 'downgrade' | 'both';
export const findMode = (q: SearchQuery): FindMode => (q.mode === 'downgrade' ? 'downgrade' : q.mode === 'upgrade' ? 'upgrade' : 'both');
/** The user's loss/gain window in words. An upgrade's loss is its overpay, which has a window of its own. */
const lossGainText = (p: Preferences) => `${p.minValueGainPct < 0 ? `up to ${-p.minValueGainPct}% loss` : 'no loss'} on downgrades · upgrades use the overpay window · ${formatMixedRange(upgradeWindow(p))} overpay`;
/** What the receive-value filter currently means, for panels: off, the auto band, or a typed range. */
function receiveRangeText(p: Preferences, auto?: Range | null): string {
  if (!p.affordable) return 'any value';
  if (p.minReceiveValue !== null || p.maxReceiveValue !== null) return `${formatRange({ min: p.minReceiveValue, max: p.maxReceiveValue }, number)} · your range`;
  return auto ? `${formatRange(auto, number)} · your best item up to your top four together` : 'your best item up to your top four together';
}
export function findPanel(query: SearchQuery, user: UserProfile, items?: Map<number, Item>, note?: string, coverage?: Coverage, giveChoices: GiveChoice[] = [], affordable?: Range | null) {
  const p = user.preferences;
  const mode = findMode(query);
  const names = targetNames(query.targetIds, items);
  const [, targetEnc, results] = queryState(query);
  const pickTargets = mode !== 'downgrade';
  // Downgrade give-aways are named from the user's own giveable items first, then the catalog; each one is searched on its own.
  const giveNames = query.targetIds.map(id => escapeMarkdown(clip(giveChoices.find(c => c.id === id)?.name ?? items?.get(id)?.name ?? `Item ${id}`, 40)));
  const selection = pickTargets
    ? { name: names.length > 1 ? `🎯 I want · ${names.length}` : '🎯 I want', value: clip(names.length ? names.join(', ') : p.targetIds.length ? `Any of your ${p.targetIds.length} wanted items` : mode === 'both' ? 'Anything' : '*Pick or type an item*', LIMIT.field) }
    : { name: giveNames.length > 1 ? `📤 I give · ${giveNames.length} (one per trade)` : '📤 I give', value: clip(giveNames.length ? giveNames.join(', ') : `*Pick up to ${MAX_TARGETS} of your items*`, LIMIT.field) };
  const embed = new EmbedBuilder().setColor(Colors.brand).setTitle(`🔎 Find trades · ${MODE_ICON[mode]} ${cap(mode)}`)
    .setDescription(note ?? null)
    .addFields(
      { name: '🎛️ Mode', value: `${MODE_ICON[mode]} ${cap(mode)}`, inline: true },
      { ...selection, inline: true },
      { name: '📐 Loss / gain', value: lossGainText(p), inline: true },
      { name: '💸 Value of what I receive', value: receiveRangeText(p, affordable), inline: true },
      { name: '🎚️ Filters', value: gainSummary(p), inline: true },
      { name: '📡 Trade ad archive', value: coverageLine(coverage) },
    )
  const modes = (['both', 'upgrade', 'downgrade'] as const).map(m =>
    button(ids.build('fq', 'mode', m, m === mode || (m !== 'downgrade' && mode !== 'downgrade') ? targetEnc : '-', results), cap(m), mode === m ? ButtonStyle.Primary : ButtonStyle.Secondary, MODE_ICON[m], mode === m));
  const afford = button(ids.build('fq', 'afford', mode, targetEnc, results), p.affordable ? 'Affordable: on' : 'Affordable: off', p.affordable ? ButtonStyle.Success : ButtonStyle.Danger, '💸');
  let menu: StringSelectMenuBuilder;
  if (pickTargets) {
    // Wanted items plus any typed targets not on the wanted list; several can be selected at once.
    const choices = [...new Set([...query.targetIds, ...p.targetIds])].slice(0, 24);
    menu = new StringSelectMenuBuilder().setCustomId(ids.build('fq', 'target', mode, results)).setPlaceholder('🎯 Choose one or more items you want')
      .setMinValues(1).setMaxValues(Math.min(MAX_TARGETS, choices.length + 1))
      .addOptions({ label: 'Any item in your range', value: '-', emoji: '💸', description: clip(receiveRangeText(p, affordable), LIMIT.option), default: !query.targetIds.length },
        ...choices.map(id => ({ label: clip(items?.get(id)?.name ?? `Item ${id}`, LIMIT.option), value: ids.encode(id), emoji: p.targetIds.includes(id) ? '⭐' : '🎯', default: query.targetIds.includes(id) })));
  } else {
    const options = giveChoices.slice(0, 25).map(c => ({ label: clip(c.name, LIMIT.option), value: ids.encode(c.id), description: `Value ${number(c.value)}`, emoji: '📤', default: query.targetIds.includes(c.id) }));
    menu = new StringSelectMenuBuilder().setCustomId(ids.build('fq', 'give', mode, results)).setPlaceholder(options.length ? `📤 Choose up to ${MAX_TARGETS} items to give away (one per trade)` : 'No available items to give')
      .setMinValues(1).setMaxValues(Math.max(1, Math.min(MAX_TARGETS, options.length)))
      .addOptions(options.length ? options : [{ label: 'Nothing available', value: '-', description: 'Link an account with public, non-projected limiteds' }]).setDisabled(!options.length);
  }
  const ready = pickTargets || query.targetIds.length > 0;
  return message(embed, row(...modes), selectRow(menu),
    row(button(ids.build('find', mode, targetEnc, results), pickTargets ? 'Find trades' : `Find bundles for my item${query.targetIds.length > 1 ? 's' : ''}`, ButtonStyle.Success, '🚀', !ready), afford,
      button(ids.build('sfiltersmodal', mode, targetEnc, results), 'Edit filters', ButtonStyle.Secondary, '🎚️'),
      button(ids.build('targetmodal', mode, results, targetEnc), pickTargets ? 'Type items' : 'Type my items', ButtonStyle.Secondary, '✏️')));
}
/** One-line description of the gain filters, in both percentage and absolute terms. */
function gainSummary(p: Preferences): string {
  const rules = Object.keys(p.itemRules).length;
  return `⬇️ Downgrade profit ${formatMixedRange(downgradeWindow(p))} · ⬆️ Upgrade overpay ${formatMixedRange(upgradeWindow(p))}${rules ? ` · 🎯 ${rules} per-item rule${rules === 1 ? '' : 's'}` : ''} · ⏱️ ads ≤ ${p.maxAdAgeMinutes} min`;
}
/** Text shown in a form box for a saved profit range. */
const rangeText = (min: number | null, max: number | null) => (min !== null && max !== null ? `${min} - ${max}` : min !== null ? `${min}` : max !== null ? `- ${max}` : '');
/**
 * Asked whenever the finder is about to work on "Any item in your range": the value band of the items to look for.
 * Blank falls back to what the user's own items can afford. `next` is `find` when the answer should run the search
 * straight away, and `panel` when it should just redraw the finder.
 */
export function rangeModal(user: UserProfile, mode: string, results: number | string, next: 'find' | 'panel' = 'panel') {
  const p = user.preferences;
  return new ModalBuilder().setCustomId(ids.build('range', mode, results, next)).setTitle('💸 Price range').addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId('range').setLabel('Value range of items to look for').setStyle(TextInputStyle.Short)
        .setValue(rangeText(p.minReceiveValue, p.maxReceiveValue)).setPlaceholder('e.g. 5000 - 20000 · - Valk · blank = what your items can afford').setRequired(false).setMaxLength(80)));
}
/** Gain filters for finding better trades: percentage and absolute floors, plus the overpay cap. Blank amounts mean no floor. */
export function searchFiltersModal(user: UserProfile, state: (string | number)[]) {
  const p = user.preferences;
  const input = (id: string, label: string, value: string, placeholder: string, required = true, max = 12) => new ActionRowBuilder<TextInputBuilder>().addComponents(
    new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(TextInputStyle.Short).setValue(value).setPlaceholder(placeholder).setMaxLength(max).setRequired(required));
  return new ModalBuilder().setCustomId(ids.build('sfilters', ...state)).setTitle('🎚️ Filters').addComponents(
    input('downgradeRange', 'Downgrade profit range (% or value)', mixedRangeText({ min: p.downgradeProfitMin, max: p.downgradeProfitMax }), `e.g. 5% - 25% · 1000 - 5000 · blank = ${formatMixedRange(downgradeWindow(defaultPreferences()))}`, false, 80),
    input('upgradeRange', 'Upgrade overpay range (% or value)', mixedRangeText({ min: p.upgradeOverpayMin, max: p.upgradeOverpayMax }), `e.g. 5% - 15% · what you pay to consolidate · blank = ${formatMixedRange(upgradeWindow(defaultPreferences()))}`, false, 80),
    input('receiveRange', 'Any item in your range (value of what I get)', rangeText(p.minReceiveValue, p.maxReceiveValue), 'e.g. 5000 - 20000 · - Valk · blank = what your items can afford', false, 80),
    input('maxAdAgeMinutes', 'Max ad age in minutes (1 to 1440)', String(p.maxAdAgeMinutes), 'How far back to screen ads'));
}
/** Per-item profit rule form: the item and the profit window required when a trade brings that item in. */
export function itemRuleModal() {
  const box = (id: string, label: string, placeholder: string, required: boolean, max: number) => new ActionRowBuilder<TextInputBuilder>().addComponents(
    new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(TextInputStyle.Short).setPlaceholder(placeholder).setRequired(required).setMaxLength(max));
  return new ModalBuilder().setCustomId(ids.build('itemrule')).setTitle('🎯 Profit rule for an item').addComponents(
    box('item', 'Item name, acronym or catalog ID', 'e.g. Valk, STF or 1365767', true, 120),
    box('range', 'Profit range when receiving (blank = remove)', 'e.g. 2000 · 2000 - 10000 · STF to Valk · - 5000', false, 80));
}
export function targetModal(mode: string, results: number | string, targets = '-') {
  const downgrade = mode === 'downgrade';
  return new ModalBuilder().setCustomId(ids.build('target', mode, results, targets)).setTitle(downgrade ? 'Which of your items to give away' : 'Search for specific items').addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId('item').setLabel(downgrade ? `Up to ${MAX_TARGETS} items you own, comma separated` : `Up to ${MAX_TARGETS} items, comma separated`).setStyle(TextInputStyle.Paragraph)
        .setPlaceholder('Full names, Rolimons acronyms (STF, Valk) or Roblox IDs · e.g. Valk, STF, 1029025').setMinLength(1).setMaxLength(400).setRequired(true)));
}

// ---------- Account panels ----------
function itemList(idsToShow: number[], items?: Map<number, Item>, empty = 'none'): string {
  if (!idsToShow.length) return `*${empty}*`;
  const lines = idsToShow.map(id => { const item = items?.get(id); return item ? `[${escapeMarkdown(clip(item.name, 40))}](${links.item(id)})` : `\`${id}\``; });
  const out = lines.join(' · ');
  return clip(out.length > 1000 ? `${lines.slice(0, 15).join(' · ')} · +${lines.length - 15} more` : out, LIMIT.field);
}
export function profitMessage(user: UserProfile, items?: Map<number, Item>, note?: string) {
  const p = user.preferences;
  const rules = Object.keys(p.itemRules).length;
  const embed = new EmbedBuilder().setColor(Colors.brand).setTitle('💰 Trade profit')
    .setDescription(`${note ? `${note}\n\n` : ''}How much profit or loss you are willing to take on a trade, measured in value.`)
    .addFields(
      { name: '📉 Loss I will accept', value: p.minValueGainPct < 0 ? `up to **${-p.minValueGainPct}%** of what I give` : 'none · even or better', inline: true },
      { name: '📈 Gains', value: 'up to **+10%** · more only when the seller\'s ad asks for your exact items', inline: true },
      { name: '⬇️ Downgrade profit', value: formatMixedRange({ min: p.downgradeProfitMin, max: p.downgradeProfitMax }), inline: true },
      { name: '⬆️ Upgrade overpay', value: formatMixedRange({ min: p.upgradeOverpayMin, max: p.upgradeOverpayMax }), inline: true },
      { name: `🎯 Per-item rules · ${rules}`, value: rules ? clip(Object.entries(p.itemRules).slice(0, 8).map(([id, r]) => `${escapeMarkdown(clip(items?.get(Number(id))?.name ?? `Item ${id}`, 30))} · ${formatRange(r, number)}`).join('\n'), LIMIT.field) : 'none · the profit range applies to every trade', inline: true },
    );
  return message(embed,
    row(button(ids.build('filtersmodal'), 'Edit profit / loss', ButtonStyle.Primary, '✏️'), button(ids.build('rulemodal'), 'Set profit per item', ButtonStyle.Secondary, '🎯'), nav.find()));
}
/** Numeric alert filters are edited in a pop-up form; all of them are value-based. */
export function filtersModal(user: UserProfile) {
  const p = user.preferences;
  const input = (id: string, label: string, value: number, placeholder: string) => new ActionRowBuilder<TextInputBuilder>().addComponents(
    new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(TextInputStyle.Short).setValue(String(value)).setPlaceholder(placeholder).setMinLength(1).setMaxLength(8).setRequired(true));
  return new ModalBuilder().setCustomId(ids.build('filters')).setTitle('💰 Edit profit / loss').addComponents(
    input('maxLossPct', 'Loss I will accept % (0 to 50)', Math.max(0, -p.minValueGainPct), '0 = even or better · any gain above is fine'),
    input('maxAdAgeMinutes', 'Max ad age in minutes (1 to 1440)', p.maxAdAgeMinutes, 'e.g. 60'));
}
/** Wanted item list with an add form, a remove menu and per-item profit rules. */
export function itemsPanel(user: UserProfile, items?: Map<number, Item>, note?: string) {
  const p = user.preferences;
  const embed = new EmbedBuilder().setColor(Colors.brand).setTitle('⭐ Wanted items')
    .setDescription(`${note ? `${note}\n\n` : ''}Wanted items steer searches and alerts toward what you want to receive.`)
    .addFields(
      { name: `⭐ Wanted · ${p.targetIds.length}/100`, value: itemList(p.targetIds, items, 'any item') },
      { name: `🎯 Profit rules · ${Object.keys(p.itemRules).length}`, value: clip(Object.entries(p.itemRules).map(([id, r]) =>
        `[${escapeMarkdown(clip(items?.get(Number(id))?.name ?? `Item ${id}`, 40))}](${links.item(Number(id))}) · profit ${formatRange(r, number)}`).join('\n'), LIMIT.field)
        || '*none*' },
    )
  const option = (id: number, emoji: string) => ({ label: clip(items?.get(id)?.name ?? `Item ${id}`, LIMIT.option), value: ids.encode(id), emoji, description: `ID ${id}` });
  const menu = (action: string, list: number[], placeholder: string, emoji: string) => list.length
    ? [selectRow(new StringSelectMenuBuilder().setCustomId(ids.build(action)).setPlaceholder(placeholder)
      .setMinValues(1).setMaxValues(Math.min(list.length, 24) + 1)
      .addOptions(...list.slice(0, 24).map(id => option(id, emoji)), { label: 'Clear the whole list', value: 'all', emoji: '🧹' }))]
    : [];
  return message(embed,
    row(button(ids.build('watchmodal'), 'Add wanted items', ButtonStyle.Success, '⭐'), button(ids.build('rulemodal'), 'Set profit per item', ButtonStyle.Primary, '🎯'), nav.find()),
    ...menu('unwatch', p.targetIds, '➖ Remove wanted items (pick several)', '⭐'),
    ...menu('unrule', Object.keys(p.itemRules).map(Number), '🎯 Remove a profit rule', '🎯'));
}
/** Several items matched a typed name: let the user click the right one. `state` routes the pick back to the original action. */
export function pickItemMessage(query: string, matches: Item[], state: (string | number)[]) {
  const embed = new EmbedBuilder().setColor(Colors.warning).setTitle('🤔 Which item did you mean?')
    .setDescription(`**${matches.length}** items match \`${escapeMarkdown(clip(query, 40))}\`. Pick one below, or type the full name, its Rolimons acronym or the Roblox item ID.`)
    .addFields({ name: '🔎 Matches', value: clip(matches.slice(0, 10).map(i => `[${escapeMarkdown(clip(i.name, 40))}](${links.item(i.id)})${i.acronym ? ` · **${escapeMarkdown(i.acronym)}**` : ''} · \`${i.id}\``).join('\n'), LIMIT.field) });
  const menu = new StringSelectMenuBuilder().setCustomId(ids.build('pick', ...state)).setPlaceholder('🎯 Choose the item')
    .addOptions(matches.slice(0, 25).map(i => ({ label: clip(i.name, LIMIT.option), value: ids.encode(i.id), description: clip(`${i.acronym ? `${i.acronym} · ` : ''}ID ${i.id} · V ${number(effectiveValue(i))}`, LIMIT.option), emoji: '🎯' })));
  return message(embed, selectRow(menu), row(nav.items(), nav.find()));
}
export function itemModal() {
  return new ModalBuilder().setCustomId(ids.build('addwatch')).setTitle('⭐ Add wanted items').addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId('item').setLabel('Items, comma separated').setStyle(TextInputStyle.Paragraph)
        .setPlaceholder('Full names, Rolimons acronyms (STF, Valk) or Roblox IDs · e.g. Valk, STF, 1029025').setMinLength(1).setMaxLength(600).setRequired(true)));
}
export function deleteConfirmMessage() {
  const embed = new EmbedBuilder().setColor(Colors.danger).setTitle('🗑️ Delete your data?')
    .setDescription('This removes your tracked Roblox account, saved session, filters, wanted list and alert history. Alerts and bot trade sending stop immediately.\nYou can link an account again any time.');
  return message(embed, row(button(ids.build('delete', 'yes'), 'Yes, delete everything', ButtonStyle.Danger, '🗑️'), button(ids.build('view', 'settings'), 'Keep my data', ButtonStyle.Secondary, '↩️')));
}
/** Account, search filters and lists. Everything about DMs lives on the alerts panel, which the 🔔 tab opens. */
export function settingsMessage(user: UserProfile, items?: Map<number, Item>, avatar?: Avatar, coverage?: Coverage, note?: string) {
  const p = user.preferences;
  const embed = withThumbnail(new EmbedBuilder().setColor(Colors.brand), avatar)
    // The Rolimons logo sits against the username and is the link through to that player's Rolimons page.
    .setAuthor(author(user.username, links.player(user.robloxId), statIcons.rolimonsIcon || avatar))
    .setTitle('⚙️ Settings')
    .setDescription(note ?? null)
    .addFields(
      { name: '🆔 Roblox ID', value: `\`${user.robloxId}\``, inline: true },
      { name: '⏱️ Max ad age', value: `${p.maxAdAgeMinutes} min`, inline: true },
      { name: '💸 Any item in your range', value: receiveRangeText(p), inline: true },
      { name: '💰 Trade profit', value: lossGainText(p), inline: false },
      { name: `⭐ Wanted · ${p.targetIds.length}`, value: itemList(p.targetIds, items, 'any item'), inline: true },
      { name: '📡 Trade ad archive', value: coverageLine(coverage), inline: false },
    );
  return message(embed, row(nav.find(), nav.items(), nav.inventory(), nav.alertsPage()));
}
/** How many trade DMs one alert check may send; offered next to the on/off toggle. */
const ALERT_RATES = [1, 2, 3, 5, 8, 10] as const;
const RATE_EMOJI: Record<(typeof ALERT_RATES)[number], string> = { 1: '🐢', 2: '🚶', 3: '🔔', 5: '🏃', 8: '🔥', 10: '🚀' };
/** The gap between alert checks, in words; the monitor's poll interval decides it. */
const everyText = (scanSeconds: number) => (scanSeconds === 60 ? 'minute' : scanSeconds < 120 ? `${scanSeconds} seconds` : `${Math.round(scanSeconds / 60)} minutes`);
/** Most DMs an hour at this rate: the checks that fit in an hour, or the safety ceiling, whichever bites first. */
const perHour = (perScan: number, scanSeconds: number) => Math.min(perScan * Math.round(3600 / Math.max(1, scanSeconds)), alertHourlyCap(perScan));
const alertRateText = (p: Preferences, scanSeconds = 60) =>
  `up to **${p.alertsPerScan}** per check · a check runs every ${everyText(scanSeconds)} · at most ${perHour(p.alertsPerScan, scanSeconds)} an hour`;
export function alertsMessage(user: UserProfile, scanSeconds = 60, note?: string, lastAlertAt?: number | null) {
  const p = user.preferences;
  const embed = new EmbedBuilder().setColor(user.alerts ? Colors.success : Colors.muted)
    .setTitle(user.alerts ? '🔔 Alerts on' : '🔕 Alerts off')
    .setDescription(note ?? (user.alerts
      ? 'DMs for new recommendations that match your wanted items and profit filters. Allow DMs from this bot.'
      : 'Recommendation DMs are off.'))
    .addFields(
      { name: '📨 How many trades I send', value: alertRateText(p, scanSeconds), inline: true },
      { name: '🎒 Inventory DMs', value: user.inventoryAlerts ? 'On · every trade, sale or purchase' : 'Off', inline: true },
      { name: '🕒 Last alert DM', value: lastAlertAt ? time(lastAlertAt) : 'none yet', inline: true },
    );
  if (user.alertError) embed.addFields({ name: '⚠️ Last alert issue', value: clip(user.alertError, LIMIT.field) });
  const rate = selectRow(new StringSelectMenuBuilder().setCustomId(ids.build('alertrate')).setPlaceholder('📨 How many trades per check')
    .addOptions(ALERT_RATES.map(n => ({
      label: `${plural(n, 'trade')} per check`, value: String(n), emoji: RATE_EMOJI[n],
      description: `at most ${perHour(n, scanSeconds)} DMs an hour`, default: p.alertsPerScan === n,
    }))));
  return message(embed, row(nav.alerts(user.alerts), nav.inventoryAlerts(user.inventoryAlerts), nav.items()), rate);
}
export function inventoryAlertsMessage(user: UserProfile, copies?: number) {
  const embed = new EmbedBuilder().setColor(user.inventoryAlerts ? Colors.success : Colors.muted)
    .setTitle(user.inventoryAlerts ? '🎒 Inventory DMs on' : '🎒 Inventory DMs off')
    .setDescription(user.inventoryAlerts
      ? `A DM whenever a copy leaves or joins your public inventory, with what went out, what came in and the value change.${copies === undefined ? '' : ` Starting from your current **${copies}** cop${copies === 1 ? 'y' : 'ies'}.`}`
      : 'Inventory DMs are off.');
  return message(embed, row(nav.inventoryAlerts(user.inventoryAlerts), nav.inventory()));
}
const changeLine = (copies: PricedCopy[]) => {
  const counts = new Map<string, { id: number; name: string; n: number; value: number; status: string }>();
  for (const c of copies) {
    const status = tradabilityTag(c), key = `${c.itemTarget?.itemType ?? 'Asset'}:${c.itemTarget?.targetId ?? c.assetId}:${status}`;
    const e = counts.get(key); if (e) e.n++;
    else counts.set(key, { id: c.assetId, name: c.item.name, n: 1, value: effectiveValue(c.item), status });
  }
  return clip([...counts.values()].map(e => `[${escapeMarkdown(clip(e.name, 40))}](${links.item(e.id)})${e.n > 1 ? ` **×${e.n}**` : ''} · ${e.value > 0 ? `${statIcons.value} ${number(e.value)}` : 'no price'} · ${tagLabel(e.status)}`).join('\n'), LIMIT.field) || '—';
};
/**
 * DM sent when the monitor notices copies leaving or joining the inventory. `card` says whether a rendered
 * inventory-change.png is attached; without it the two sides are listed as text.
 */
export function inventoryChangeMessage(user: UserProfile, c: InventoryChange, options: { avatar?: Avatar; card?: boolean; checkedAt?: number } = {}) {
  const out = c.removed.length, inn = c.added.length;
  const title = c.kind === 'trade' ? `🔁 Trade detected · ${signed(c.valueGain)} value${c.valueGainPct !== null ? ` (${signed(c.valueGainPct)}%)` : ''}`
    : c.kind === 'out' ? `📤 ${out} cop${out === 1 ? 'y' : 'ies'} left your inventory · ${signed(c.valueGain)} value`
    : `📥 ${inn} new cop${inn === 1 ? 'y' : 'ies'} in your inventory · ${signed(c.valueGain)} value`;
  const color = c.valueGain > 0 ? Colors.success : c.valueGain < 0 ? Colors.warning : Colors.muted;
  const embed = withThumbnail(new EmbedBuilder().setColor(color), options.avatar)
    .setAuthor(author(`${user.username} · inventory change`, links.player(user.robloxId), options.avatar))
    .setTitle(title)
    .setDescription(c.kind === 'trade' ? `${out} cop${out === 1 ? 'y' : 'ies'} out, ${inn} in since the last check.` : c.kind === 'out' ? 'Sold, traded away or otherwise gone since the last check.' : 'Bought, received or otherwise new since the last check.')
    .addFields(
      { name: `${c.valueGain > 0 ? '🟢' : c.valueGain < 0 ? '🔴' : '⚪'} Value`, value: `${number(c.gained.value)} in − ${number(c.lost.value)} out\n= **${signed(c.valueGain)}**${c.valueGainPct !== null ? ` (${signed(c.valueGainPct)}%)` : ''}`, inline: true },
      { name: '📊 RAP', value: `${number(c.gained.rap)} in − ${number(c.lost.rap)} out\n= **${signed(c.rapGain)}**`, inline: true },
      { name: '🎒 Inventory now', value: `${c.before.copies} → **${c.after.copies}** copies\n${number(c.before.value)} → **${number(c.after.value)}** value`, inline: true },
    );
  if (options.card) embed.setImage('attachment://inventory-change.png');
  else embed.addFields({ name: `📤 Out · ${out}`, value: changeLine(c.removed), inline: true }, { name: `📥 In · ${inn}`, value: changeLine(c.added), inline: true });
  if (c.unpriced) embed.addFields({ name: 'ℹ️ Note', value: `${plural(c.unpriced, 'copy has', 'copies have')} no known price and count as 0.` });
  embed.setTimestamp(options.checkedAt ?? Date.now());
  return message(embed, row(nav.inventory(), button(ids.build('invalerts', 'off'), 'Stop inventory DMs', ButtonStyle.Danger, '🔕'), nav.rolimons(user.robloxId)));
}
export function linkMessage(roblox: { id: number; name: string }, copies: number, avatar?: Avatar, note?: string) {
  const embed = withThumbnail(new EmbedBuilder().setColor(Colors.success), avatar)
    .setTitle(`✅ Tracking ${escapeMarkdown(roblox.name)}`)
    .setDescription(`Your public inventory is linked.${note ? `\n\n${note}` : ''}`)
    .addFields({ name: '🆔 Roblox ID', value: `\`${roblox.id}\``, inline: true }, { name: '🎒 Public copies', value: `${copies}`, inline: true })
  return message(embed, row(nav.find(), nav.inventory(), nav.rolimons(roblox.id)));
}
export interface InventoryPage { view: InventoryView; page: number; pages: number; entries: InventoryEntry[]; total: number; copies: number; value: number; rap: number; note?: string }
const TAG_EMOJI: Record<string, string> = { Tradable: '✅', 'On hold': '⏳', 'Not tradable': '🚫', 'Tradability unknown': '❔', rare: '💎', projected: '📈', hyped: '🔥', unpriced: '❔', 'on hold': '⏳' };
/** Untradable copies are never listed, so a plain "Tradable" says nothing; only the exceptions are shown. */
const visibleTags = (tags: string[]) => tags.filter(t => t !== 'Tradable' && t !== 'Tradability unknown');
const tagLabel = (tag: string) => `${TAG_EMOJI[tag] ?? TAG_EMOJI['on hold']} ${tag}`;
/** Paged inventory: a rendered grid of item squares (attached as inventory.png) or a plain text list, with a toggle between them. */
export function inventoryMessage(user: UserProfile, inv: InventoryPage, avatar?: Avatar) {
  const grid = inv.view === 'grid';
  const first = inv.page * PAGE_SIZE[inv.view] + 1;
  const embed = withThumbnail(new EmbedBuilder().setColor(Colors.brand), avatar)
    .setAuthor(author(`${user.username}'s inventory`, null, avatar))
    .setTitle(`🎒 ${plural(inv.total, 'item')} · ${plural(inv.copies, 'copy', 'copies')}`)
    .addFields(
      { name: `${statIcons.value === 'V' ? '💰' : statIcons.value} Tradable value`, value: number(inv.value), inline: true },
      { name: `${statIcons.rap === 'RAP' ? '📊' : statIcons.rap} Tradable RAP`, value: number(inv.rap), inline: true },
    )
    .setTimestamp();
  if (inv.note) embed.setFooter({ text: inv.note });
  if (grid) { embed.setImage('attachment://inventory.png'); if (!inv.total) embed.setDescription('*No collectible items were found in this public inventory.*'); }
  else embed.setDescription(clip(inv.entries.map((e, i) => {
    const name = `[${escapeMarkdown(clip(e.name, 40))}](${links.item(e.assetId)})${e.quantity > 1 ? ` **${e.quantity}x**` : ''}`;
    const price = e.value === null ? 'no price' : `${statIcons.value} ${number(e.value)} · ${statIcons.rap} ${number(e.rap ?? 0)}`;
    return `**${first + i}.** ${name} · ${price}${visibleTags(e.tags).length ? ` · ${visibleTags(e.tags).map(tagLabel).join(' ')}` : ''}`;
  }).join('\n'), LIMIT.description) || '*No collectible items were found in this public inventory.*');
  const pager = (page: number, label: string, emoji: string, disabled: boolean) => button(ids.build('inv', inv.view, page), label, ButtonStyle.Secondary, emoji, disabled);
  return message(embed,
    row(pager(inv.page - 1, 'Previous', '◀️', inv.page === 0), pager(inv.page + 1, 'Next', '▶️', inv.page >= inv.pages - 1),
      button(ids.build('inv', grid ? 'text' : 'grid', 0), grid ? 'Show as text' : 'Show as grid', ButtonStyle.Primary, grid ? '📝' : '🖼️')),
    row(nav.rolimons(user.robloxId)));
}
export function deletedMessage() {
  const embed = new EmbedBuilder().setColor(Colors.muted).setTitle('🗑️ Your data was deleted')
    .setDescription('Tracked account, saved session, preferences and alert history are gone. Alerts and bot trade sending are off.\nYou can link an account again at any time.');
  return message(embed, row(nav.link(), nav.help()));
}

// ---------- Help ----------
export function helpMessage() {
  const embed = new EmbedBuilder().setColor(Colors.brand).setTitle('👋 Tradefinder')
    .setDescription('Finds Roblox limited-item trades in recent Rolimons trade ads, checks both inventories, and sends the offer you pick with **Place Trade**.')
    .addFields(
      { name: '1️⃣ Connect', value: '🔐 `/connect` — save your Roblox session (encrypted) to verify tradability and send trades · 🔗 `/link` — track a public inventory only · 🔓 `/disconnect` — remove the session.' },
      { name: '2️⃣ Set up', value: '💰 `/profit` — the loss you accept · ⚙️ `/settings` — account, filters and lists.' },
      { name: '3️⃣ Search', value: '🔎 `/trade` — pick a mode and items, press **Find trades**, then **Place Trade** on the offer you want.' },
      { name: '4️⃣ Wanted items', value: '⭐ `/watch` — items you want to receive and per-item profit rules.' },
      { name: '5️⃣ Alerts', value: '🔔 `/alerts` — recommendation DMs (each with Place Trade) and inventory DMs for every trade, sale or purchase.' },
      { name: 'ℹ️ More', value: '🎒 `/inventory` — your items · 🗑️ `/delete` — remove your data.' },
    )
  return message(embed, row(nav.link(), nav.find(), nav.settings(), nav.items()));
}
export function linkModal() {
  const box = (id: string, label: string, placeholder: string, required: boolean, max: number) => new ActionRowBuilder<TextInputBuilder>().addComponents(
    new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(TextInputStyle.Short).setPlaceholder(placeholder).setRequired(required).setMaxLength(max));
  return new ModalBuilder().setCustomId(ids.build('link')).setTitle('🔗 Link your Roblox account').addComponents(
    box('user', 'What is your Roblox username or user ID?', 'e.g. builderman or 156', true, 20),
    box('wanted', 'Items you want to receive (optional)', 'Names, acronyms or IDs, comma separated · e.g. Valk, STF', false, 200));
}
export function connectModal() {
  return new ModalBuilder().setCustomId(ids.build('connect')).setTitle('🔐 Connect Roblox for trade sending').addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('cookie')
      .setLabel('.ROBLOSECURITY (full account access)').setStyle(TextInputStyle.Paragraph)
      .setPlaceholder('Trust this bot first. Discord and the bot receive this cookie. Never paste it in chat.')
      .setRequired(true).setMaxLength(4000)));
}
export function connectedMessage(account: { id: number; name: string }) {
  return message(new EmbedBuilder().setColor(Colors.success).setTitle(`🔐 Connected ${escapeMarkdown(account.name)}`)
    .setDescription('Your session is saved encrypted. Use **/trade**, review an offer, then click **Place Trade** to send it. Alert DMs carry a **Place Trade** button too.\n\n**/disconnect** removes the saved session. To revoke it on Roblox, log out that session in Roblox settings.'), row(nav.find()));
}
export function disconnectedMessage() {
  return message(new EmbedBuilder().setColor(Colors.success).setTitle('🔓 Roblox session removed')
    .setDescription('Recommendations and trade sending are disabled until you reconnect. Your public inventory settings remain. Trades already sent remain outbound on Roblox.'));
}
export function tradeSentMessage(tradeId: number) {
  return message(new EmbedBuilder().setColor(Colors.success).setTitle('📨 Outbound trade sent')
    .setDescription(`Trade **${tradeId}** was sent and is awaiting the other trader’s response.`),
    row(link('View outbound trades', 'https://www.roblox.com/trades#outbound', '📬')));
}
export function verificationMessage(verification: TradeVerificationRequired) {
  const r = verification.offer;
  const browser = link('Complete trade on Roblox', tradeUrl(r), '🔁');
  const description = verification.token
    ? `${verification.message}\n\nClick **Enter authenticator code** and use the current six-digit code from your authenticator app. Submitting it verifies and sends **this offer**. The code is not saved. This step expires in five minutes or when the search expires.`
    : `${verification.kind === 'captcha' ? 'Roblox requires a CAPTCHA' : verification.kind === 'reauthentication' ? 'Roblox requires you to sign in again' : 'Roblox requires verification in its browser interface'}. Open the trade below, complete Roblox’s prompts, and send the displayed items there.`;
  const embed = new EmbedBuilder().setColor(Colors.warning).setTitle('🔐 Verify this trade')
    .setDescription(description).addFields({ name: '📤 You give', value: names(r.give), inline: true }, { name: '📥 You get', value: names(r.receive), inline: true })
    .setFooter(footer(`Trade with ${r.ad.username} · 0 Robux · Never post verification codes in chat`));
  return { ...message(embed, row(...(verification.token ? [button(ids.build('verifymodal', verification.token), 'Enter authenticator code', ButtonStyle.Primary, '🔢')] : []), browser)), content: '' };
}
export function verificationModal(token: string) {
  return new ModalBuilder().setCustomId(ids.build('verify', token)).setTitle('🔐 Verify and send this trade').addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('code')
      .setLabel('Six-digit authenticator code').setStyle(TextInputStyle.Short).setMinLength(6).setMaxLength(6)
      .setPlaceholder('Submitting verifies and sends the displayed trade.').setRequired(true)));
}
/** Shown instead of an error when a command needs a linked account. The button opens the link form. */
export function linkRequiredMessage() {
  const embed = new EmbedBuilder().setColor(Colors.brand).setTitle('🔗 Link your Roblox account first')
    .addFields(
      { name: '1️⃣ Press the button', value: 'Tap **Link Roblox account** below.' },
      { name: '2️⃣ Fill in the form', value: 'Type your Roblox username or user ID. Adding wanted items is optional.' },
    )
    .setFooter(footer('Public tracking needs no cookie · Use /connect separately to authorize trade sending'));
  return message(embed, row(nav.link(), nav.help(), link('Make my inventory public', 'https://www.roblox.com/my/account#!/privacy', '🌐')));
}
// ---------- Errors ----------
export function errorMessage(text: string, expected = true): Pick<BaseMessageOptions, 'embeds' | 'components' | 'content'> {
  const embed = new EmbedBuilder().setColor(expected ? Colors.warning : Colors.danger)
    .setTitle(expected ? '⚠️ Can’t do that' : '❌ Something went wrong').setDescription(clip(text, LIMIT.description));
  return { content: '', embeds: [embed], components: [] };
}

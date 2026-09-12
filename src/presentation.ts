import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, escapeMarkdown, ModalBuilder, StringSelectMenuBuilder,
  TextInputBuilder, TextInputStyle, type BaseMessageOptions,
} from 'discord.js';
import { alertHourlyCap, defaults as defaultPreferences, effectiveValue, idSchema, modeSchema, UserError, type Item, type Mode, type Preferences, type UserProfile } from './domain.js';
import { downgradeWindow, upgradeWindow, type Evaluation, type PricedCopy, type Recommendation } from './engine.js';
import type { ArchiveStats, SearchResult } from './search.js';
import { formatRange, formatMixedRange, mixedRangeText, type Range } from './amounts.js';
import { PAGE_SIZE, type InventoryEntry, type InventoryView } from './inventory.js';
import type { InventoryChange } from './changes.js';
import type { TradeVerificationRequired } from './trading.js';

// ---------- Shared styling ----------
export const Colors = { brand: 0x5865f2, success: 0x57f287, warning: 0xfee75c, danger: 0xed4245, muted: 0x99aab5, dark: 0x2b2d31 } as const;
export const number = (n: number): string => n.toLocaleString('en-US', { maximumFractionDigits: 2 });
const signed = (n: number): string => `${n >= 0 ? '+' : ''}${number(n)}`;
const time = (ms: number) => `<t:${Math.floor(ms / 1000)}:R>`;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const DEMAND = ['Terrible', 'Low', 'Normal', 'High', 'Amazing'];
const demandLabel = (d: number) => DEMAND[d] ?? 'Unknown';
const MODE_ICON: Record<string, string> = { any: '🔀', both: '🔀', upgrade: '⬆️', downgrade: '⬇️', swap: '🔁' };
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
export const links = {
  profile: (id: number) => `https://www.roblox.com/users/${id}/profile`,
  trade: (id: number) => `https://www.roblox.com/users/${id}/trade`,
  /** Roblox ignores the hash, so the exact items ride along for a browser extension to pre-fill the trade window. */
  tradeWith: (id: number, give: number[], receive: number[]) => `https://www.roblox.com/users/${id}/trade#tradefinder?give=${give.join(',')}&get=${receive.join(',')}`,
  inventory: (id: number) => `https://www.roblox.com/users/${id}/inventory`,
  player: (id: number) => `https://www.rolimons.com/player/${id}`,
  item: (id: number) => `https://www.rolimons.com/item/${id}`,
};
const footer = (text: string) => ({ text: clip(text, 2048) });
/** Avatar URLs come from the Roblox thumbnails API and may be unavailable; embeds must still render without them. */
export type Avatar = string | null | undefined;
const author = (name: string, url: string | null, avatar: Avatar) => ({ name: clip(name, 256), ...(url ? { url } : {}), ...(avatar ? { iconURL: avatar } : {}) });
const withThumbnail = (embed: EmbedBuilder, avatar: Avatar) => (avatar ? embed.setThumbnail(avatar) : embed);
const message = (embed: EmbedBuilder, ...rows: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[]) => ({
  embeds: [embed], components: rows.filter(r => r.components.length), allowedMentions: { parse: [] as never[] },
});
export type Panel = ReturnType<typeof message>;

/**
 * Rolimons logo and old Robux icon as application emojis, set at startup; plain labels until then.
 * `rolimonsIcon` is the same logo as a plain image URL, for embed author lines, which cannot render emoji.
 */
export const statIcons = { value: 'V', rap: 'RAP', rolimonsIcon: '' };
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
  const b = new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(label).setURL(url);
  return emoji ? b.setEmoji(emoji) : b;
};
const button = (customId: string, label: string, style = ButtonStyle.Secondary, emoji?: string, disabled = false) => {
  const b = new ButtonBuilder().setCustomId(customId).setLabel(label).setStyle(style).setDisabled(disabled);
  return emoji ? b.setEmoji(emoji) : b;
};
const row = (...buttons: ButtonBuilder[]) => new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons.slice(0, 5));
const nav = {
  settings: () => button(ids.build('view', 'settings'), 'Settings', ButtonStyle.Secondary, '⚙️'),
  inventory: () => button(ids.build('view', 'inventory'), 'Inventory', ButtonStyle.Secondary, '🎒'),
  help: () => button(ids.build('view', 'help'), 'Help', ButtonStyle.Secondary, '❓'),
  find: () => button(ids.build('fq', 'show', '-', '-', 3), 'Find trades', ButtonStyle.Primary, '🔎'),
  items: () => button(ids.build('view', 'items'), 'Wanted items', ButtonStyle.Secondary, '⭐'),
  link: () => button(ids.build('linkmodal'), 'Link Roblox account', ButtonStyle.Primary, '🔗'),
  /** Both DM toggles read the same way: green while on, red while off; pressing flips the state. */
  alerts: (on: boolean) => on
    ? button(ids.build('alerts', 'off'), 'Trade alerts: on', ButtonStyle.Success, '🔔')
    : button(ids.build('alerts', 'on'), 'Trade alerts: off', ButtonStyle.Danger, '🔕'),
  inventoryAlerts: (on: boolean) => on
    ? button(ids.build('invalerts', 'off'), 'Inventory DMs: on', ButtonStyle.Success, '🎒')
    : button(ids.build('invalerts', 'on'), 'Inventory DMs: off', ButtonStyle.Danger, '🎒'),
  /** Opens the alerts panel rather than flipping anything: settings points here instead of carrying DM toggles of its own. */
  alertsPage: () => button(ids.build('view', 'alerts'), 'Alerts & DMs', ButtonStyle.Secondary, '🔔'),
};

const navButtons = nav;

// ---------- Trade rendering ----------
function itemLine(c: PricedCopy): string {
  const flags = [c.item.projected && '📈 projected', c.item.hyped && '🔥 hyped', c.item.rare && '💎 rare'].filter(Boolean).join(' · ');
  return `**[${escapeMarkdown(clip(c.item.name, 60))}](${links.item(c.assetId)})**\n`
    + `\`V ${number(effectiveValue(c.item))}${c.item.value === null ? ' (= RAP)' : ''}\` \`RAP ${number(c.item.rap)}\` · ${demandLabel(c.item.demand)} demand\n`
    + `ID ${c.assetId} · Copy ${c.userAssetId}${flags ? ` · ${flags}` : ''}`;
}
function side(copies: PricedCopy[]): string {
  const lines: string[] = [];
  for (const c of copies) {
    const next = [...lines, itemLine(c)].join('\n\n');
    if (next.length > 1000) { lines.push(`…and ${copies.length - lines.length} more`); break; }
    lines.push(itemLine(c));
  }
  return lines.join('\n\n').slice(0, 1024) || '—';
}
export function evaluationEmbed(r: Evaluation): EmbedBuilder {
  const gainIcon = r.valueGain > 0 ? '🟢' : r.valueGain < 0 ? '🔴' : '⚪';
  return new EmbedBuilder().setColor(r.passes ? Colors.success : Colors.warning)
    .setTitle(`${MODE_ICON[r.mode]} ${cap(r.mode)} · ${r.passes ? '✅ Meets your filters' : '⚠️ Outside your filters'}`)
    .addFields(
      { name: `📤 You give · ${r.give.length}`, value: side(r.give), inline: true },
      { name: `📥 You receive · ${r.receive.length}`, value: side(r.receive), inline: true },
      ...(r.passes ? [] : [{ name: '🚫 Why it fails', value: r.failures.map(f => `• ${f}`).join('\n').slice(0, 1024) }]),
      { name: `${gainIcon} Value`, value: `${number(r.receiving.value)} received − ${number(r.giving.value)} given\n= **${signed(r.valueGain)}** (${signed(r.valueGainPct)}%)`, inline: true },
      { name: '📊 RAP', value: `${number(r.receiving.rap)} received − ${number(r.giving.rap)} given\n= **${signed(r.rapGain)}** (${signed(r.rapGainPct)}%)`, inline: true },
      { name: '⚖️ Balance', value: `Your overpay **${number(r.overpayPct)}%**\nPartner loss **${number(r.partnerLossPct)}%**\nDemand ${number(r.giving.demand)} → ${number(r.receiving.demand)}`, inline: true },
      ...(r.warnings.length ? [{ name: '🔍 Before you send', value: r.warnings.map(w => `• ${w}`).join('\n').slice(0, 1024) }] : []),
    );
}
const MATCH = {
  exact: ['🎯', 'Exact advertised item exchange'],
  'requested-items': ['🤝', 'Counteroffer including an item the seller requested'],
  proposal: ['💡', 'Generated counteroffer; not an advertised agreement'],
} as const;
/** Buttons that let a user act on a specific exchange without retyping IDs. */
function exchangeActions(partnerId: number, give: PricedCopy[], receive: PricedCopy[], options: { alert?: boolean } = {}): ButtonBuilder[] {
  const recheck = ids.build('recheck', ids.encode(partnerId), ids.encodeList(give.map(c => c.assetId)), ids.encodeList(receive.map(c => c.assetId)));
  return [
    ...(recheck.length <= 100 ? [button(recheck, 'Re-check now', ButtonStyle.Primary, '🔄')] : []),
    ...(options.alert ? [button(ids.build('alerts', 'off'), 'Stop alerts', ButtonStyle.Danger, '🔕')] : []),
  ];
}
export function recommendationMessage(r: Recommendation, options: { alert?: boolean; avatar?: Avatar; adsScanned?: number } = {}) {
  const [icon, match] = MATCH[r.match];
  const embed = withThumbnail(evaluationEmbed(r), options.avatar)
    .setAuthor(author(`${r.ad.username} · Rolimons trade ad`, links.player(r.ad.userId), options.avatar))
    .setDescription(`${icon} **${match}**\nPosted ${time(r.ad.createdAt)} · Score **${number(r.score)}**`)
    .addFields(
      { name: '🕒 Checked', value: `Prices ${time(r.pricesAt)} · Your inventory ${time(r.ownInventoryAt)} · Theirs ${time(r.partnerInventoryAt)}` },
    )
    .setFooter(footer(`Ad #${r.ad.id}`))
    .setTimestamp(r.ad.createdAt);
  return message(embed,
    row(link('Open Roblox trade', links.tradeWith(r.ad.userId, r.give.map(c => c.assetId), r.receive.map(c => c.assetId)), '🔁'), link('Rolimons player', links.player(r.ad.userId), '📈')),
    row(...exchangeActions(r.ad.userId, r.give, r.receive, options)));
}
export function analysisMessage(r: Evaluation, partner: { id: number; name: string }, avatar?: Avatar) {
  const embed = withThumbnail(evaluationEmbed(r), avatar)
    .setAuthor(author(`Proposed exchange with ${partner.name}`, links.profile(partner.id), avatar))
    .setDescription('Checked against both live inventories and your filters.')
    .setTimestamp();
  return message(embed,
    row(link('Open Roblox trade', links.trade(partner.id), '🔁'), link('Rolimons player', links.player(partner.id), '📈')),
    row(...exchangeActions(partner.id, r.give, r.receive)));
}

// ---------- Search ----------
/** Up to MAX_TARGETS items can be searched for at once; the limit keeps custom IDs under Discord's 100 characters. */
export const MAX_TARGETS = 5;
export interface SearchQuery { mode: Mode | null; targetIds: number[]; results: number }
const targetNames = (targetIds: number[], items?: Map<number, Item>) => targetIds.map(id => escapeMarkdown(clip(items?.get(id)?.name ?? `Item ${id}`, 40)));
export function searchMessage(result: SearchResult, query: SearchQuery, items?: Map<number, Item>) {
  const n = result.recommendations.length;
  const names = targetNames(query.targetIds, items);
  const target = names.length ? names.join(', ') : null;
  const scanned = `Screened **${number(result.adsScanned)}** trade ads going back ${result.coverageMinutes} min` + (target
    ? `; **${number(result.adsOfferingTarget)}** offered ${target}` : '') + `; verified **${result.sellersChecked}** of ${result.candidateSellers} promising sellers.`;
  const embed = new EmbedBuilder().setColor(n ? Colors.success : Colors.muted)
    .setTitle(n ? `🔎 ${n} qualifying recommendation${n === 1 ? '' : 's'}` : '🔎 No qualifying recommendations')
    .setDescription(`${scanned}\n${n ? 'Each recommendation follows below, best score first.' : 'Nothing passed your filters. Try a different target or loosen them.'}`)
    .addFields(
      { name: names.length > 1 ? `🎯 Targets · ${names.length}` : '🎯 Target', value: (target ?? 'Watch list / any').slice(0, 1024), inline: true },
      { name: '📡 Ads screened', value: `${number(result.adsScanned)}${target ? `\n${number(result.adsOfferingTarget)} offering ${names.length > 1 ? 'a target' : 'target'}` : ''}`, inline: true },
      { name: '🧾 Sellers verified', value: `${result.sellersChecked} / ${result.candidateSellers}`, inline: true },
    )
    .setTimestamp(result.pricesAt);
  const state = queryState(query);
  return message(embed,
    row(button(ids.build('find', ...state), 'Search again', ButtonStyle.Primary, '🔁'), button(ids.build('fq', 'show', ...state), 'Change search', ButtonStyle.Secondary, '🎛️'),
      button(ids.build('sfiltersmodal', ...state), 'Filters', ButtonStyle.Secondary, '🎚️')));
}
// ---------- Trade list ----------
export type Bucket = 'gain' | 'even' | 'loss';
export const bucketOf = (r: Evaluation): Bucket => (r.valueGainPct > 1 ? 'gain' : r.valueGainPct >= -1 ? 'even' : 'loss');
const BUCKET = { gain: ['🟢', 'Slight gain'], even: ['🟰', 'Even'], loss: ['🟠', 'Slight loss'] } as const;
export interface SellerEntry { index: number; best: Recommendation; alternatives: number }
export const LIST_PAGE = 5;
/** One entry per seller (their best-scoring exchange), gains first, then even swaps, then small losses. */
export function groupBySeller(recommendations: Recommendation[]): SellerEntry[] {
  const bySeller = new Map<number, SellerEntry>();
  for (const r of recommendations) {
    const entry = bySeller.get(r.ad.userId);
    if (!entry) bySeller.set(r.ad.userId, { index: 0, best: r, alternatives: 0 });
    else entry.alternatives++;
  }
  // Recommendations arrive in the finder's own order (mode-aware), so the first exchange seen per seller is its best.
  return [...bySeller.values()].map((e, index) => ({ ...e, index }));
}
const names = (copies: PricedCopy[]) => {
  const counts = new Map<string, number>();
  for (const c of copies) counts.set(c.item.name, (counts.get(c.item.name) ?? 0) + 1);
  return [...counts].map(([name, n]) => `${escapeMarkdown(clip(name, 30))}${n > 1 ? ` ×${n}` : ''}`).join(', ');
};
/**
 * The finder's result: a paged list of people to trade with. Each row links straight to the Roblox trade window so the
 * user can enter the shown items and send the trade themselves; the select menu opens a full card for any row.
 */
const tradeUrl = (r: Recommendation) => links.tradeWith(r.ad.userId, r.give.map(c => c.assetId), r.receive.map(c => c.assetId));
const ALERT_LABEL = { gain: 'Value gain', even: 'Even swap', loss: 'Small loss' } as const;
/**
 * A recommendation DM in the trade finder's card style: the rendered trade-<n>.png carries the items and maths, the
 * embed carries the seller, the trade-window link and why it was sent. Without a card the two sides are listed as text.
 */
export function alertMessage(r: Recommendation, options: { card?: boolean; character?: Avatar } = {}) {
  const bucket = bucketOf(r); const [icon] = BUCKET[bucket];
  const embed = withThumbnail(new EmbedBuilder().setColor(bucket === 'gain' ? Colors.success : bucket === 'even' ? Colors.muted : Colors.warning), options.character)
    .setTitle(`🔔 ${icon} ${signed(r.valueGain)} value (${signed(r.valueGainPct)}%) · ${ALERT_LABEL[bucket]}`)
    .setDescription(`**${escapeMarkdown(clip(r.ad.username, 20))}** · [Profile](${links.profile(r.ad.userId)}) · [Rolimons](${links.player(r.ad.userId)}) · ad ${time(r.ad.createdAt)}\n🔁 [Open the trade window with ${escapeMarkdown(clip(r.ad.username, 20))}](${tradeUrl(r)})`)
    .setTimestamp(r.ad.createdAt);
  if (options.card) embed.setImage('attachment://trade-1.png');
  else embed.addFields({ name: '📤 You give', value: names(r.give) || '—', inline: true }, { name: '📥 You get', value: names(r.receive) || '—', inline: true });
  return message(embed,
    row(link(clip(`Trade with ${r.ad.username}`, 80), tradeUrl(r), '🔁')),
    row(button(ids.build('alerts', 'off'), 'Stop alerts', ButtonStyle.Danger, '🔕')));
}
export const listPage = (result: SearchResult, page: number) => {
  const entries = groupBySeller(result.recommendations);
  const pages = Math.max(1, Math.ceil(entries.length / LIST_PAGE));
  const current = Math.min(Math.max(0, page), pages - 1);
  return { entries, pages, current, shown: entries.slice(current * LIST_PAGE, current * LIST_PAGE + LIST_PAGE) };
};
/** `cards` holds one rendered PNG per shown entry (attached as trade-<n>.png); rows fall back to text when absent. */
export function tradeListMessage(result: SearchResult, query: SearchQuery, items?: Map<number, Item>, page = 0, cards = new Map<number, Buffer>(), characters = new Map<number, string>(), sendToken?: string) {
  const { entries, pages, current, shown } = listPage(result, page);
  const counts = { gain: 0, even: 0, loss: 0 };
  for (const e of entries) counts[bucketOf(e.best)]++;
  const mode = findMode(query);
  const targetList = targetNames(query.targetIds, items);
  const target = targetList.length ? targetList.join(', ') : 'your wanted items';
  const scanned = mode === 'upgrade'
    ? `Screened **${number(result.adsScanned)}** trade ads going back ${result.coverageMinutes} min; **${number(result.adsOfferingTarget)}** offered ${targetList.length ? target : 'a wanted item'}; verified **${result.sellersChecked}** of ${result.candidateSellers} promising sellers.`
    : mode === 'downgrade'
    ? `Screened **${number(result.adsScanned)}** trade ads going back ${result.coverageMinutes} min for bundles worth about +10% over ${target}; verified **${result.sellersChecked}** of ${result.candidateSellers} promising sellers.`
    : `Screened **${number(result.adsScanned)}** trade ads going back ${result.coverageMinutes} min for upgrades and downgrades${targetList.length ? ` involving ${target}` : ''}; verified **${result.sellersChecked}** of ${result.candidateSellers} promising sellers.`;
  const summary = mode === 'upgrade'
    ? `🟠 ${counts.loss} slight loss · 🟰 ${counts.even} even · 🟢 ${counts.gain} slight gain · slight losses first.`
    : mode === 'downgrade'
    ? `Closest to +10% first.`
    : `🟠 ${counts.loss} slight loss · 🟰 ${counts.even} even · 🟢 ${counts.gain} gain.`;
  const embed = new EmbedBuilder().setColor(entries.length ? Colors.success : Colors.muted)
    .setTitle(entries.length ? `${MODE_ICON[mode]} ${entries.length} ${entries.length === 1 ? 'person' : 'people'} you can trade with${mode === 'both' && !targetList.length ? '' : ` ${mode === 'downgrade' ? 'to downgrade' : 'for'} ${clip(target, 60)}`}` : `🔎 No sendable ${mode === 'both' ? 'trades' : `${mode}s`}${mode === 'both' && !targetList.length ? '' : ` for ${clip(target, 60)}`} right now`)
    .setDescription(`${scanned}\n${entries.length ? summary : 'Nothing your items can cover right now. Try other items or check back later.'}${sendToken && entries.length ? '\n**Place Trade** sends the numbered offer with 0 Robux. Available copies of those items are selected at send time. Connect first with /connect.' : ''}`.slice(0, 4000))
    .setFooter(footer(`Page ${current + 1}/${pages}`))
    .setTimestamp(result.pricesAt);
  // One card per seller, Rolimons-ad style: the rendered image carries the items; the embed carries the seller and links.
  const cardEmbeds = shown.map(e => {
    const r = e.best; const [icon, label] = BUCKET[bucketOf(r)];
    const character = characters.get(r.ad.userId);
    const card = withThumbnail(new EmbedBuilder().setColor(bucketOf(r) === 'gain' ? Colors.success : bucketOf(r) === 'even' ? Colors.muted : Colors.warning), character)
      .setTitle(`${e.index + 1}. ${icon} ${signed(r.valueGain)} value (${signed(r.valueGainPct)}%) · ${label}`)
      .setDescription(`**${escapeMarkdown(clip(r.ad.username, 20))}** · [Profile](${links.profile(r.ad.userId)}) · [Rolimons](${links.player(r.ad.userId)}) · ad ${time(r.ad.createdAt)}\n🔁 [Open the trade window with ${escapeMarkdown(clip(r.ad.username, 20))}](${tradeUrl(r)})`);
    if (cards.has(e.index)) card.setImage(`attachment://trade-${e.index + 1}.png`);
    else card.addFields({ name: '📤 You give', value: names(r.give) || '—', inline: true }, { name: '📥 You get', value: names(r.receive) || '—', inline: true });
    return card;
  });
  const state = queryState(query);
  const pager = (p: number, label: string, emoji: string, disabled: boolean) => button(ids.build('tl', p), label, ButtonStyle.Secondary, emoji, disabled);
  const openTrade = shown.length ? [row(...shown.map(e => link(clip(`${e.index + 1} · Trade with ${e.best.ad.username}`, 80), tradeUrl(e.best), '🔁')))] : [];
  const panel = message(embed,
    ...openTrade,
    ...(sendToken && shown.length ? [row(...shown.map(e => button(ids.build('place', sendToken, e.index), `${e.index + 1} · Place Trade`, ButtonStyle.Success)))] : []),
    ...(pages > 1 ? [row(pager(current - 1, 'Prev', '◀️', current === 0), button(ids.build('tl', current), `Page ${current + 1} / ${pages}`, ButtonStyle.Secondary, '📄', true), pager(current + 1, 'Next', '▶️', current >= pages - 1))] : []),
    row(button(ids.build('find', ...state), 'Search again', ButtonStyle.Primary, '🔁'), button(ids.build('fq', 'show', ...state), 'Change search', ButtonStyle.Secondary, '🎛️'),
      button(ids.build('sfiltersmodal', ...state), 'Filters', ButtonStyle.Secondary, '🎚️')));
  return { ...panel, embeds: [embed, ...cardEmbeds] };
}
export function expiredSearchMessage() {
  const embed = new EmbedBuilder().setColor(Colors.muted).setTitle('⌛ That search has expired')
    .setDescription('Results are kept for 15 minutes so prices and inventories stay fresh. Run the search again to get a current list.');
  return message(embed, row(nav.find()));
}
/** Serialises a search query into custom-ID parts: mode, comma-separated base-36 target IDs (or -), result count. */
export const queryState = (q: SearchQuery): [string, string, number] => [q.mode === 'any' ? 'both' : q.mode ?? '-', q.targetIds.length ? ids.encodeList(q.targetIds) : '-', q.results];
export function parseQuery(mode = '-', targets = '-', results = '3'): SearchQuery {
  return { mode: mode === '-' || mode === 'any' ? null : mode === 'both' ? 'any' : modeSchema.parse(mode), targetIds: targets === '-' ? [] : [...new Set(ids.decodeList(targets))].slice(0, MAX_TARGETS), results: Math.min(3, Math.max(1, Number(results) || 3)) };
}
/** The `/trade find` panel: choose mode, target and result count with clicks, then search. */
export type Coverage = ArchiveStats | undefined;
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
export type FindMode = 'upgrade' | 'downgrade' | 'both';
export const findMode = (q: SearchQuery): FindMode => (q.mode === 'downgrade' ? 'downgrade' : q.mode === 'upgrade' ? 'upgrade' : 'both');
/** The user's loss/gain window in words. An upgrade's loss is its overpay, which has a window of its own. */
export const lossGainText = (p: Preferences) => `${p.minValueGainPct < 0 ? `up to ${-p.minValueGainPct}% loss` : 'no loss'} on downgrades · upgrades use the overpay window · ${formatMixedRange(upgradeWindow(p))} overpay`;
/** What the receive-value filter currently means, for panels: off, the auto band, or a typed range. */
export function receiveRangeText(p: Preferences, auto?: Range | null): string {
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
  const giveName = giveChoices.find(c => c.id === query.targetIds[0])?.name ?? (query.targetIds[0] ? items?.get(query.targetIds[0])?.name ?? `Item ${query.targetIds[0]}` : null);
  const selection = pickTargets
    ? { name: names.length > 1 ? `🎯 I want · ${names.length}` : '🎯 I want', value: (names.length ? names.join(', ') : p.targetIds.length ? `Any of your ${p.targetIds.length} wanted items` : mode === 'both' ? 'Anything' : '*Pick or type an item*').slice(0, 1024) }
    : { name: '📤 I give', value: giveName ? escapeMarkdown(clip(giveName, 60)) : '*Pick one of your items*' };
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
      .addOptions({ label: 'Any item in your range', value: '-', emoji: '💸', description: clip(receiveRangeText(p, affordable), 100), default: !query.targetIds.length },
        ...choices.map(id => ({ label: clip(items?.get(id)?.name ?? `Item ${id}`, 100), value: ids.encode(id), emoji: p.targetIds.includes(id) ? '⭐' : '🎯', default: query.targetIds.includes(id) })));
  } else {
    const options = giveChoices.slice(0, 25).map(c => ({ label: clip(c.name, 100), value: ids.encode(c.id), description: `Value ${number(c.value)}`, emoji: '📤', default: query.targetIds[0] === c.id }));
    menu = new StringSelectMenuBuilder().setCustomId(ids.build('fq', 'give', mode, results)).setPlaceholder(options.length ? '📤 Choose the item to give away' : 'No available items to give')
      .addOptions(options.length ? options : [{ label: 'Nothing available', value: '-', description: 'Link an account with public, non-projected limiteds' }]).setDisabled(!options.length);
  }
  const ready = pickTargets || query.targetIds.length > 0;
  return message(embed, row(...modes),
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu),
    row(button(ids.build('find', mode, targetEnc, results), pickTargets ? 'Find trades' : 'Find bundles for my item', ButtonStyle.Success, '🚀', !ready), afford,
      button(ids.build('sfiltersmodal', mode, targetEnc, results), 'Filters', ButtonStyle.Secondary, '🎚️'),
      button(ids.build('targetmodal', mode, results, targetEnc), pickTargets ? 'Type items' : 'Type my item', ButtonStyle.Secondary, '✏️')));
}
/** One-line description of the gain filters, in both percentage and absolute terms. */
export function gainSummary(p: Preferences): string {
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
      new TextInputBuilder().setCustomId('item').setLabel(downgrade ? 'One item you own' : `Up to ${MAX_TARGETS} items, comma separated`).setStyle(TextInputStyle.Paragraph)
        .setPlaceholder('Full names, Rolimons acronyms (STF, Valk) or Roblox IDs · e.g. Valk, STF, 1029025').setMinLength(1).setMaxLength(400).setRequired(true)));
}

// ---------- Account panels ----------
function itemList(idsToShow: number[], items?: Map<number, Item>, empty = 'none'): string {
  if (!idsToShow.length) return `*${empty}*`;
  const lines = idsToShow.map(id => { const item = items?.get(id); return item ? `[${escapeMarkdown(clip(item.name, 40))}](${links.item(id)})` : `\`${id}\``; });
  let out = lines.join(' · ');
  if (out.length > 1000) out = `${lines.slice(0, 15).join(' · ')} · +${lines.length - 15} more`;
  return out.slice(0, 1024);
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
      { name: `🎯 Per-item rules · ${rules}`, value: rules ? Object.entries(p.itemRules).slice(0, 8).map(([id, r]) => `${escapeMarkdown(clip(items?.get(Number(id))?.name ?? `Item ${id}`, 30))} · ${formatRange(r, number)}`).join('\n').slice(0, 1024) : 'none · the profit range applies to every trade', inline: true },
    );
  return message(embed,
    row(button(ids.build('filtersmodal'), 'Edit profit / loss', ButtonStyle.Primary, '✏️'), button(ids.build('rulemodal'), 'Profit per item', ButtonStyle.Secondary, '🎯'), nav.find()));
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
      { name: `🎯 Profit rules · ${Object.keys(p.itemRules).length}`, value: Object.entries(p.itemRules).map(([id, r]) =>
        `[${escapeMarkdown(clip(items?.get(Number(id))?.name ?? `Item ${id}`, 40))}](${links.item(Number(id))}) · profit ${formatRange(r, number)}`).join('\n').slice(0, 1024)
        || '*none*' },
    )
  const option = (id: number, emoji: string) => ({ label: clip(items?.get(id)?.name ?? `Item ${id}`, 100), value: ids.encode(id), emoji, description: `ID ${id}` });
  const menu = (action: string, list: number[], placeholder: string, emoji: string) => list.length
    ? [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder().setCustomId(ids.build(action)).setPlaceholder(placeholder)
      .setMinValues(1).setMaxValues(Math.min(list.length, 24) + 1)
      .addOptions(...list.slice(0, 24).map(id => option(id, emoji)), { label: 'Clear the whole list', value: 'all', emoji: '🧹' }))]
    : [];
  return message(embed,
    row(button(ids.build('watchmodal'), 'Add wanted items', ButtonStyle.Success, '⭐'), button(ids.build('rulemodal'), 'Profit per item', ButtonStyle.Primary, '🎯'), nav.find()),
    ...menu('unwatch', p.targetIds, '➖ Remove wanted items (pick several)', '⭐'),
    ...menu('unrule', Object.keys(p.itemRules).map(Number), '🎯 Remove a profit rule', '🎯'));
}
/** Several items matched a typed name: let the user click the right one. `state` routes the pick back to the original action. */
export function pickItemMessage(query: string, matches: Item[], state: (string | number)[]) {
  const embed = new EmbedBuilder().setColor(Colors.warning).setTitle('🤔 Which item did you mean?')
    .setDescription(`**${matches.length}** items match \`${escapeMarkdown(clip(query, 40))}\`. Pick one below, or type the full name, its Rolimons acronym or the Roblox item ID.`)
    .addFields({ name: 'Matches', value: matches.slice(0, 10).map(i => `[${escapeMarkdown(clip(i.name, 40))}](${links.item(i.id)})${i.acronym ? ` · **${escapeMarkdown(i.acronym)}**` : ''} · \`${i.id}\``).join('\n').slice(0, 1024) });
  const menu = new StringSelectMenuBuilder().setCustomId(ids.build('pick', ...state)).setPlaceholder('🎯 Choose the item')
    .addOptions(matches.slice(0, 25).map(i => ({ label: clip(i.name, 100), value: ids.encode(i.id), description: clip(`${i.acronym ? `${i.acronym} · ` : ''}ID ${i.id} · V ${number(i.value ?? i.rap)}`, 100), emoji: '🎯' })));
  return message(embed, new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu), row(navButtons.items(), navButtons.find()));
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
      { name: 'Roblox ID', value: `\`${user.robloxId}\``, inline: true },
      { name: 'Max ad age', value: `${p.maxAdAgeMinutes} min`, inline: true },
      { name: '💸 Any item in your range', value: receiveRangeText(p), inline: true },
      { name: '💰 Trade profit', value: lossGainText(p), inline: false },
      { name: `⭐ Wanted · ${p.targetIds.length}`, value: itemList(p.targetIds, items, 'any item'), inline: true },
      { name: '📡 Trade ad archive', value: coverageLine(coverage), inline: false },
    );
  return message(embed, row(nav.find(), nav.items(), nav.inventory(), nav.alertsPage()));
}
/** How many trade DMs one alert check may send; offered next to the on/off toggle. */
export const ALERT_RATES = [1, 2, 3, 5, 8, 10] as const;
const RATE_EMOJI: Record<number, string> = { 1: '🐢', 2: '🚶', 3: '🔔', 5: '🏃', 8: '🔥', 10: '🚀' };
/** The gap between alert checks, in words; the monitor's poll interval decides it. */
const everyText = (scanSeconds: number) => (scanSeconds === 60 ? 'minute' : scanSeconds < 120 ? `${scanSeconds} seconds` : `${Math.round(scanSeconds / 60)} minutes`);
/** Most DMs an hour at this rate: the checks that fit in an hour, or the safety ceiling, whichever bites first. */
const perHour = (perScan: number, scanSeconds: number) => Math.min(perScan * Math.round(3600 / Math.max(1, scanSeconds)), alertHourlyCap(perScan));
export const alertRateText = (p: Preferences, scanSeconds = 60) =>
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
  if (user.alertError) embed.addFields({ name: '⚠️ Last alert issue', value: user.alertError.slice(0, 1024) });
  const rate = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder().setCustomId(ids.build('alertrate')).setPlaceholder('📨 How many trades per check')
      .addOptions(ALERT_RATES.map(n => ({
        label: `${n} trade${n === 1 ? '' : 's'} per check`, value: String(n), emoji: RATE_EMOJI[n]!,
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
  const counts = new Map<number, { id: number; name: string; n: number; value: number }>();
  for (const c of copies) { const e = counts.get(c.assetId); if (e) e.n++; else counts.set(c.assetId, { id: c.assetId, name: c.item.name, n: 1, value: effectiveValue(c.item) }); }
  return [...counts.values()].map(e => `[${escapeMarkdown(clip(e.name, 40))}](${links.item(e.id)})${e.n > 1 ? ` **×${e.n}**` : ''} · ${e.value > 0 ? `${statIcons.value} ${number(e.value)}` : 'no price'}`).join('\n').slice(0, 1024) || '—';
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
  if (c.unpriced) embed.addFields({ name: 'Note', value: `${c.unpriced} cop${c.unpriced === 1 ? 'y has' : 'ies have'} no known price and count as 0.` });
  embed.setTimestamp(options.checkedAt ?? Date.now());
  return message(embed, row(nav.inventory(), button(ids.build('invalerts', 'off'), 'Stop inventory DMs', ButtonStyle.Danger, '🔕'), link('Rolimons', links.player(user.robloxId), '📈')));
}
export function linkMessage(roblox: { id: number; name: string }, copies: number, avatar?: Avatar, note?: string) {
  const embed = withThumbnail(new EmbedBuilder().setColor(Colors.success), avatar)
    .setTitle(`✅ Tracking ${escapeMarkdown(roblox.name)}`)
    .setDescription(`Your public inventory is linked.${note ? `\n\n${note}` : ''}`)
    .addFields({ name: 'Roblox ID', value: `\`${roblox.id}\``, inline: true }, { name: 'Public copies', value: `${copies}`, inline: true })
  return message(embed, row(nav.find(), nav.inventory(), link('Rolimons', links.player(roblox.id), '📈')));
}
export interface InventoryPage { view: InventoryView; page: number; pages: number; entries: InventoryEntry[]; total: number; copies: number; value: number; rap: number; note?: string }
const TAG_EMOJI: Record<string, string> = { Tradable: '✅', 'Not tradable': '🚫', 'Tradability unknown': '❔', rare: '💎', projected: '📈', hyped: '🔥', unpriced: '❔', 'on hold': '⏳' };
const tagLabel = (tag: string) => `${TAG_EMOJI[tag] ?? (/^\d+\/\d+ tradable$/.test(tag) ? '✅' : TAG_EMOJI['on hold'])} ${tag}`;
/** Paged inventory: a rendered grid of item squares (attached as inventory.png) or a plain text list, with a toggle between them. */
export function inventoryMessage(user: UserProfile, inv: InventoryPage, avatar?: Avatar) {
  const grid = inv.view === 'grid';
  const first = inv.page * PAGE_SIZE[inv.view] + 1;
  const embed = withThumbnail(new EmbedBuilder().setColor(Colors.brand), avatar)
    .setAuthor(author(`${user.username}'s inventory`, null, avatar))
    .setTitle(`🎒 ${inv.total} item${inv.total === 1 ? '' : 's'} · ${inv.copies} cop${inv.copies === 1 ? 'y' : 'ies'}`)
    .addFields(
      { name: `${statIcons.value === 'V' ? '💰' : statIcons.value} Tradable value`, value: number(inv.value), inline: true },
      { name: `${statIcons.rap === 'RAP' ? '📊' : statIcons.rap} Tradable RAP`, value: number(inv.rap), inline: true },
    )
    .setTimestamp();
  if (inv.note) embed.setFooter({ text: inv.note });
  if (grid) { embed.setImage('attachment://inventory.png'); if (!inv.total) embed.setDescription('*No collectible items were found in this public inventory.*'); }
  else embed.setDescription(inv.entries.map((e, i) => {
    const name = `[${escapeMarkdown(clip(e.name, 40))}](${links.item(e.assetId)})${e.quantity > 1 ? ` **${e.quantity}x**` : ''}`;
    const price = e.value === null ? 'no price' : `${statIcons.value} ${number(e.value)} · ${statIcons.rap} ${number(e.rap ?? 0)}`;
    return `**${first + i}.** ${name} · ${price}${e.tags.length ? ` · ${e.tags.map(tagLabel).join(' ')}` : ''}`;
  }).join('\n').slice(0, 4000) || '*No collectible items were found in this public inventory.*');
  const nav = (page: number, label: string, emoji: string, disabled: boolean) => button(ids.build('inv', inv.view, page), label, ButtonStyle.Secondary, emoji, disabled);
  return message(embed,
    row(nav(inv.page - 1, 'Prev', '◀️', inv.page === 0), nav(inv.page + 1, 'Next', '▶️', inv.page >= inv.pages - 1),
      button(ids.build('inv', grid ? 'text' : 'grid', 0), grid ? 'Text view' : 'Grid view', ButtonStyle.Primary, grid ? '📝' : '🖼️')),
    row(link('Rolimons', links.player(user.robloxId), '📈')));
}
export function deletedMessage() {
  const embed = new EmbedBuilder().setColor(Colors.muted).setTitle('🗑️ Your data was deleted')
    .setDescription('Tracked account, saved session, preferences and alert history are gone. Alerts and bot trade sending are off.\nYou can link an account again at any time.');
  return message(embed, row(nav.link(), nav.help()));
}

// ---------- Help ----------
export function helpMessage() {
  const embed = new EmbedBuilder().setColor(Colors.brand).setTitle('👋 Tradefinder')
    .setDescription('Finds Roblox limited-item trades from recent Rolimons trade ads and checks both inventories. Use /connect to verify tradable items and enable recommendations. Click Place Trade to send a reviewed offer.')
    .addFields(
      { name: '1️⃣ Link', value: '🔗 `/connect` connects your Roblox session for inventory verification and sending. `/trade link` tracks a public inventory without sending access. `/disconnect` removes the saved session.', inline: false },
      { name: '2️⃣ Set up', value: '⚙️ `/trade settings` — your account, filters and lists · 💰 `/trade profit` — how much profit or loss you will take.', inline: false },
      { name: '3️⃣ Search', value: '🔎 `/find trades` or `/trade find` — pick a mode and target, then press Find trades. Review an offer and click its numbered Place Trade button to send it.', inline: false },
      { name: '4️⃣ Wanted items', value: '⭐ `/trade watch` saves the items you want to receive and per-item profit rules.', inline: false },
      { name: '5️⃣ Alerts', value: '🔔 `/trade alerts` — recommendation DMs and how many per check · 🎒 Inventory DMs recap every trade, sale or purchase.', inline: false },
      { name: 'More', value: '🎒 `/trade inventory` shows your items · 🗑️ `/trade delete` deletes your data.', inline: false },
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
  return new ModalBuilder().setCustomId(ids.build('connect')).setTitle('Connect Roblox for trade sending').addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('cookie')
      .setLabel('.ROBLOSECURITY (full account access)').setStyle(TextInputStyle.Paragraph)
      .setPlaceholder('Trust this bot first. Discord and the bot receive this cookie. Never paste it in chat.')
      .setRequired(true).setMaxLength(4000)));
}
export function connectedMessage(account: { id: number; name: string }) {
  return message(new EmbedBuilder().setColor(Colors.success).setTitle(`Connected ${escapeMarkdown(account.name)}`)
    .setDescription('Your session is saved encrypted. Use **/find trades**, review an offer, then click **Place Trade** to send it.\n\n**/disconnect** removes the saved session. To revoke it on Roblox, log out that session in Roblox settings.'), row(nav.find()));
}
export function disconnectedMessage() {
  return message(new EmbedBuilder().setColor(Colors.success).setTitle('Roblox session removed')
    .setDescription('Recommendations and trade sending are disabled until you reconnect. Your public inventory settings remain. Trades already sent remain outbound on Roblox.'));
}
export function tradeSentMessage(tradeId: number) {
  return message(new EmbedBuilder().setColor(Colors.success).setTitle('Outbound trade sent')
    .setDescription(`Trade **${tradeId}** was sent and is awaiting the other trader’s response.`),
    row(link('View outbound trades', 'https://www.roblox.com/trades#outbound')));
}
export function verificationMessage(verification: TradeVerificationRequired) {
  const r = verification.offer;
  const browser = link('Complete trade on Roblox', tradeUrl(r));
  const description = verification.token
    ? `${verification.message}\n\nClick **Enter authenticator code** and use the current six-digit code from your authenticator app. Submitting it verifies and sends **this offer**. The code is not saved. This step expires in five minutes or when the search expires.`
    : `${verification.kind === 'captcha' ? 'Roblox requires a CAPTCHA' : verification.kind === 'reauthentication' ? 'Roblox requires you to sign in again' : 'Roblox requires verification in its browser interface'}. Open the trade below, complete Roblox’s prompts, and send the displayed items there.`;
  const embed = new EmbedBuilder().setColor(Colors.warning).setTitle('Verify this trade')
    .setDescription(description).addFields({ name: 'You give', value: names(r.give) || '—', inline: true }, { name: 'You receive', value: names(r.receive) || '—', inline: true })
    .setFooter(footer(`Trade with ${r.ad.username} · 0 Robux · Never post verification codes in chat`));
  return { ...message(embed, row(...(verification.token ? [button(ids.build('verifymodal', verification.token), 'Enter authenticator code', ButtonStyle.Primary)] : []), browser)), content: '' };
}
export function verificationModal(token: string) {
  return new ModalBuilder().setCustomId(ids.build('verify', token)).setTitle('Verify and send this trade').addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('code')
      .setLabel('Six-digit authenticator code').setStyle(TextInputStyle.Short).setMinLength(6).setMaxLength(6)
      .setPlaceholder('Submitting verifies and sends the displayed trade.').setRequired(true)));
}
/** Shown instead of an error when a command needs a linked account. The button opens the link form. */
export function linkRequiredMessage() {
  const embed = new EmbedBuilder().setColor(Colors.brand).setTitle('🔗 Link your Roblox account first')
    .addFields(
      { name: '1️⃣ Press the button', value: 'Tap **Link Roblox account** below.', inline: false },
      { name: '2️⃣ Fill in the form', value: 'Type your Roblox username or user ID. Adding wanted items is optional.', inline: false },
    )
    .setFooter(footer('Public tracking needs no cookie · Use /connect separately to authorize trade sending'));
  return message(embed, row(nav.link(), nav.help(), link('Make my inventory public', 'https://www.roblox.com/my/account#!/privacy', '🌐')));
}
// ---------- Errors ----------
export function errorMessage(text: string, expected = true): Pick<BaseMessageOptions, 'embeds' | 'components' | 'content'> {
  const embed = new EmbedBuilder().setColor(expected ? Colors.warning : Colors.danger)
    .setTitle(expected ? '⚠️ Can’t do that' : '❌ Something went wrong').setDescription(text.slice(0, 4000));
  return { content: '', embeds: [embed], components: [] };
}

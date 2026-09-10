import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, escapeMarkdown, ModalBuilder, StringSelectMenuBuilder,
  TextInputBuilder, TextInputStyle, type BaseMessageOptions,
} from 'discord.js';
import { effectiveValue, idSchema, UserError, type Item, type Mode, type UserProfile } from './domain.js';
import { type Evaluation, type PricedCopy, type Recommendation } from './engine.js';
import type { SearchResult } from './search.js';

// ---------- Shared styling ----------
export const Colors = { brand: 0x5865f2, success: 0x57f287, warning: 0xfee75c, danger: 0xed4245, muted: 0x99aab5, dark: 0x2b2d31 } as const;
export const number = (n: number): string => n.toLocaleString('en-US', { maximumFractionDigits: 2 });
const signed = (n: number): string => `${n >= 0 ? '+' : ''}${number(n)}`;
const time = (ms: number) => `<t:${Math.floor(ms / 1000)}:R>`;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const DEMAND = ['Terrible', 'Low', 'Normal', 'High', 'Amazing'];
const demandLabel = (d: number) => DEMAND[d] ?? 'Unknown';
const MODE_ICON: Record<string, string> = { any: '🔀', upgrade: '⬆️', downgrade: '⬇️', swap: '🔁' };
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
export const links = {
  profile: (id: number) => `https://www.roblox.com/users/${id}/profile`,
  trade: (id: number) => `https://www.roblox.com/users/${id}/trade`,
  inventory: (id: number) => `https://www.roblox.com/users/${id}/inventory`,
  player: (id: number) => `https://www.rolimons.com/player/${id}`,
  item: (id: number) => `https://www.rolimons.com/item/${id}`,
  ads: 'https://www.rolimons.com/trades',
};
const footer = (text: string) => ({ text: clip(text, 2048) });
/** Avatar URLs come from the Roblox thumbnails API and may be unavailable; embeds must still render without them. */
export type Avatar = string | null | undefined;
const author = (name: string, url: string, avatar: Avatar) => ({ name: clip(name, 256), url, ...(avatar ? { iconURL: avatar } : {}) });
const withThumbnail = (embed: EmbedBuilder, avatar: Avatar) => (avatar ? embed.setThumbnail(avatar) : embed);
const message = (embed: EmbedBuilder, ...rows: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[]) => ({
  embeds: [embed], components: rows.filter(r => r.components.length), allowedMentions: { parse: [] as never[] },
});
export type Panel = ReturnType<typeof message>;

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
  status: () => button(ids.build('view', 'status'), 'Status', ButtonStyle.Secondary, '📊'),
  inventory: () => button(ids.build('view', 'inventory'), 'Inventory', ButtonStyle.Secondary, '🎒'),
  help: () => button(ids.build('view', 'help'), 'Help', ButtonStyle.Secondary, '❓'),
  link: () => button(ids.build('linkmodal'), 'Link Roblox account', ButtonStyle.Primary, '🔗'),
  alerts: (on: boolean) => on
    ? button(ids.build('alerts', 'off'), 'Turn alerts off', ButtonStyle.Secondary, '🔕')
    : button(ids.build('alerts', 'on'), 'Turn alerts on', ButtonStyle.Success, '🔔'),
};

// ---------- Trade rendering ----------
function itemLine(c: PricedCopy): string {
  const flags = [c.item.projected && '📈 projected', c.item.hyped && '🔥 hyped', c.item.rare && '💎 rare'].filter(Boolean).join(' · ');
  return `**[${escapeMarkdown(clip(c.item.name, 60))}](${links.item(c.assetId)})**\n`
    + `\`V ${number(effectiveValue(c.item))}${c.item.value === null ? '*' : ''}\` \`RAP ${number(c.item.rap)}\` · ${demandLabel(c.item.demand)} demand\n`
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
      { name: r.passes ? '🧠 Why it ranks' : '🚫 Why it fails', value: (r.passes
        ? `Meets the configured gain, overpay, mode, target and risk filters.\nHeuristic score **${number(r.score)}** — a ranking aid, not an acceptance probability or profit forecast.`
        : r.failures.map(f => `• ${f}`).join('\n')).slice(0, 1024) },
      { name: `${gainIcon} Value`, value: `${number(r.receiving.value)} received − ${number(r.giving.value)} given\n= **${signed(r.valueGain)}** (${signed(r.valueGainPct)}%)`, inline: true },
      { name: '📊 RAP', value: `${number(r.receiving.rap)} received − ${number(r.giving.rap)} given\n= **${signed(r.rapGain)}** (${signed(r.rapGainPct)}%)`, inline: true },
      { name: '⚖️ Balance', value: `Your overpay **${number(r.overpayPct)}%**\nPartner loss **${number(r.partnerLossPct)}%**\nDemand ${number(r.giving.demand)} → ${number(r.receiving.demand)}`, inline: true },
      { name: '🔍 Before you send', value: [...r.warnings.map(w => `• ${w}`), '• Recheck prices, ownership, holds, Premium and trade permissions in Roblox.', ...([...r.give, ...r.receive].some(c => c.item.value === null) ? ['• \\* Unvalued items use RAP as effective value.'] : [])].join('\n').slice(0, 1024) },
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
  const lock = ids.build('lock', ids.encodeList([...new Set(give.map(c => c.assetId))]));
  return [
    ...(recheck.length <= 100 ? [button(recheck, 'Re-check now', ButtonStyle.Primary, '🔄')] : []),
    ...(lock.length <= 100 ? [button(lock, 'Never offer these', ButtonStyle.Secondary, '🔒')] : []),
    ...(options.alert ? [button(ids.build('alerts', 'off'), 'Stop alerts', ButtonStyle.Danger, '🔕')] : []),
  ];
}
export function recommendationMessage(r: Recommendation, options: { alert?: boolean; avatar?: Avatar } = {}) {
  const [icon, match] = MATCH[r.match];
  const embed = withThumbnail(evaluationEmbed(r), options.avatar)
    .setAuthor(author(`${r.ad.username} · Rolimons trade ad`, links.player(r.ad.userId), options.avatar))
    .setDescription(`${icon} **${match}**\nPosted ${time(r.ad.createdAt)} · Score **${number(r.score)}**${options.alert ? '\n🔔 Sent because it matches your saved alert filters.' : ''}`)
    .addFields(
      { name: '🕒 Snapshots', value: `Prices ${time(r.pricesAt)} · Your inventory ${time(r.ownInventoryAt)} · Their inventory ${time(r.partnerInventoryAt)}` },
      { name: '📬 How to send', value: 'Open the Roblox trade window, pick the exact copies shown above, review the final totals, then send it yourself. If the trade page is unavailable, open their profile and use its Trade Items menu.' },
    )
    .setFooter(footer(`Ad #${r.ad.id} · Item-only proposal · Score is a ranking heuristic`))
    .setTimestamp(r.ad.createdAt);
  return message(embed,
    row(link('Open Roblox trade', links.trade(r.ad.userId), '🔁'), link('Roblox profile', links.profile(r.ad.userId), '👤'), link('Rolimons player', links.player(r.ad.userId), '📈')),
    row(...exchangeActions(r.ad.userId, r.give, r.receive, options)));
}
export function analysisMessage(r: Evaluation, partner: { id: number; name: string }, avatar?: Avatar) {
  const embed = withThumbnail(evaluationEmbed(r), avatar)
    .setAuthor(author(`Proposed exchange with ${partner.name}`, links.profile(partner.id), avatar))
    .setDescription('Both public inventories were checked and your saved filters were applied.')
    .setFooter(footer('Recheck at trade time · Inventories are cached for 60 seconds'))
    .setTimestamp();
  return message(embed,
    row(link('Open Roblox trade', links.trade(partner.id), '🔁'), link('Roblox profile', links.profile(partner.id), '👤'), link('Rolimons player', links.player(partner.id), '📈')),
    row(...exchangeActions(partner.id, r.give, r.receive), nav.settings()));
}

// ---------- Search ----------
export interface SearchQuery { mode: Mode | null; targetId: number | null; results: number }
export function searchMessage(result: SearchResult, query: SearchQuery, targetName?: string) {
  const n = result.recommendations.length;
  const embed = new EmbedBuilder().setColor(n ? Colors.success : Colors.muted)
    .setTitle(n ? `🔎 ${n} qualifying recommendation${n === 1 ? '' : 's'}` : '🔎 No qualifying recommendations')
    .setDescription(n ? `Each recommendation follows below. Best score first.` : 'Nothing passed your filters right now. A missing result does not mean the item has no owners — try a different target or loosen your filters.')
    .addFields(
      { name: '🎯 Target', value: targetName ? clip(escapeMarkdown(targetName), 100) : query.targetId ? `Item ${query.targetId}` : 'Watch list / any', inline: true },
      { name: '📡 Ads screened', value: `${result.adsScanned}`, inline: true },
      { name: '🧾 Sellers verified', value: `${result.sellersChecked} / ${result.candidateSellers}`, inline: true },
    )
    .setFooter(footer('Discovery covers the recent-ad feed only · Bundle search is bounded and may miss combinations'))
    .setTimestamp(result.pricesAt);
  const notes = [
    result.skippedSellers ? `⚠️ ${result.skippedSellers} seller inventor${result.skippedSellers === 1 ? 'y' : 'ies'} could not be read.` : '',
    result.truncatedInventory ? 'ℹ️ Large inventory: generated bundles use a 28-copy sample; exact requested bundles still use your full inventory.' : '',
    ...result.notes.map(note => `ℹ️ ${note}`),
  ].filter(Boolean);
  if (notes.length) embed.addFields({ name: 'Notes', value: notes.join('\n').slice(0, 1024) });
  const again = ids.build('find', query.mode ?? '-', query.targetId ? ids.encode(query.targetId) : '-', query.results);
  return message(embed,
    row(button(again, 'Search again', ButtonStyle.Primary, '🔁'), nav.settings(), link('Rolimons trade ads', links.ads, '🌐')));
}

// ---------- Account panels ----------
function itemList(idsToShow: number[], items?: Map<number, Item>, empty = 'none'): string {
  if (!idsToShow.length) return `*${empty}*`;
  const lines = idsToShow.map(id => { const item = items?.get(id); return item ? `[${escapeMarkdown(clip(item.name, 40))}](${links.item(id)})` : `\`${id}\``; });
  let out = lines.join(' · ');
  if (out.length > 1000) out = `${lines.slice(0, 15).join(' · ')} · +${lines.length - 15} more`;
  return out.slice(0, 1024);
}
export function settingsMessage(user: UserProfile, items?: Map<number, Item>, note?: string) {
  const p = user.preferences;
  const embed = new EmbedBuilder().setColor(Colors.brand).setTitle('⚙️ Trade filters')
    .setDescription(`${note ? `${note}\n\n` : ''}All filters apply together. Percentages are relative to your given totals; overpay uses received value.`)
    .addFields(
      { name: 'Mode', value: `${MODE_ICON[p.mode]} ${cap(p.mode)}`, inline: true },
      { name: 'Min value gain', value: `${p.minValueGainPct}%`, inline: true },
      { name: 'Min RAP gain', value: `${p.minRapGainPct}%`, inline: true },
      { name: 'Max overpay', value: `${p.maxOverpayPct}%`, inline: true },
      { name: 'Max partner loss', value: `${p.maxPartnerLossPct}%`, inline: true },
      { name: 'Min demand', value: p.minDemand < 0 ? 'Any (unknown allowed)' : `${p.minDemand} · ${demandLabel(p.minDemand)}`, inline: true },
      { name: 'Max RAP / value', value: `${p.maxRapValueRatio}`, inline: true },
      { name: 'Projected items', value: p.excludeProjected ? '🚫 Excluded' : '✅ Allowed', inline: true },
      { name: 'Max ad age', value: `${p.maxAdAgeMinutes} min`, inline: true },
      { name: `⭐ Wanted items · ${p.targetIds.length}/20`, value: itemList(p.targetIds, items, 'any item') },
      { name: `🔒 Locked items · ${p.lockedIds.length}/100`, value: itemList(p.lockedIds, items) },
    )
    .setFooter(footer('Numbers: /trade settings · Lists: /trade watch, /trade lock · Lower min value gain to permit overpay'));
  const modes = (['any', 'upgrade', 'downgrade'] as const).map(m =>
    button(ids.build('mode', m), cap(m), p.mode === m ? ButtonStyle.Primary : ButtonStyle.Secondary, MODE_ICON[m], p.mode === m));
  const demand = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder().setCustomId(ids.build('demand')).setPlaceholder('Minimum incoming demand')
      .addOptions({ label: 'Any demand (unknown allowed)', value: '-1', emoji: '🔀', default: p.minDemand === -1 },
        ...DEMAND.map((label, i) => ({ label: `${i} · ${label} or better`, value: String(i), default: p.minDemand === i }))));
  return message(embed, row(...modes),
    row(button(ids.build('projected'), p.excludeProjected ? 'Allow projected' : 'Exclude projected', ButtonStyle.Secondary, p.excludeProjected ? '✅' : '🚫'), nav.alerts(user.alerts), nav.status(), nav.inventory()),
    demand);
}
export function statusMessage(user: UserProfile, items?: Map<number, Item>, avatar?: Avatar) {
  const p = user.preferences;
  const embed = withThumbnail(new EmbedBuilder().setColor(user.alerts ? Colors.success : Colors.brand), avatar)
    .setAuthor(author(user.username, links.profile(user.robloxId), avatar))
    .setTitle('📊 Tradefinder status')
    .addFields(
      { name: 'Roblox ID', value: `\`${user.robloxId}\``, inline: true },
      { name: 'Alerts', value: user.alerts ? '🔔 On' : '🔕 Off', inline: true },
      { name: 'Mode', value: `${MODE_ICON[p.mode]} ${cap(p.mode)}`, inline: true },
      { name: 'Gain filters', value: `Value ≥ ${p.minValueGainPct}% · RAP ≥ ${p.minRapGainPct}%\nOverpay ≤ ${p.maxOverpayPct}% · Partner loss ≤ ${p.maxPartnerLossPct}%`, inline: false },
      { name: `⭐ Wanted · ${p.targetIds.length}`, value: itemList(p.targetIds, items, 'any item'), inline: true },
      { name: `🔒 Locked · ${p.lockedIds.length}`, value: itemList(p.lockedIds, items), inline: true },
    )
    .setFooter(footer('Tracks public inventory data only · Not ownership verification'));
  if (user.alertError) embed.addFields({ name: '⚠️ Last alert issue', value: user.alertError.slice(0, 1024) });
  return message(embed,
    row(nav.alerts(user.alerts), nav.settings(), nav.inventory(), link('Roblox profile', links.profile(user.robloxId), '👤'), link('Rolimons', links.player(user.robloxId), '📈')));
}
export function alertsMessage(user: UserProfile) {
  const embed = new EmbedBuilder().setColor(user.alerts ? Colors.success : Colors.muted)
    .setTitle(user.alerts ? '🔔 Alerts on' : '🔕 Alerts off')
    .setDescription(user.alerts
      ? 'You will get a DM for up to two new recommendations per scan that match your saved mode, wanted items, locks and filters.\nAllow DMs from this bot. Each partner/bundle is sent at most once per 24 hours.'
      : 'Recommendation DMs are disabled. Manual `/trade find` searches still work.')
    .setFooter(footer('Scans run about every 3 minutes · Check delivery errors in Status'));
  return message(embed, row(nav.alerts(user.alerts), nav.status(), nav.settings()));
}
export function linkMessage(roblox: { id: number; name: string }, copies: number, avatar?: Avatar) {
  const embed = withThumbnail(new EmbedBuilder().setColor(Colors.success), avatar)
    .setTitle(`✅ Tracking ${escapeMarkdown(roblox.name)}`)
    .setDescription('Your public collectible inventory is linked. Next, set your filters or run a search with `/trade find`.')
    .addFields({ name: 'Roblox ID', value: `\`${roblox.id}\``, inline: true }, { name: 'Public copies', value: `${copies}`, inline: true })
    .setFooter(footer('Tracks public data only · Not ownership verification · No password or cookie is used'));
  return message(embed, row(nav.settings(), nav.inventory(), link('Roblox profile', links.profile(roblox.id), '👤'), link('Rolimons', links.player(roblox.id), '📈')));
}
export function inventoryMessage(user: UserProfile, stats: { copies: number; available: PricedCopy[]; value: number; rap: number }, avatar?: Avatar) {
  const top = [...stats.available].sort((a, b) => effectiveValue(b.item) - effectiveValue(a.item)).slice(0, 10)
    .map((c, i) => `**${i + 1}.** [${escapeMarkdown(clip(c.item.name, 40))}](${links.item(c.assetId)}) · V ${number(effectiveValue(c.item))}${c.item.value === null ? '*' : ''} · RAP ${number(c.item.rap)}`);
  const embed = withThumbnail(new EmbedBuilder().setColor(Colors.brand), avatar)
    .setAuthor(author(`${user.username}'s inventory`, links.inventory(user.robloxId), avatar))
    .addFields(
      { name: '📦 Copies', value: `${stats.copies}`, inline: true },
      { name: '✅ Available', value: `${stats.available.length}`, inline: true },
      { name: '💰 Available totals', value: `Value **${number(stats.value)}** · RAP **${number(stats.rap)}**` },
      { name: '🏆 Top available items', value: top.join('\n').slice(0, 1024) || '*None*' },
    )
    .setFooter(footer('Held, locked and unpriced items are excluded from available totals · Full inventory CSV attached · * = RAP used as value'))
    .setTimestamp();
  return message(embed, row(nav.settings(), nav.status(), link('Roblox inventory', links.inventory(user.robloxId), '🎒'), link('Rolimons', links.player(user.robloxId), '📈')));
}
export function forgetMessage() {
  const embed = new EmbedBuilder().setColor(Colors.muted).setTitle('🗑️ Your data was deleted')
    .setDescription('Tracked account, preferences and alert history are gone. Alerts are off.\nYou can link an account again at any time.');
  return message(embed, row(nav.link(), nav.help()));
}

// ---------- Help ----------
export function helpMessage() {
  const embed = new EmbedBuilder().setColor(Colors.brand).setTitle('👋 Tradefinder')
    .setDescription('Finds Roblox limited-item exchanges from recent Rolimons trade ads, verifies both public inventories, and shows the maths so you can review and send the trade yourself.')
    .addFields(
      { name: '1️⃣ Link', value: '`/trade link user:<name>` tracks your public inventory.', inline: false },
      { name: '2️⃣ Filter', value: '`/trade settings` sets gain, overpay and risk limits. Use the buttons to switch mode or demand.', inline: false },
      { name: '3️⃣ Search', value: '`/trade find mode:upgrade target:<item>` builds offers. `downgrade` receives more items.', inline: false },
      { name: '4️⃣ Watch & lock', value: '`/trade watch` saves wanted items · `/trade lock` protects items you keep.', inline: false },
      { name: '5️⃣ Alerts', value: '`/trade alerts enabled:true` opts into recommendation DMs.', inline: false },
      { name: 'More', value: '`/trade analyze` checks one exchange · `/trade inventory` exports a CSV · `/trade forget` deletes your data.', inline: false },
    )
    .setFooter(footer('The bot never submits trades or messages counterparties · Ranking is a transparent heuristic, not a forecast'));
  return message(embed, row(nav.link(), button(ids.build('view', 'calc'), 'How it is calculated', ButtonStyle.Secondary, '📐'), nav.status(), link('Rolimons trade ads', links.ads, '🌐')));
}
export function calcMessage() {
  const embed = new EmbedBuilder().setColor(Colors.brand).setTitle('📐 How recommendations are calculated')
    .setDescription('**Effective value** is the assigned Rolimons value, or RAP when no value is assigned (marked `*`).')
    .addFields(
      { name: 'Formulas', value: '```\nValue gain   = received value − given value\nValue gain % = value gain / given value × 100\nRAP gain %   = (received RAP − given RAP) / given RAP × 100\nOverpay %    = max(0, given − received) / received × 100\nPartner loss = max(0, received − given) / received × 100\n```' },
      { name: 'Ranking score', value: '```\n0.65 × value gain % + 0.35 × RAP gain %\n+ 2 × (incoming demand − outgoing demand)\n+ (incoming trend − outgoing trend)\n+ match bonus − risk penalties\n```\nMatch bonus: exact ad 8 · requested item 3. Penalties per incoming copy: projected 25 · hyped 5 · rare 3.' },
      { name: 'Filters', value: 'All filters apply together. To permit a modest overpay for an upgrade, lower `min_value_gain` as well as raising `max_overpay`.' },
    )
    .setFooter(footer('Not an acceptance probability, price forecast or expected profit'));
  return message(embed, row(button(ids.build('view', 'help'), 'Back to help', ButtonStyle.Secondary, '◀️'), nav.settings()));
}
export function linkModal() {
  return new ModalBuilder().setCustomId(ids.build('link')).setTitle('Link your Roblox account').addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId('user').setLabel('Roblox username or numeric user ID').setStyle(TextInputStyle.Short)
        .setPlaceholder('e.g. builderman or 156').setMinLength(1).setMaxLength(20).setRequired(true)));
}

// ---------- Errors ----------
export function errorMessage(text: string, expected = true): Pick<BaseMessageOptions, 'embeds' | 'components' | 'content'> {
  const embed = new EmbedBuilder().setColor(expected ? Colors.warning : Colors.danger)
    .setTitle(expected ? '⚠️ Can’t do that' : '❌ Something went wrong').setDescription(text.slice(0, 4000));
  return { content: '', embeds: [embed], components: [] };
}

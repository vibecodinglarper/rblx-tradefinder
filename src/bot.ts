import {
  AttachmentBuilder, MessageFlags, type AutocompleteInteraction, type ChatInputCommandInteraction,
  type MessageComponentInteraction, type ModalBuilder, type ModalSubmitInteraction,
} from 'discord.js';
import { effectiveValue, NotLinkedError, parseId, parsePreferences, UserError, visibleHoldings, type Item, type UserProfile } from './domain.js';
import { affordableRange, evaluate, priced, REALISTIC_GAIN_PCT, selectCopies, totals, type Recommendation } from './engine.js';
import { groupInventory, paginate, PAGE_SIZE, type InventoryView } from './inventory.js';
import { renderInventoryGrid, renderTradeCard } from './render.js';
import { AmbiguousItemError, resolveItem } from './providers.js';
import { formatMixedRange, formatRange, parseMixedRange, parseRange, type Range } from './amounts.js';
import {
  alertsMessage, analysisMessage, deleteConfirmMessage, deletedMessage, errorMessage, filtersModal, findPanel, helpMessage,
  ids, inventoryAlertsMessage, inventoryMessage, itemModal, rangeModal, itemRuleModal, itemsPanel, linkMessage, linkModal, linkRequiredMessage, MAX_TARGETS, parseQuery, pickItemMessage, queryState,
  profitMessage, searchFiltersModal, settingsMessage, targetModal, tradeListMessage, expiredSearchMessage, listPage, bucketOf, findMode,
  type GiveChoice, type SearchQuery,
} from './presentation.js';
import type { SearchResult, SearchService } from './search.js';
import type { Store } from './store.js';
import { randomBytes } from 'node:crypto';
import { TradingService, TradeVerificationRequired } from './trading.js';
import { connectModal, connectedMessage, disconnectedMessage, tradeSentMessage, verificationMessage, verificationModal } from './presentation.js';

type Replyable = ChatInputCommandInteraction | MessageComponentInteraction | ModalSubmitInteraction;
/** Component actions that redraw the panel they were clicked on instead of posting a new message. */
const IN_PLACE = new Set(['inv', 'tl', 'sfilters', 'pick', 'itemrule', 'unrule', 'view', 'alerts', 'invalerts', 'fq', 'target', 'filters', 'addwatch', 'unwatch', 'delete', 'range', 'alertrate']);
/** Buttons that open a pop-up form. The form's submit custom ID is the action without the `modal` suffix. */
const MODALS: Record<string, (args: string[], user: () => UserProfile) => ModalBuilder> = {
  linkmodal: () => linkModal(),
  filtersmodal: (_, user) => filtersModal(user()),
  watchmodal: (_, user) => { user(); return itemModal(); },
  rulemodal: (_, user) => { user(); return itemRuleModal(); },
  targetmodal: (args, user) => { user(); return targetModal(args[0] ?? '-', args[1] ?? 3, args[2] ?? '-'); },
  sfiltersmodal: (args, user) => searchFiltersModal(user(), queryState(parseQuery(...args as [string?, string?, string?]))),
};

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export class Bot {
  private busy = new Set<string>();
  private lastSearch = new Map<string, number>();
  /** Latest finder result per user, so paging and details never re-run the search. */
  private results = new Map<string, { result: SearchResult; query: SearchQuery; at: number; token: string; robloxId: number }>();
  private static RESULT_TTL = 15 * 60_000;
  constructor(private store: Store, private search: SearchService, private scanSeconds = 60, private trading = new TradingService(store)) {}
  private profile(id: string): UserProfile {
    const user = this.store.get(id);
    if (!user) throw new NotLinkedError('Link a Roblox account first.');
    return user;
  }
  /** Avatars are decoration; a thumbnail outage must never fail a command. */
  private async avatar(robloxId: number): Promise<string | null> {
    try { return (await this.search.provider.avatar?.(robloxId)) ?? null; } catch { return null; }
  }
  /** Item names are decoration on settings panels; a pricing outage must not hide the panel. */
  private async itemNames(): Promise<Map<number, Item> | undefined> {
    try { return (await this.search.provider.items()).data; } catch { return undefined; }
  }
  async autocomplete(i: AutocompleteInteraction): Promise<void> {
    try {
      const query = i.options.getFocused().trim().toLowerCase();
      const items = await this.search.provider.items();
      const matches = [...items.data.values()].filter(item => String(item.id).startsWith(query) || item.name.toLowerCase().includes(query) || item.acronym.toLowerCase().includes(query));
      await i.respond(matches.slice(0, 25).map(item => ({ name: `${item.name} ${item.acronym ? `(${item.acronym}) ` : ''}— ${item.id}`.slice(0, 100), value: String(item.id) })));
    } catch { try { await i.respond([]); } catch { /* Expired autocomplete needs no public error. */ } }
  }
  private async fail(i: Replyable, error: unknown): Promise<void> {
    const expected = error instanceof UserError;
    if (!expected) console.error('Interaction failed:', error instanceof Error ? error.name : 'Unknown error');
    const payload = error instanceof TradeVerificationRequired ? verificationMessage(error)
      : error instanceof NotLinkedError ? linkRequiredMessage() : errorMessage(expected ? error.message : 'The command could not be completed. Try again shortly.', expected);
    try { if (i.deferred || i.replied) await i.editReply(payload); else await i.reply({ ...payload, flags: MessageFlags.Ephemeral }); } catch { /* Interaction expired. */ }
  }
  async handle(i: ChatInputCommandInteraction): Promise<void> {
    if (!['trade', 'connect', 'disconnect', 'find'].includes(i.commandName)) return;
    if (this.busy.has(i.user.id)) { await i.reply({ ...errorMessage('Your previous command is still running.'), flags: MessageFlags.Ephemeral }); return; }
    this.busy.add(i.user.id);
    try {
      if (i.commandName === 'connect') { this.trading.available(); await i.showModal(connectModal()); return; }
      if (i.commandName === 'disconnect') {
        await i.deferReply({ flags: MessageFlags.Ephemeral });
        this.store.disconnect(i.user.id); this.results.delete(i.user.id);
        this.trading.cancelVerification(i.user.id);
        await i.editReply(disconnectedMessage()); return;
      }
      const sub = i.commandName === 'find' ? 'find' : i.options.getSubcommand();
      // Forms must be the first response to an interaction, so they are shown before any deferral.
      if (sub === 'link') { await i.showModal(linkModal()); return; }
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      await this.execute(i);
    } catch (error) { await this.fail(i, error); }
    finally { this.busy.delete(i.user.id); }
  }
  /** Buttons, select menus and modals. Every custom ID is prefixed `tf:`; anything else is ignored. */
  async component(i: MessageComponentInteraction | ModalSubmitInteraction): Promise<void> {
    const parsed = ids.parse(i.customId);
    if (!parsed) return;
    if (this.busy.has(i.user.id)) { await i.reply({ ...errorMessage('Your previous command is still running.'), flags: MessageFlags.Ephemeral }); return; }
    this.busy.add(i.user.id);
    try {
      if (parsed.action === 'verifymodal' && !i.isModalSubmit()) {
        const token = parsed.args[0] ?? '';
        this.trading.checkVerification(i.user.id, token);
        await i.showModal(verificationModal(token)); return;
      }
      const modal = MODALS[parsed.action];
      if (modal) {
        if (!i.isModalSubmit()) await i.showModal(modal(parsed.args, () => this.profile(i.user.id)));
        return;
      }
      // Picking "Any item in your range" on the finder asks for that range before the panel redraws.
      if (parsed.action === 'fq' && parsed.args[0] === 'target' && i.isStringSelectMenu() && i.values.every(v => v === '-')) {
        await i.showModal(rangeModal(this.profile(i.user.id), parsed.args[1] ?? '-', parsed.args[2] ?? 3)); return;
      }
      // Switching the range filter on is the same request, so it asks for the band instead of guessing one.
      if (!i.isModalSubmit() && parsed.action === 'fq' && parsed.args[0] === 'afford') {
        const owner = this.profile(i.user.id);
        if (!owner.preferences.affordable) { await i.showModal(rangeModal(owner, parsed.args[1] ?? '-', parsed.args[3] ?? 3)); return; }
      }
      // Searching with no item picked also means "any item in your range"; ask for it once, then remember the answer.
      if (!i.isModalSubmit() && parsed.action === 'find' && this.needsRange(i.user.id, parsed.args)) {
        await i.showModal(rangeModal(this.profile(i.user.id), parsed.args[0] ?? '-', parsed.args[2] ?? 3, 'find')); return;
      }
      // Redraw ephemeral panels in place; DM alerts and forms opened straight from a slash command get a fresh private reply.
      const fromMessage = i.isModalSubmit() ? i.isFromMessage() : true;
      const inPlace = IN_PLACE.has(parsed.action) && fromMessage && Boolean(i.message?.flags?.has(MessageFlags.Ephemeral));
      if (inPlace) await i.deferUpdate(); else await i.deferReply({ flags: MessageFlags.Ephemeral });
      const payload = await this.act(i, parsed.action, parsed.args);
      if (payload) await i.editReply(inPlace ? { ...payload, attachments: [] } : payload);
    } catch (error) { await this.fail(i, error); }
    finally { this.busy.delete(i.user.id); }
  }
  /**
   * True when a Find press is about to run as "Any item in your range" — nothing picked and no wanted list to fall back
   * on — while no range is set. The price form is asked first; once answered (a band, or blank for what the inventory
   * can afford) the answer is remembered, so the question only returns if the range filter is switched off again.
   */
  private needsRange(discordId: string, args: string[]): boolean {
    const user = this.store.get(discordId);
    if (!user || user.preferences.affordable || user.preferences.targetIds.length) return false;
    const query = parseQuery(...args as [string?, string?, string?]);
    return findMode(query) !== 'downgrade' && !query.targetIds.length;
  }
  /**
   * Reads one numeric form box. Blank, non-numeric and out-of-window entries are all rejected by name, quoting what
   * was typed, so a form never saves a value the engine would silently reinterpret.
   */
  private static number(i: ModalSubmitInteraction, field: string, label: string, min: number, max: number): number {
    const typed = i.fields.getTextInputValue(field).trim();
    const raw = typed.replace(/[%,]/g, '').trim();
    if (!raw) throw new UserError(`**${label}** is required; the box was left empty.`);
    if (!/^-?\d+(\.\d+)?$/.test(raw)) throw new UserError(`**${label}** must be a number; you entered \`${typed.slice(0, 20)}\`.`);
    const n = Number(raw);
    if (n < min || n > max) throw new UserError(`**${label}** must be between ${min} and ${max}; you entered \`${typed.slice(0, 20)}\`.`);
    return n;
  }
  private async act(i: MessageComponentInteraction | ModalSubmitInteraction, action: string, args: string[]) {
    if (action === 'verify' && i.isModalSubmit()) {
      const tradeId = await this.trading.verifyAndPlace(i.user.id, args[0] ?? '', i.fields.getTextInputValue('code'), async content => {
        await i.editReply({ content, embeds: [], components: [] });
      });
      return { ...tradeSentMessage(tradeId), content: '' };
    }
    if (action === 'connect' && i.isModalSubmit()) {
      const account = await this.trading.connect(i.user.id, i.fields.getTextInputValue('cookie'));
      this.results.delete(i.user.id); this.lastSearch.delete(i.user.id);
      return connectedMessage(account);
    }
    if (action === 'link' && i.isModalSubmit()) return this.link(i.user.id, i.fields.getTextInputValue('user').trim(), i.fields.getTextInputValue('wanted'));
    if (action === 'view') {
      if (args[0] === 'help') return helpMessage();
      const user = this.profile(i.user.id);
      if (args[0] === 'profit') return profitMessage(user, await this.itemNames());
      if (args[0] === 'settings') return this.settings(user);
      if (args[0] === 'alerts') return this.alerts(user);
      if (args[0] === 'inventory') return this.inventory(user);
      if (args[0] === 'items') return itemsPanel(user, await this.itemNames());
    }
    const user = this.profile(i.user.id);
    if (action === 'place') {
      const cached = this.results.get(user.discordId);
      if (!cached || cached.token !== args[0] || cached.robloxId !== user.robloxId || Date.now() - cached.at > Bot.RESULT_TTL) {
        throw new UserError('This offer has expired or belongs to another search. Run /find trades again.');
      }
      const index = args[1] && /^\d+$/.test(args[1]) ? Number(args[1]) : -1;
      const offer = listPage(cached.result, 0).entries.find(e => e.index === index)?.best;
      if (!offer || args.length !== 2) throw new UserError('This offer is no longer available. Run /find trades again.');
      const tradeId = await this.trading.place(user, offer, cached.at + Bot.RESULT_TTL, async content => {
        await i.editReply({ content, embeds: [], components: [] });
      });
      return { ...tradeSentMessage(tradeId), content: '' };
    }
    if (action === 'inv') return this.inventory(user, args[0] === 'text' ? 'text' : 'grid', Number(args[1]) || 0);
    if (action === 'tl') {
      const cached = this.results.get(user.discordId);
      if (!cached || Date.now() - cached.at > Bot.RESULT_TTL) { this.results.delete(user.discordId); return expiredSearchMessage(); }
      if (cached.robloxId !== user.robloxId) { this.results.delete(user.discordId); return expiredSearchMessage(); }
      return this.tradeList(cached.result, cached.query, Number(args[0]) || 0, cached.token);
    }
    if (action === 'sfilters' && i.isModalSubmit()) {
      const updated = { ...user.preferences };
      updated.maxAdAgeMinutes = Bot.number(i, 'maxAdAgeMinutes', 'Max ad age', 1, 1440);
      const items = (await this.search.provider.items()).data;
      const down = parseMixedRange(i.fields.getTextInputValue('downgradeRange'), items);
      updated.downgradeProfitMin = down.min; updated.downgradeProfitMax = down.max;
      const up = parseMixedRange(i.fields.getTextInputValue('upgradeRange'), items);
      updated.upgradeOverpayMin = up.min; updated.upgradeOverpayMax = up.max;
      const receive = parseRange(i.fields.getTextInputValue('receiveRange'), items);
      updated.minReceiveValue = receive.min; updated.maxReceiveValue = receive.max;
      // Typing a range is a clear wish to use it, so it switches the filter on.
      if (receive.min !== null || receive.max !== null) updated.affordable = true;
      user.preferences = parsePreferences(updated); this.store.save(user);
      const parts = [down.min || down.max ? `Downgrade profit ${formatMixedRange(down)}` : '', up.min || up.max ? `Upgrade overpay ${formatMixedRange(up)}` : '', receive.min !== null || receive.max !== null ? `Any item worth ${formatRange(receive)}` : ''].filter(Boolean);
      return this.panel(parseQuery(...args as [string?, string?, string?]), user, `✅ Filters saved.${parts.length ? ` ${parts.join(' · ')}.` : ''} They also apply to alerts.`);
    }
    if (action === 'itemrule' && i.isModalSubmit()) {
      const items = (await this.search.provider.items()).data;
      const range = parseRange(i.fields.getTextInputValue('range'), items);
      try { return await this.setRule(user, resolveItem(i.fields.getTextInputValue('item'), items).id, range); }
      catch (error) { if (error instanceof AmbiguousItemError) return pickItemMessage(error.query, error.matches, ['itemrule', range.min ?? 'x', range.max ?? 'x']); throw error; }
    }
    if (action === 'unrule' && i.isStringSelectMenu()) {
      const value = i.values[0] ?? '';
      if (value === 'all') { user.preferences.itemRules = {}; this.store.save(user); return itemsPanel(user, await this.itemNames(), '🧹 Removed every per-item profit rule.'); }
      return this.setRule(user, ids.decode(value), { min: null, max: null });
    }
    if (action === 'delete') {
      if (args[0] !== 'yes') return deleteConfirmMessage();
      this.store.forget(user.discordId); this.lastSearch.delete(user.discordId); this.results.delete(user.discordId);
      this.trading.cancelVerification(user.discordId);
      return deletedMessage();
    }
    if (action === 'fq') {
      const [field, ...rest] = args;
      const values = i.isStringSelectMenu() ? i.values : [];
      // Choosing "any" alongside specific items means the specific items.
      const picked = values.filter(v => v !== '-');
      if (field === 'afford') { user.preferences.affordable = !user.preferences.affordable; this.store.save(user); }
      const query = field === 'mode' || field === 'afford' ? parseQuery(rest[0], rest[1], rest[2])
        : field === 'target' ? parseQuery(rest[0], picked.length ? picked.join(',') : '-', rest[1])
        : field === 'give' ? parseQuery(rest[0], picked[0] ?? '-', rest[1])
        : parseQuery(...rest as [string?, string?, string?]);
      return this.panel(query, user);
    }
    if (action === 'range' && i.isModalSubmit()) {
      const range = parseRange(i.fields.getTextInputValue('range'), (await this.search.provider.items()).data);
      user.preferences = parsePreferences({ ...user.preferences, minReceiveValue: range.min, maxReceiveValue: range.max, affordable: true });
      this.store.save(user);
      const custom = range.min !== null || range.max !== null;
      const query = parseQuery(args[0], '-', args[1]);
      // Asked from the Find button: the answer is the last thing the search needed, so run it rather than bouncing back.
      if (args[2] === 'find') { await this.find(i, user, query); return null; }
      return this.panel(query, user, custom ? `💸 Looking for any item worth **${formatRange(range)}**.` : '💸 Looking for any item your items can afford.');
    }
    if (action === 'target' && i.isModalSubmit()) return this.setTarget(user, i.fields.getTextInputValue('item'), args);
    if (action === 'pick' && i.isStringSelectMenu()) {
      const [kind, ...rest] = args;
      const id = String(ids.decode(i.values[0] ?? ''));
      if (kind === 'addwatch') return this.editList(user, id, false);
      if (kind === 'target') return this.setTarget(user, id, rest, true);
      if (kind === 'itemrule') { const num = (s?: string) => (s === undefined || s === 'x' ? null : Number(s)); return this.setRule(user, Number(id), { min: num(rest[0]), max: num(rest[1]) }); }
    }
    if (action === 'filters' && i.isModalSubmit()) {
      // The form asks for the loss you accept as a positive number; it is stored as a negative minimum gain. Gains are never capped.
      const loss = Bot.number(i, 'maxLossPct', 'Loss I will accept', 0, 50);
      const maxAdAgeMinutes = Bot.number(i, 'maxAdAgeMinutes', 'Max ad age', 1, 1440);
      user.preferences = parsePreferences({ ...user.preferences, minValueGainPct: -loss, maxValueGainPct: null, maxAdAgeMinutes });
      this.store.save(user);
      return profitMessage(user, await this.itemNames(), '✅ Profit filters updated.');
    }
    if (action === 'addwatch' && i.isModalSubmit()) return this.addMany(user, i.fields.getTextInputValue('item'));
    if (action === 'unwatch' && i.isStringSelectMenu()) {
      if (i.values.includes('all')) return this.editList(user, 'all', true);
      return this.removeMany(user, i.values.map(v => ids.decode(v)));
    }
    if (action === 'alerts') return this.setAlerts(user, args[0] === 'on');
    if (action === 'alertrate' && i.isStringSelectMenu()) {
      user.preferences = parsePreferences({ ...user.preferences, alertsPerScan: Number(i.values[0]) }); this.store.save(user);
      const n = user.preferences.alertsPerScan;
      return this.alerts(user, `📨 Sending up to **${n}** trade${n === 1 ? '' : 's'} per check.${user.alerts ? '' : ' Turn alerts on to start receiving them.'}`);
    }
    if (action === 'invalerts') return this.setInventoryAlerts(user, args[0] === 'on');
    if (action === 'find') { await this.find(i, user, parseQuery(...args as [string?, string?, string?])); return null; }
    if (action === 'recheck') {
      const [partner = '', give = '', receive = ''] = args;
      return this.recheck(user, String(ids.decode(partner)), ids.decodeList(give), ids.decodeList(receive));
    }
    throw new UserError('This button is no longer supported. Run the command again.');
  }
  private async execute(i: ChatInputCommandInteraction): Promise<void> {
    const sub = i.commandName === 'find' ? 'find' : i.options.getSubcommand();
    if (sub === 'help') { await i.editReply(helpMessage()); return; }
    const user = this.profile(i.user.id);
    const items = () => this.itemNames();
    switch (sub) {
      case 'profit': await i.editReply(profitMessage(user, await items())); return;
      case 'watch': await i.editReply(itemsPanel(user, await items())); return;
      case 'alerts': await i.editReply(this.alerts(user)); return;
      case 'settings': await i.editReply(await this.settings(user)); return;
      case 'inventory': await i.editReply(await this.inventory(user)); return;
      case 'find': await i.editReply(await this.panel({ mode: null, targetIds: [], results: 3 }, user)); return;
      case 'delete': await i.editReply(deleteConfirmMessage()); return;
      default: throw new UserError('Unknown command. Use /trade help.');
    }
  }
  /** One page of the trade list with a rendered Rolimons-style card per seller; a card that fails to render falls back to text. */
  private async tradeList(result: SearchResult, query: SearchQuery, page: number, token: string) {
    const { shown } = listPage(result, page);
    const assetIds = shown.flatMap(e => [...e.best.give, ...e.best.receive].map(c => c.assetId));
    const thumbnails = await this.search.provider.thumbnails?.(assetIds).catch(() => new Map<number, Buffer>()) ?? new Map<number, Buffer>();
    const cards = new Map<number, Buffer>();
    await Promise.all(shown.map(async e => { try { cards.set(e.index, await renderTradeCard(e.best, thumbnails, bucketOf(e.best))); } catch (error) { console.error('Trade card render failed:', error instanceof Error ? error.message : 'Unknown error'); } }));
    const files = shown.filter(e => cards.has(e.index)).map(e => new AttachmentBuilder(cards.get(e.index)!, { name: `trade-${e.index + 1}.png` }));
    // Each seller's character render; a thumbnail outage just leaves the card without one.
    const characters = new Map<number, string>();
    await Promise.all(shown.map(async e => { const url = await this.search.provider.character?.(e.best.ad.userId).catch(() => null); if (url) characters.set(e.best.ad.userId, url); }));
    return { ...tradeListMessage(result, query, await this.itemNames(), page, cards, characters, token), files };
  }
  /** Sets the find panel's target from a typed name/acronym/ID, offering a pick list when several items match. */
  /**
   * Sets the find panel's targets from typed names/acronyms/IDs (comma separated). Ambiguous entries get a pick list whose
   * choice is appended to the targets resolved so far; `append` adds to the existing targets instead of replacing them.
   */
  private async setTarget(user: UserProfile, input: string, args: string[], append = false) {
    const items = (await this.search.provider.items()).data;
    const [mode = '-', results = '3', existing = '-'] = args;
    const downgrade = mode === 'downgrade';
    const base = append && !downgrade ? parseQuery(mode, existing, results).targetIds : [];
    const entries = input.split(/[,\n]+/).map(e => e.trim()).filter(Boolean);
    if (!entries.length) throw new UserError('Enter at least one item.');
    if (downgrade && entries.length > 1) throw new UserError('Downgrade one item at a time: name the single item you want to give away.');
    if (base.length + entries.length > MAX_TARGETS) throw new UserError(`Search for up to ${MAX_TARGETS} items at once.`);
    const resolved: Item[] = [];
    for (const entry of entries) {
      try { resolved.push(resolveItem(entry, items)); }
      catch (error) {
        if (!(error instanceof AmbiguousItemError)) throw error;
        // Keep what already resolved so the pick completes the list rather than restarting it.
        const soFar = [...new Set([...base, ...resolved.map(r => r.id)])];
        return pickItemMessage(error.query, error.matches, ['target', mode, results, soFar.length ? ids.encodeList(soFar) : '-']);
      }
    }
    const targetIds = [...new Set([...base, ...resolved.map(r => r.id)])].slice(0, MAX_TARGETS);
    const label = (item: Item) => `**${item.name}**${item.acronym ? ` (${item.acronym})` : ''} · ID ${item.id}`;
    if (downgrade) {
      const choices = await this.giveChoices(user);
      if (!choices.some(c => c.id === targetIds[0])) throw new UserError(`You do not have an available copy of **${resolved[0]!.name}** to give (it may be on hold, projected or not in your public inventory).`);
      return this.panel({ ...parseQuery(mode, '-', results), targetIds: [targetIds[0]!] }, user, `📤 You will give ${label(resolved[0]!)}.`);
    }
    return this.panel({ ...parseQuery(mode, '-', results), targetIds }, user,
      `🎯 ${targetIds.length > 1 ? `Targets set to ${targetIds.map(id => items.get(id)).filter((i): i is Item => Boolean(i)).map(label).join(', ')}` : `Target set to ${label(resolved[0]!)}`}.`);
  }
  /** Saves (or, for an empty range, removes) the profit window that applies when a trade brings in `itemId`. */
  private async setRule(user: UserProfile, itemId: number, range: Range) {
    const items = await this.itemNames();
    const name = items?.get(itemId)?.name ?? `item ${itemId}`;
    const rules = { ...user.preferences.itemRules };
    const removing = range.min === null && range.max === null;
    if (removing) delete rules[String(itemId)];
    else {
      if (Object.keys(rules).length >= 25 && !rules[String(itemId)]) throw new UserError('You can keep up to 25 per-item profit rules; remove one first.');
      rules[String(itemId)] = range;
    }
    user.preferences = parsePreferences({ ...user.preferences, itemRules: rules }); this.store.save(user);
    return itemsPanel(user, items, removing ? `➖ Removed the profit rule for **${name}**.` : `🎯 Trades that bring in **${name}** must now profit **${formatRange(range)}** value.`);
  }
  /** Adds several comma/newline-separated items; the first ambiguous one opens a pick list after the rest are saved. */
  private async addMany(user: UserProfile, input: string) {
    const entries = input.split(/[,\n]+/).map(e => e.trim()).filter(Boolean);
    if (!entries.length) throw new UserError('Enter at least one item.');
    const items = (await this.search.provider.items()).data;
    const added: Item[] = []; const problems: string[] = []; let ambiguous: AmbiguousItemError | undefined;
    for (const entry of entries) {
      try { added.push(resolveItem(entry, items)); }
      catch (error) {
        if (error instanceof AmbiguousItemError) { if (ambiguous) problems.push(`"${entry.slice(0, 30)}" matched several items; add it on its own.`); else ambiguous = error; }
        else if (error instanceof UserError) problems.push(error.message);
        else throw error;
      }
    }
    const next = [...new Set([...user.preferences.targetIds, ...added.map(a => a.id)])];
    if (next.length > 100) throw new UserError('This list holds up to 100 items; remove some first.');
    user.preferences.targetIds = next; this.store.save(user);
    if (ambiguous) return pickItemMessage(ambiguous.query, ambiguous.matches, ['addwatch']);
    const label = (item: Item) => `**${item.name}**${item.acronym ? ` (${item.acronym})` : ''} · ID ${item.id}`;
    const note = [added.length ? `⭐ Now watching ${added.map(label).join(', ')}.` : '', ...problems.map(p => `⚠️ ${p}`)].filter(Boolean).join('\n');
    return itemsPanel(user, items, note || undefined);
  }
  /** Several menu picks at once: every chosen item leaves the list in one go. */
  private async removeMany(user: UserProfile, itemIds: number[]) {
    const items = await this.itemNames();
    const removed = user.preferences.targetIds.filter(id => itemIds.includes(id));
    user.preferences.targetIds = user.preferences.targetIds.filter(id => !itemIds.includes(id)); this.store.save(user);
    const names = removed.map(id => `**${items?.get(id)?.name ?? `item ${id}`}**`).join(', ');
    return itemsPanel(user, items, removed.length ? `➖ Removed ${names}.` : 'Nothing to remove.');
  }
  /** The settings hub: account, alerts, mode, demand, lists and archive coverage. */
  private async settings(user: UserProfile, note?: string) {
    return settingsMessage(user, await this.itemNames(), await this.avatar(user.robloxId), this.search.coverage(), note);
  }
  /** Adds or removes one wanted item (or clears the list) and redraws the items panel. */
  private async editList(user: UserProfile, input: string, removing: boolean) {
    let note: string;
    if (removing && input.toLowerCase() === 'all') { user.preferences.targetIds = []; note = '🧹 Cleared your wanted list.'; }
    else {
      // Removal by ID still works if an item disappears from the pricing catalog.
      const item = removing && /^\d+$/.test(input) ? null : resolveItem(input, (await this.search.provider.items()).data);
      const itemId = item?.id ?? parseId(input);
      const next = removing ? user.preferences.targetIds.filter(id => id !== itemId) : [...new Set([...user.preferences.targetIds, itemId])];
      if (next.length > 100) throw new UserError('This list is full; remove an item first.');
      user.preferences.targetIds = next;
      const name = item ? `${item.name}${item.acronym ? ` (${item.acronym})` : ''} · ID ${item.id}` : `item ${itemId}`;
      note = removing ? `➖ Removed **${name}**.` : `⭐ Now watching **${name}**.`;
    }
    this.store.save(user);
    return itemsPanel(user, await this.itemNames(), note);
  }
  private async link(discordId: string, input: string, wanted = '') {
    const roblox = await this.search.provider.user(input);
    const inventory = await this.search.provider.inventory(roblox.id);
    const user = this.store.link(discordId, roblox.id, roblox.name);
    this.trading.cancelVerification(discordId);
    this.results.delete(discordId);
    // The optional form box seeds the wanted list; unmatched entries are reported, not fatal.
    const notes: string[] = [];
    if (wanted.trim()) {
      const items = (await this.search.provider.items()).data;
      const found: string[] = [], missed: string[] = [];
      for (const entry of wanted.split(/[,\n]+/).map(e => e.trim()).filter(Boolean).slice(0, 100)) {
        try { const item = resolveItem(entry, items); user.preferences.targetIds = [...new Set([...user.preferences.targetIds, item.id])]; found.push(item.name); }
        catch (error) { missed.push(error instanceof AmbiguousItemError ? `${entry.slice(0, 30)} (did you mean ${error.matches.slice(0, 3).map(m => m.acronym || m.name).join(', ')}?)` : entry.slice(0, 30)); }
      }
      if (found.length) notes.push(`⭐ Wanted: **${found.join(', ')}**`);
      if (missed.length) notes.push(`⚠️ Not recognised as wanted items: ${missed.join(', ')} — add them later from **Wanted items**.`);
      this.store.save(user);
    }
    return linkMessage(roblox, visibleHoldings(inventory.holdings).length, await this.avatar(roblox.id), notes.join('\n'));
  }
  /** The alerts panel, with the real check interval and when the last DM went out. */
  private alerts(user: UserProfile, note?: string) {
    return alertsMessage(user, this.scanSeconds, note, this.store.lastSentAt(user.discordId));
  }
  private setAlerts(user: UserProfile, enabled: boolean) {
    user.alerts = enabled; user.alertError = null; this.store.save(user);
    return this.alerts(user);
  }
  /** Turning inventory DMs on records the current inventory as the baseline, so only changes from now on are reported. */
  private async setInventoryAlerts(user: UserProfile, enabled: boolean) {
    let copies: number | undefined;
    if (enabled) {
      const inventory = await this.search.provider.inventory(user.robloxId, 0, user);
      if (inventory.tradabilityError) throw new UserError(inventory.tradabilityError);
      this.store.saveSnapshot(user.discordId, inventory.holdings, inventory.fetchedAt, true); copies = visibleHoldings(inventory.holdings).length;
    }
    else this.store.clearSnapshot(user.discordId);
    user.inventoryAlerts = enabled; this.store.save(user);
    return inventoryAlertsMessage(user, copies);
  }
  private async inventory(user: UserProfile, view: InventoryView = 'grid', page = 0) {
    const [inventory, items] = await Promise.all([this.search.provider.inventory(user.robloxId, undefined, user), this.search.provider.items()]);
    const available = priced(inventory, items.data);
    const total = totals(available);
    const entries = groupInventory(inventory, items.data);
    const paged = paginate(entries, page, PAGE_SIZE[view]);
    const files: AttachmentBuilder[] = [];
    if (view === 'grid') {
      const thumbnails = await this.search.provider.thumbnails?.(paged.items.map(e => e.assetId)).catch(() => new Map<number, Buffer>()) ?? new Map<number, Buffer>();
      files.push(new AttachmentBuilder(await renderInventoryGrid(paged.items, thumbnails), { name: 'inventory.png' }));
    }
    const copies = entries.reduce((n, e) => n + e.quantity, 0);
    const message = inventoryMessage(user, { view, ...paged, entries: paged.items, total: entries.length, copies, value: total.value, rap: total.rap, note: inventory.tradabilityError }, await this.avatar(user.robloxId));
    return { ...message, files };
  }
  private cooldown(discordId: string): void {
    const last = this.lastSearch.get(discordId) ?? 0;
    if (Date.now() - last < 30_000) throw new UserError(`Please wait ${Math.ceil((30_000 - (Date.now() - last)) / 1000)} more seconds between searches or re-checks.`);
    this.lastSearch.set(discordId, Date.now());
    // Keep the cooldown map bounded for long-running public bots.
    for (const [id, at] of this.lastSearch) if (Date.now() - at > 60_000) this.lastSearch.delete(id);
  }
  /**
   * Runs the finder in one of its two modes. The mode fixes the value window and the ranking; the user's extra filters
   * (profit range, per-item rules, RAP, demand, ad age) apply on top.
   */
  private async find(i: Replyable, user: UserProfile, query: SearchQuery): Promise<void> {
    const mode = findMode(query);
    if (mode === 'downgrade' && !query.targetIds[0]) throw new UserError('Pick which of your items to give away first.');
    this.cooldown(user.discordId);
    // The window is the user's own: at most the loss they accept, and any gain above it. The mode only shapes the trade and the ranking.
    const prefs = { ...user.preferences, mode: mode === 'both' ? 'any' as const : mode, maxValueGainPct: null };
    if (mode !== 'downgrade' && query.targetIds.length) prefs.targetIds = query.targetIds;
    if (mode === 'downgrade') prefs.targetIds = [];
    // Every mode wants the same thing: the trades that best do what their shape is for, biggest items first.
    // The search ranks that way by default, so no mode needs an ordering of its own.
    const result = await this.search.search(user, prefs, { giveOnly: mode === 'downgrade' ? query.targetIds[0] : undefined });
    // "Both" alternates upgrade-shaped and downgrade-shaped sellers so one shape never crowds the other out of the list.
    if (mode === 'both') {
      const isDown = (r: Recommendation) => r.mode === 'downgrade';
      const ups = result.recommendations.filter(r => !isDown(r)), downs = result.recommendations.filter(isDown);
      const mixed: Recommendation[] = [];
      for (let i = 0; i < Math.max(ups.length, downs.length); i++) { if (ups[i]) mixed.push(ups[i]!); if (downs[i]) mixed.push(downs[i]!); }
      result.recommendations = mixed;
    }
    const token = randomBytes(16).toString('hex');
    this.trading.cancelVerification(user.discordId);
    for (const [id, cached] of this.results) if (Date.now() - cached.at > Bot.RESULT_TTL) this.results.delete(id);
    this.results.set(user.discordId, { result, query, at: Date.now(), token, robloxId: user.robloxId });
    await i.editReply(await this.tradeList(result, query, 0, token));
  }
  /** Items the user can give away in downgrade mode: available, non-projected, priced; most valuable first. */
  private async giveChoices(user: UserProfile): Promise<GiveChoice[]> {
    const [inventory, items] = await Promise.all([this.search.provider.inventory(user.robloxId, undefined, user), this.search.provider.items()]);
    const seen = new Map<number, GiveChoice>();
    for (const c of priced(inventory, items.data)) if (!seen.has(c.assetId)) seen.set(c.assetId, { id: c.assetId, name: c.item.name, value: effectiveValue(c.item) });
    return [...seen.values()].sort((a, b) => b.value - a.value).slice(0, 25);
  }
  /** The find panel with everything it needs: item names, archive coverage and, in downgrade mode, the user's giveable items. */
  private async panel(query: SearchQuery, user: UserProfile, note?: string) {
    const mode = findMode(query);
    const choices = mode === 'downgrade' ? await this.giveChoices(user).catch(() => [] as GiveChoice[]) : [];
    const p = user.preferences;
    const affordable = p.affordable && p.minReceiveValue === null && p.maxReceiveValue === null ? await this.affordable(user, REALISTIC_GAIN_PCT) : null;
    return findPanel(query, user, await this.itemNames(), note, this.search.coverage(), choices, affordable);
  }
  /** The band this user's items can pay for, shown on the find panel; an inventory outage just hides the numbers. */
  private async affordable(user: UserProfile, maxGainPct: number): Promise<{ min: number; max: number } | null> {
    try {
      const [inventory, items] = await Promise.all([this.search.provider.inventory(user.robloxId, undefined, user), this.search.provider.items()]);
      const band = affordableRange(priced(inventory, items.data), maxGainPct);
      return band ? { min: band.minReceiveValue, max: band.maxReceiveValue } : null;
    } catch { return null; }
  }
  /** Re-evaluates one exchange from a recommendation card against both live inventories. */
  private async recheck(user: UserProfile, partnerInput: string, giveIds: number[], receiveIds: number[]) {
    this.cooldown(user.discordId);
    const partner = await this.search.provider.user(partnerInput);
    if (partner.id === user.robloxId) throw new UserError('Choose a different trade partner.');
    const [own, theirs, items] = await Promise.all([this.search.provider.inventory(user.robloxId, 0, user), this.search.provider.inventory(partner.id, 0, user), this.search.provider.items()]);
    if (own.tradabilityError || theirs.tradabilityError) throw new UserError(own.tradabilityError ?? theirs.tradabilityError!);
    if ([own.fetchedAt, theirs.fetchedAt, items.fetchedAt].some(at => Date.now() - at > 300_000))
      throw new UserError('An inventory or price snapshot became stale during analysis. Please retry.');
    const give = selectCopies(giveIds, priced(own, items.data)), receive = selectCopies(receiveIds, priced(theirs, items.data));
    if (!give || !receive) throw new UserError('One side lacks enough verified tradable copies, or an item is held or has no supported price.');
    return analysisMessage(evaluate(give, receive, user.preferences), partner, await this.avatar(partner.id));
  }
}

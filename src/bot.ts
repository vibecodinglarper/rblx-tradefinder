import {
  AttachmentBuilder, MessageFlags, type ChatInputCommandInteraction, type InteractionEditReplyOptions,
  type MessageComponentInteraction, type ModalBuilder, type ModalSubmitInteraction,
} from 'discord.js';
import { effectiveValue, NotLinkedError, parseId, parsePreferences, UserError, visibleHoldings, type Item, type UserProfile } from './domain.js';
import { affordableRange, bucketOf, evaluate, interleave, priced, REALISTIC_GAIN_PCT, selectCopies, totals, type Recommendation } from './engine.js';
import { groupInventory, paginate, PAGE_SIZE, type InventoryView } from './inventory.js';
import { renderInventoryGrid, renderTradeCard } from './render.js';
import { AmbiguousItemError, resolveItem } from './providers.js';
import { formatMixedRange, formatRange, parseMixedRange, parseRange, type Range } from './amounts.js';
import {
  alertsMessage, analysisMessage, connectModal, connectedMessage, deleteConfirmMessage, deletedMessage, disconnectedMessage, errorMessage,
  expiredSearchMessage, filtersModal, findMode, findPanel, helpMessage, ids, inventoryAlertsMessage, inventoryMessage, itemModal, itemRuleModal,
  itemsPanel, linkMessage, linkModal, linkRequiredMessage, listPage, MAX_TARGETS, parseQuery, pickItemMessage, profitMessage, queryFromArgs,
  queryState, rangeModal, searchFiltersModal, settingsMessage, targetModal, tradeListMessage, tradeSentMessage, verificationMessage, verificationModal,
  type GiveChoice, type SearchQuery,
} from './presentation.js';
import type { SearchResult, SearchService } from './search.js';
import { COMMAND_NAMES } from './commands.js';
import type { Store } from './store.js';
import { randomBytes } from 'node:crypto';
import { TradingService, TradeVerificationRequired } from './trading.js';

type Replyable = ChatInputCommandInteraction | MessageComponentInteraction | ModalSubmitInteraction;
type Component = MessageComponentInteraction | ModalSubmitInteraction;
/** What an action hands back to be shown, or null when it already replied itself (a search draws its own list). */
type Reply = InteractionEditReplyOptions | null;
/** What an action gets: the interaction, the custom ID's trailing parts, and the tracked account, looked up on first use. */
interface Action { i: Component; args: string[]; user: () => UserProfile }
type Handler = (a: Action) => Reply | Promise<Reply>;
/** Component actions that redraw the panel they were clicked on instead of posting a new message. */
const IN_PLACE = new Set(['inv', 'tl', 'sfilters', 'pick', 'itemrule', 'unrule', 'view', 'alerts', 'invalerts', 'fq', 'target', 'filters', 'addwatch', 'unwatch', 'delete', 'range', 'alertrate']);
/** Buttons that open a pop-up form. The form's submit custom ID is the action without the `modal` suffix. */
const MODALS: Record<string, (args: string[], user: () => UserProfile) => ModalBuilder> = {
  linkmodal: () => linkModal(),
  filtersmodal: (_, user) => filtersModal(user()),
  watchmodal: (_, user) => { user(); return itemModal(); },
  rulemodal: (_, user) => { user(); return itemRuleModal(); },
  targetmodal: (args, user) => { user(); return targetModal(args[0] ?? '-', args[1] ?? 3, args[2] ?? '-'); },
  sfiltersmodal: (args, user) => searchFiltersModal(user(), queryState(queryFromArgs(args))),
};
const unsupported = () => new UserError('This button is no longer supported. Run the command again.');
/** Actions that only make sense as a submitted form or a menu pick; a stray button with the same verb is refused like any unknown action. */
const submitted = (i: Component): ModalSubmitInteraction => { if (!i.isModalSubmit()) throw unsupported(); return i; };
const picked = (i: Component): string[] => { if (!i.isStringSelectMenu()) throw unsupported(); return i.values; };
/** Sending waits on Roblox; the wait notice replaces the panel until the result arrives. */
const progress = (i: Component) => async (content: string) => { await i.editReply({ content, embeds: [], components: [] }); };
const sent = (tradeId: number): Reply => ({ ...tradeSentMessage(tradeId), content: '' });
/** Comma- or newline-separated form entries, trimmed and non-empty. */
const entriesOf = (input: string) => input.split(/[,\n]+/).map(e => e.trim()).filter(Boolean);
const itemLabel = (item: Item) => `**${item.name}**${item.acronym ? ` (${item.acronym})` : ''} · ID ${item.id}`;

export class Bot {
  private busy = new Set<string>();
  private lastSearch = new Map<string, number>();
  /** Latest finder result per user, so paging and details never re-run the search. */
  private results = new Map<string, { result: SearchResult; query: SearchQuery; at: number; token: string; robloxId: number }>();
  private static RESULT_TTL = 15 * 60_000;
  /** Offers sent as alert DMs, keyed by the token in the DM's Place Trade button; bounded per user and by RESULT_TTL. */
  private alertOffers = new Map<string, { offer: Recommendation; discordId: string; robloxId: number; at: number }>();
  private static ALERTS_PER_USER = 20;
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
  /** Item thumbnails for rendered cards; an outage leaves the squares blank rather than failing the panel. */
  private async thumbnails(assetIds: number[]): Promise<Map<number, Buffer>> {
    return await this.search.provider.thumbnails?.(assetIds).catch(() => new Map<number, Buffer>()) ?? new Map<number, Buffer>();
  }
  private async fail(i: Replyable, error: unknown): Promise<void> {
    const expected = error instanceof UserError;
    if (!expected) console.error('Interaction failed:', error instanceof Error ? error.name : 'Unknown error');
    const payload = error instanceof TradeVerificationRequired ? verificationMessage(error)
      : error instanceof NotLinkedError ? linkRequiredMessage() : errorMessage(expected ? error.message : 'The command could not be completed. Try again shortly.', expected);
    try { if (i.deferred || i.replied) await i.editReply(payload); else await i.reply({ ...payload, flags: MessageFlags.Ephemeral }); } catch { /* Interaction expired. */ }
  }
  async handle(i: ChatInputCommandInteraction): Promise<void> {
    if (!COMMAND_NAMES.has(i.commandName)) return;
    if (this.busy.has(i.user.id)) { await i.reply({ ...errorMessage('Your previous command is still running.'), flags: MessageFlags.Ephemeral }); return; }
    this.busy.add(i.user.id);
    try {
      if (i.commandName === 'connect') { this.trading.available(); await i.showModal(connectModal()); return; }
      if (i.commandName === 'disconnect') {
        await i.deferReply({ flags: MessageFlags.Ephemeral });
        this.store.disconnect(i.user.id); this.forgetOffers(i.user.id);
        this.trading.cancelVerification(i.user.id);
        await i.editReply(disconnectedMessage()); return;
      }
      // Forms must be the first response to an interaction, so they are shown before any deferral.
      if (i.commandName === 'link') { await i.showModal(linkModal()); return; }
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      await this.execute(i);
    } catch (error) { await this.fail(i, error); }
    finally { this.busy.delete(i.user.id); }
  }
  /** Buttons, select menus and modals. Every custom ID is prefixed `tf:`; anything else is ignored. */
  async component(i: Component): Promise<void> {
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
    const query = queryFromArgs(args);
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
  /** Runs the component action named by a custom ID; anything not in the table is a button from an older build. */
  private act(i: Component, action: string, args: string[]): Reply | Promise<Reply> {
    const handler = this.actions[action];
    if (!handler) throw unsupported();
    let owner: UserProfile | undefined;
    return handler({ i, args, user: () => (owner ??= this.profile(i.user.id)) });
  }
  /** Component actions by the verb in their custom ID. Only `verify`, `connect`, `link` and `view help` work without a tracked account. */
  private readonly actions: Record<string, Handler> = {
    verify: async ({ i, args }) => sent(await this.trading.verifyAndPlace(i.user.id, args[0] ?? '', submitted(i).fields.getTextInputValue('code'), progress(i))),
    connect: async ({ i }) => {
      const account = await this.trading.connect(i.user.id, submitted(i).fields.getTextInputValue('cookie'));
      this.forgetOffers(i.user.id); this.lastSearch.delete(i.user.id);
      return connectedMessage(account);
    },
    link: ({ i }) => { const form = submitted(i); return this.link(i.user.id, form.fields.getTextInputValue('user').trim(), form.fields.getTextInputValue('wanted')); },
    view: ({ args, user }) => this.view(args[0] ?? '', user),
    // Place Trade on the trade list: the token must belong to this user's latest search, for the same account, and be fresh.
    place: async ({ i, args, user }) => {
      const owner = user();
      const cached = this.results.get(owner.discordId);
      if (!cached || cached.token !== args[0] || cached.robloxId !== owner.robloxId || Date.now() - cached.at > Bot.RESULT_TTL) {
        throw new UserError('This offer has expired or belongs to another search. Run /trade again.');
      }
      const index = args[1] && /^\d+$/.test(args[1]) ? Number(args[1]) : -1;
      const offer = listPage(cached.result, 0).entries.find(e => e.index === index)?.best;
      if (!offer || args.length !== 2) throw new UserError('This offer is no longer available. Run /trade again.');
      return sent(await this.trading.place(owner, offer, cached.at + Bot.RESULT_TTL, progress(i)));
    },
    // Place Trade on an alert DM: the token must be this user's, for the account the alert was found for, and fresh.
    placealert: async ({ i, args, user }) => {
      const owner = user();
      const alert = this.alertOffers.get(args[0] ?? '');
      if (!alert || args.length !== 1 || alert.discordId !== owner.discordId || alert.robloxId !== owner.robloxId || Date.now() - alert.at > Bot.RESULT_TTL) {
        throw new UserError('This alert has expired or belongs to another account. Wait for the next alert or run /trade.');
      }
      return sent(await this.trading.place(owner, alert.offer, alert.at + Bot.RESULT_TTL, progress(i)));
    },
    inv: ({ args, user }) => this.inventory(user(), args[0] === 'text' ? 'text' : 'grid', Number(args[1]) || 0),
    tl: ({ args, user }) => {
      const owner = user();
      const cached = this.results.get(owner.discordId);
      if (!cached || cached.robloxId !== owner.robloxId || Date.now() - cached.at > Bot.RESULT_TTL) { this.results.delete(owner.discordId); return expiredSearchMessage(); }
      return this.tradeList(cached.result, cached.query, Number(args[0]) || 0, cached.token);
    },
    sfilters: ({ i, args, user }) => { const owner = user(); return this.saveSearchFilters(submitted(i), owner, args); },
    itemrule: async ({ i, user }) => {
      const owner = user(); const form = submitted(i);
      const items = (await this.search.provider.items()).data;
      const range = parseRange(form.fields.getTextInputValue('range'), items);
      try { return await this.setRule(owner, resolveItem(form.fields.getTextInputValue('item'), items).id, range); }
      catch (error) { if (error instanceof AmbiguousItemError) return pickItemMessage(error.query, error.matches, ['itemrule', range.min ?? 'x', range.max ?? 'x']); throw error; }
    },
    unrule: async ({ i, user }) => {
      const owner = user(); const value = picked(i)[0] ?? '';
      if (value === 'all') { owner.preferences.itemRules = {}; this.store.save(owner); return itemsPanel(owner, await this.itemNames(), '🧹 Removed every per-item profit rule.'); }
      return this.setRule(owner, ids.decode(value), { min: null, max: null });
    },
    delete: ({ args, user }) => {
      const owner = user();
      if (args[0] !== 'yes') return deleteConfirmMessage();
      this.store.forget(owner.discordId); this.lastSearch.delete(owner.discordId); this.forgetOffers(owner.discordId);
      this.trading.cancelVerification(owner.discordId);
      return deletedMessage();
    },
    fq: ({ i, args, user }) => {
      const owner = user();
      const [field, ...rest] = args;
      // Choosing "any" alongside specific items means the specific items.
      const chosen = (i.isStringSelectMenu() ? i.values : []).filter(v => v !== '-');
      if (field === 'afford') { owner.preferences.affordable = !owner.preferences.affordable; this.store.save(owner); }
      // Targets (upgrade) and give-aways (downgrade) are both multi-picks carried the same way.
      const query = field === 'mode' || field === 'afford' ? queryFromArgs(rest)
        : field === 'target' || field === 'give' ? parseQuery(rest[0], chosen.length ? chosen.join(',') : '-', rest[1])
        : queryFromArgs(rest);
      return this.panel(query, owner);
    },
    range: async ({ i, args, user }) => {
      const owner = user(); const form = submitted(i);
      const range = parseRange(form.fields.getTextInputValue('range'), (await this.search.provider.items()).data);
      owner.preferences = parsePreferences({ ...owner.preferences, minReceiveValue: range.min, maxReceiveValue: range.max, affordable: true });
      this.store.save(owner);
      const query = parseQuery(args[0], '-', args[1]);
      // Asked from the Find button: the answer is the last thing the search needed, so run it rather than bouncing back.
      if (args[2] === 'find') { await this.find(i, owner, query); return null; }
      const custom = range.min !== null || range.max !== null;
      return this.panel(query, owner, custom ? `💸 Looking for any item worth **${formatRange(range)}**.` : '💸 Looking for any item your items can afford.');
    },
    target: ({ i, args, user }) => { const owner = user(); return this.setTarget(owner, submitted(i).fields.getTextInputValue('item'), args); },
    // A choice from the "which item did you mean" menu completes whichever action asked the question.
    pick: ({ i, args, user }) => {
      const owner = user();
      const [kind, ...rest] = args;
      const id = String(ids.decode(picked(i)[0] ?? ''));
      if (kind === 'addwatch') return this.editList(owner, id, false);
      if (kind === 'target') return this.setTarget(owner, id, rest, true);
      if (kind === 'itemrule') { const num = (s?: string) => (s === undefined || s === 'x' ? null : Number(s)); return this.setRule(owner, Number(id), { min: num(rest[0]), max: num(rest[1]) }); }
      throw unsupported();
    },
    filters: async ({ i, user }) => {
      const owner = user(); const form = submitted(i);
      // The form asks for the loss you accept as a positive number; it is stored as a negative minimum gain. Gains are never capped.
      const loss = Bot.number(form, 'maxLossPct', 'Loss I will accept', 0, 50);
      const maxAdAgeMinutes = Bot.number(form, 'maxAdAgeMinutes', 'Max ad age', 1, 1440);
      owner.preferences = parsePreferences({ ...owner.preferences, minValueGainPct: -loss, maxValueGainPct: null, maxAdAgeMinutes });
      this.store.save(owner);
      return profitMessage(owner, await this.itemNames(), '✅ Profit filters updated.');
    },
    addwatch: ({ i, user }) => { const owner = user(); return this.addMany(owner, submitted(i).fields.getTextInputValue('item')); },
    unwatch: ({ i, user }) => {
      const owner = user(); const values = picked(i);
      if (values.includes('all')) return this.editList(owner, 'all', true);
      return this.removeMany(owner, values.map(v => ids.decode(v)));
    },
    alerts: ({ args, user }) => this.setAlerts(user(), args[0] === 'on'),
    alertrate: ({ i, user }) => {
      const owner = user(); const values = picked(i);
      owner.preferences = parsePreferences({ ...owner.preferences, alertsPerScan: Number(values[0]) }); this.store.save(owner);
      const n = owner.preferences.alertsPerScan;
      return this.alerts(owner, `📨 Sending up to **${n}** trade${n === 1 ? '' : 's'} per check.${owner.alerts ? '' : ' Turn alerts on to start receiving them.'}`);
    },
    invalerts: ({ args, user }) => this.setInventoryAlerts(user(), args[0] === 'on'),
    find: async ({ i, args, user }) => { await this.find(i, user(), queryFromArgs(args)); return null; },
    recheck: ({ args, user }) => {
      const owner = user();
      const [partner = '', give = '', receive = ''] = args;
      return this.recheck(owner, String(ids.decode(partner)), ids.decodeList(give), ids.decodeList(receive));
    },
  };
  /** The panels reachable from navigation buttons and their slash commands. Help is the only one that needs no account. */
  private async view(name: string, user: () => UserProfile): Promise<NonNullable<Reply>> {
    if (name === 'help') return helpMessage();
    const owner = user();
    if (name === 'profit') return profitMessage(owner, await this.itemNames());
    if (name === 'settings') return this.settings(owner);
    if (name === 'alerts') return this.alerts(owner);
    if (name === 'inventory') return this.inventory(owner);
    if (name === 'items') return itemsPanel(owner, await this.itemNames());
    throw unsupported();
  }
  private async execute(i: ChatInputCommandInteraction): Promise<void> {
    const user = () => this.profile(i.user.id);
    if (i.commandName === 'trade') { await i.editReply(await this.panel({ mode: null, targetIds: [], results: 3 }, user())); return; }
    if (i.commandName === 'delete') { user(); await i.editReply(deleteConfirmMessage()); return; }
    await i.editReply(await this.view(i.commandName === 'watch' ? 'items' : i.commandName, user));
  }
  /** The finder's search filters form: shape windows, the receive range and ad age, all saved together. */
  private async saveSearchFilters(form: ModalSubmitInteraction, user: UserProfile, args: string[]) {
    const updated = { ...user.preferences };
    updated.maxAdAgeMinutes = Bot.number(form, 'maxAdAgeMinutes', 'Max ad age', 1, 1440);
    const items = (await this.search.provider.items()).data;
    const down = parseMixedRange(form.fields.getTextInputValue('downgradeRange'), items);
    updated.downgradeProfitMin = down.min; updated.downgradeProfitMax = down.max;
    const up = parseMixedRange(form.fields.getTextInputValue('upgradeRange'), items);
    updated.upgradeOverpayMin = up.min; updated.upgradeOverpayMax = up.max;
    const receive = parseRange(form.fields.getTextInputValue('receiveRange'), items);
    updated.minReceiveValue = receive.min; updated.maxReceiveValue = receive.max;
    // Typing a range is a clear wish to use it, so it switches the filter on.
    const typedRange = receive.min !== null || receive.max !== null;
    if (typedRange) updated.affordable = true;
    user.preferences = parsePreferences(updated); this.store.save(user);
    const parts = [down.min || down.max ? `Downgrade profit ${formatMixedRange(down)}` : '', up.min || up.max ? `Upgrade overpay ${formatMixedRange(up)}` : '', typedRange ? `Any item worth ${formatRange(receive)}` : ''].filter(Boolean);
    return this.panel(queryFromArgs(args), user, `✅ Filters saved.${parts.length ? ` ${parts.join(' · ')}.` : ''} They also apply to alerts.`);
  }
  /** One page of the trade list with a rendered Rolimons-style card per seller; a card that fails to render falls back to text. */
  private async tradeList(result: SearchResult, query: SearchQuery, page: number, sendToken: string) {
    const { shown } = listPage(result, page);
    const thumbnails = await this.thumbnails(shown.flatMap(e => [...e.best.give, ...e.best.receive].map(c => c.assetId)));
    const cards = new Map<number, Buffer>();
    await Promise.all(shown.map(async e => { try { cards.set(e.index, await renderTradeCard(e.best, thumbnails, bucketOf(e.best))); } catch (error) { console.error('Trade card render failed:', error instanceof Error ? error.message : 'Unknown error'); } }));
    const files = shown.flatMap(e => { const png = cards.get(e.index); return png ? [new AttachmentBuilder(png, { name: `trade-${e.index + 1}.png` })] : []; });
    // Each seller's character render; a thumbnail outage just leaves the card without one.
    const characters = new Map<number, string>();
    await Promise.all(shown.map(async e => { const url = await this.search.provider.character?.(e.best.ad.userId).catch(() => null); if (url) characters.set(e.best.ad.userId, url); }));
    return { ...tradeListMessage(result, query, { items: await this.itemNames(), page, cards, characters, sendToken }), files };
  }
  /** Every sendable offer a user holds, from searches and alert DMs alike; dropped whenever the account behind them changes. */
  private forgetOffers(discordId: string): void {
    this.results.delete(discordId);
    for (const [token, alert] of this.alertOffers) if (alert.discordId === discordId) this.alertOffers.delete(token);
  }
  /**
   * Remembers a recommendation that is about to go out as an alert DM and returns the token its Place Trade button
   * carries. Offers expire with RESULT_TTL, and a user keeps at most ALERTS_PER_USER of them, oldest dropped first.
   */
  alertOffer(discordId: string, offer: Recommendation, robloxId: number): string {
    const now = Date.now();
    for (const [token, alert] of this.alertOffers) if (now - alert.at > Bot.RESULT_TTL) this.alertOffers.delete(token);
    const mine = [...this.alertOffers].filter(([, alert]) => alert.discordId === discordId);
    for (const [token] of mine.slice(0, Math.max(0, mine.length - (Bot.ALERTS_PER_USER - 1)))) this.alertOffers.delete(token);
    const token = randomBytes(16).toString('hex');
    this.alertOffers.set(token, { offer, discordId, robloxId, at: now });
    return token;
  }
  /**
   * Sets the find panel's targets (upgrade) or give-aways (downgrade) from typed names/acronyms/IDs (comma separated).
   * Ambiguous entries get a pick list whose choice is appended to the items resolved so far; `append` adds to the
   * existing list instead of replacing it. Downgrade give-aways must each be an available copy the user owns.
   */
  private async setTarget(user: UserProfile, input: string, args: string[], append = false) {
    const items = (await this.search.provider.items()).data;
    const [mode = '-', results = '3', existing = '-'] = args;
    const downgrade = mode === 'downgrade';
    const base = append ? parseQuery(mode, existing, results).targetIds : [];
    const entries = entriesOf(input);
    if (!entries.length) throw new UserError('Enter at least one item.');
    if (base.length + entries.length > MAX_TARGETS) throw new UserError(`${downgrade ? 'Give away' : 'Search for'} up to ${MAX_TARGETS} items at once.`);
    const resolved: Item[] = [];
    let ambiguous: AmbiguousItemError | undefined;
    for (const entry of entries) {
      try { resolved.push(resolveItem(entry, items)); }
      catch (error) {
        if (!(error instanceof AmbiguousItemError)) throw error;
        ambiguous ??= error;
      }
    }
    // Everything unambiguous is kept, so the pick completes the list rather than restarting it.
    if (ambiguous) {
      const soFar = [...new Set([...base, ...resolved.map(r => r.id)])].slice(0, MAX_TARGETS);
      return pickItemMessage(ambiguous.query, ambiguous.matches, ['target', mode, results, soFar.length ? ids.encodeList(soFar) : '-']);
    }
    const targetIds = [...new Set([...base, ...resolved.map(r => r.id)])].slice(0, MAX_TARGETS);
    const chosen = targetIds.map(id => items.get(id)).filter((i): i is Item => Boolean(i));
    const query = { ...parseQuery(mode, '-', results), targetIds };
    if (downgrade) {
      const choices = await this.giveChoices(user);
      const missing = resolved.find(r => !choices.some(c => c.id === r.id));
      if (missing) throw new UserError(`You do not have an available copy of **${missing.name}** to give (it may be on hold, projected or not in your public inventory).`);
      return this.panel(query, user, `📤 You will give ${chosen.map(itemLabel).join(', ')}.`);
    }
    return this.panel(query, user, `🎯 Target${chosen.length > 1 ? 's' : ''} set to ${chosen.map(itemLabel).join(', ')}.`);
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
    const entries = entriesOf(input);
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
    const note = [added.length ? `⭐ Now watching ${added.map(itemLabel).join(', ')}.` : '', ...problems.map(p => `⚠️ ${p}`)].filter(Boolean).join('\n');
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
  /** The settings hub: account, filters, lists and archive coverage. */
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
    this.forgetOffers(discordId);
    // The optional form box seeds the wanted list; unmatched entries are reported, not fatal.
    const notes: string[] = [];
    if (wanted.trim()) {
      const items = (await this.search.provider.items()).data;
      const found: string[] = [], missed: string[] = [];
      for (const entry of entriesOf(wanted).slice(0, 100)) {
        try { const item = resolveItem(entry, items); user.preferences.targetIds = [...new Set([...user.preferences.targetIds, item.id])]; found.push(item.name); }
        catch (error) { missed.push(error instanceof AmbiguousItemError ? `${entry.slice(0, 30)} (did you mean ${error.matches.slice(0, 3).map(m => m.acronym || m.name).join(', ')}?)` : entry.slice(0, 30)); }
      }
      if (found.length) notes.push(`⭐ Wanted: **${found.join(', ')}**`);
      if (missed.length) notes.push(`⚠️ Not recognised as wanted items: ${missed.join(', ')} — add them later from **Edit wanted items**.`);
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
    const total = totals(priced(inventory, items.data));
    const entries = groupInventory(inventory, items.data);
    const paged = paginate(entries, page, PAGE_SIZE[view]);
    const files: AttachmentBuilder[] = [];
    if (view === 'grid') files.push(new AttachmentBuilder(await renderInventoryGrid(paged.items, await this.thumbnails(paged.items.map(e => e.assetId))), { name: 'inventory.png' }));
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
   * Runs the finder in one of its modes. The mode fixes the trade shape and the ranking; the user's own filters
   * (profit and overpay windows, per-item rules, receive range, ad age) apply on top.
   */
  private async find(i: Replyable, user: UserProfile, query: SearchQuery): Promise<void> {
    const mode = findMode(query);
    if (mode === 'downgrade' && !query.targetIds.length) throw new UserError('Pick which of your items to give away first.');
    this.cooldown(user.discordId);
    // The window is the user's own: at most the loss they accept, and any gain above it. The mode only shapes the trade and the ranking.
    const prefs = { ...user.preferences, mode: mode === 'both' ? 'any' as const : mode, maxValueGainPct: null };
    if (mode !== 'downgrade' && query.targetIds.length) prefs.targetIds = query.targetIds;
    if (mode === 'downgrade') prefs.targetIds = [];
    // The search already ranks every shape by what that shape is for, biggest items first, so no mode needs an ordering
    // of its own. Downgrade: each chosen item is its own candidate, given alone for a bundle of the seller's.
    const result = await this.search.search(user, prefs, { giveOnly: mode === 'downgrade' ? query.targetIds : undefined });
    // "Both" alternates upgrade-shaped and downgrade-shaped sellers so one shape never crowds the other out of the list.
    if (mode === 'both') result.recommendations = interleave(result.recommendations.filter(r => r.mode !== 'downgrade'), result.recommendations.filter(r => r.mode === 'downgrade'));
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
    const unverified = own.tradabilityError ?? theirs.tradabilityError;
    if (unverified) throw new UserError(unverified);
    if ([own.fetchedAt, theirs.fetchedAt, items.fetchedAt].some(at => Date.now() - at > 300_000))
      throw new UserError('An inventory or price snapshot became stale during analysis. Please retry.');
    const give = selectCopies(giveIds, priced(own, items.data)), receive = selectCopies(receiveIds, priced(theirs, items.data));
    if (!give || !receive) throw new UserError('One side lacks enough verified tradable copies, or an item is held or has no supported price.');
    return analysisMessage(evaluate(give, receive, user.preferences), partner, await this.avatar(partner.id));
  }
}

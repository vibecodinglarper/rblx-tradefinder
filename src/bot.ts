import {
  AttachmentBuilder, MessageFlags, type AutocompleteInteraction, type ChatInputCommandInteraction,
  type MessageComponentInteraction, type ModalSubmitInteraction,
} from 'discord.js';
import { effectiveValue, modeSchema, parseId, preferencesSchema, UserError, type Item, type UserProfile } from './domain.js';
import { evaluate, priced, selectCopies, totals } from './engine.js';
import { resolveItem } from './providers.js';
import {
  alertsMessage, analysisMessage, calcMessage, errorMessage, forgetMessage, helpMessage, ids, inventoryMessage, linkMessage, linkModal,
  recommendationMessage, searchMessage, settingsMessage, statusMessage, type SearchQuery,
} from './presentation.js';
import type { SearchService } from './search.js';
import type { Store } from './store.js';

type Replyable = ChatInputCommandInteraction | MessageComponentInteraction | ModalSubmitInteraction;
/** Component actions that redraw the panel they were clicked on instead of posting a new message. */
const IN_PLACE = new Set(['view', 'mode', 'projected', 'demand', 'alerts']);

export class Bot {
  private busy = new Set<string>();
  private lastSearch = new Map<string, number>();
  constructor(private store: Store, private search: SearchService) {}
  private profile(id: string): UserProfile {
    const user = this.store.get(id);
    if (!user) throw new UserError('Start with `/trade link user:<your Roblox username or ID>` or press **Link Roblox account** in `/trade help`.');
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
    const payload = errorMessage(expected ? error.message : 'The command could not be completed. Try again shortly.', expected);
    try { if (i.deferred || i.replied) await i.editReply(payload); else await i.reply({ ...payload, flags: MessageFlags.Ephemeral }); } catch { /* Interaction expired. */ }
  }
  async handle(i: ChatInputCommandInteraction): Promise<void> {
    if (i.commandName !== 'trade') return;
    if (this.busy.has(i.user.id)) { await i.reply({ ...errorMessage('Your previous command is still running.'), flags: MessageFlags.Ephemeral }); return; }
    this.busy.add(i.user.id);
    try {
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
      if (parsed.action === 'linkmodal') {
        if (!i.isModalSubmit()) await i.showModal(linkModal());
        return;
      }
      // Redraw ephemeral panels in place; DM alerts and modals always get a fresh private reply.
      const inPlace = IN_PLACE.has(parsed.action) && !i.isModalSubmit() && Boolean(i.message.flags?.has(MessageFlags.Ephemeral));
      if (inPlace) await i.deferUpdate(); else await i.deferReply({ flags: MessageFlags.Ephemeral });
      const payload = await this.act(i, parsed.action, parsed.args);
      if (payload) await i.editReply(inPlace ? { ...payload, attachments: [] } : payload);
    } catch (error) { await this.fail(i, error); }
    finally { this.busy.delete(i.user.id); }
  }
  private async act(i: MessageComponentInteraction | ModalSubmitInteraction, action: string, args: string[]) {
    if (action === 'link' && i.isModalSubmit()) return this.link(i.user.id, i.fields.getTextInputValue('user').trim());
    if (action === 'view') {
      if (args[0] === 'help') return helpMessage();
      if (args[0] === 'calc') return calcMessage();
      const user = this.profile(i.user.id);
      if (args[0] === 'settings') return settingsMessage(user, await this.itemNames());
      if (args[0] === 'status') return statusMessage(user, await this.itemNames(), await this.avatar(user.robloxId));
      if (args[0] === 'inventory') return this.inventory(user);
    }
    const user = this.profile(i.user.id);
    if (action === 'mode') { user.preferences.mode = modeSchema.parse(args[0]); this.store.save(user); return settingsMessage(user, await this.itemNames(), `Mode set to **${user.preferences.mode}**.`); }
    if (action === 'projected') { user.preferences.excludeProjected = !user.preferences.excludeProjected; this.store.save(user); return settingsMessage(user, await this.itemNames(), `Incoming projected items are now **${user.preferences.excludeProjected ? 'excluded' : 'allowed'}**.`); }
    if (action === 'demand' && i.isStringSelectMenu()) {
      user.preferences = preferencesSchema.parse({ ...user.preferences, minDemand: Number(i.values[0]) }); this.store.save(user);
      return settingsMessage(user, await this.itemNames(), `Minimum demand set to **${user.preferences.minDemand}**.`);
    }
    if (action === 'alerts') return this.setAlerts(user, args[0] === 'on');
    if (action === 'lock') {
      const next = [...new Set([...user.preferences.lockedIds, ...ids.decodeList(args[0] ?? '')])];
      if (next.length > 100) throw new UserError('Your lock list is full; remove an item first.');
      user.preferences.lockedIds = next; this.store.save(user);
      const items = await this.itemNames();
      const names = ids.decodeList(args[0] ?? '').map(id => items?.get(id)?.name ?? `item ${id}`).join(', ');
      return settingsMessage(user, items, `🔒 Locked **${names}**. Future searches and alerts will not offer them.`);
    }
    if (action === 'find') {
      const [mode = '-', target = '-', results = '3'] = args;
      await this.find(i, user, { mode: mode === '-' ? null : modeSchema.parse(mode), targetId: target === '-' ? null : ids.decode(target), results: Math.min(3, Math.max(1, Number(results) || 3)) });
      return null;
    }
    if (action === 'recheck') {
      const [partner = '', give = '', receive = ''] = args;
      return this.analyze(user, String(ids.decode(partner)), ids.decodeList(give), ids.decodeList(receive));
    }
    throw new UserError('This button is no longer supported. Run the command again.');
  }
  private async execute(i: ChatInputCommandInteraction): Promise<void> {
    const sub = i.options.getSubcommand();
    if (sub === 'help') { await i.editReply(helpMessage()); return; }
    if (sub === 'link') { await i.editReply(await this.link(i.user.id, i.options.getString('user', true))); return; }
    if (sub === 'forget') { this.store.forget(i.user.id); this.lastSearch.delete(i.user.id); await i.editReply(forgetMessage()); return; }
    const user = this.profile(i.user.id);
    if (sub === 'settings') {
      const mapping = { min_value_gain: 'minValueGainPct', min_rap_gain: 'minRapGainPct', max_overpay: 'maxOverpayPct', max_partner_loss: 'maxPartnerLossPct', max_rap_value_ratio: 'maxRapValueRatio' } as const;
      const updated = { ...user.preferences };
      let changed = false;
      for (const [option, key] of Object.entries(mapping)) { const value = i.options.getNumber(option); if (value !== null) { updated[key] = value; changed = true; } }
      const mode = i.options.getString('mode'); if (mode) { updated.mode = modeSchema.parse(mode); changed = true; }
      const demand = i.options.getInteger('min_demand'); if (demand !== null) { updated.minDemand = demand; changed = true; }
      const age = i.options.getInteger('max_ad_age'); if (age !== null) { updated.maxAdAgeMinutes = age; changed = true; }
      const exclude = i.options.getBoolean('exclude_projected'); if (exclude !== null) { updated.excludeProjected = exclude; changed = true; }
      user.preferences = preferencesSchema.parse(updated); this.store.save(user);
      await i.editReply(settingsMessage(user, await this.itemNames(), changed ? '✅ Filters updated.' : undefined)); return;
    }
    if (['watch', 'unwatch', 'lock', 'unlock'].includes(sub)) {
      const input = i.options.getString('item', true);
      const key = sub === 'watch' || sub === 'unwatch' ? 'targetIds' : 'lockedIds';
      const removing = sub === 'unwatch' || sub === 'unlock';
      let note: string;
      if (removing && input.toLowerCase() === 'all') { user.preferences[key] = []; note = `Cleared your ${key === 'targetIds' ? 'wanted' : 'locked'} list.`; }
      else {
        // Removal by ID still works if an item disappears from the pricing catalog.
        const item = removing && /^\d+$/.test(input) ? null : resolveItem(input, (await this.search.provider.items()).data);
        const itemId = item?.id ?? parseId(input);
        const next = removing ? user.preferences[key].filter(id => id !== itemId) : [...new Set([...user.preferences[key], itemId])];
        if (next.length > (key === 'targetIds' ? 20 : 100)) throw new UserError('This list is full; remove an item first.');
        user.preferences[key] = next;
        const name = item?.name ?? `item ${itemId}`;
        note = removing ? `Removed **${name}**.` : key === 'targetIds' ? `⭐ Now watching **${name}**.` : `🔒 Locked **${name}**; it will never be offered.`;
      }
      this.store.save(user); await i.editReply(settingsMessage(user, await this.itemNames(), note)); return;
    }
    if (sub === 'alerts') { await i.editReply(this.setAlerts(user, i.options.getBoolean('enabled', true))); return; }
    if (sub === 'status') { await i.editReply(statusMessage(user, await this.itemNames(), await this.avatar(user.robloxId))); return; }
    if (sub === 'inventory') { await i.editReply(await this.inventory(user)); return; }
    if (sub === 'find') {
      const mode = i.options.getString('mode'), target = i.options.getString('target');
      await this.find(i, user, {
        mode: mode ? modeSchema.parse(mode) : null,
        targetId: target ? resolveItem(target, (await this.search.provider.items()).data).id : null,
        results: i.options.getInteger('results') ?? 3,
      });
      return;
    }
    if (sub === 'analyze') {
      const parseSide = (s: string) => {
        const list = s.split(/[\s,]+/).filter(Boolean).map(parseId);
        if (!list.length || list.length > 4) throw new UserError('Enter 1–4 item IDs per side. Repeat an ID to include multiple owned copies.');
        return list;
      };
      await i.editReply(await this.analyze(user, i.options.getString('partner', true), parseSide(i.options.getString('give', true)), parseSide(i.options.getString('receive', true))));
      return;
    }
    throw new UserError('Unknown command. Use /trade help.');
  }
  private async link(discordId: string, input: string) {
    const roblox = await this.search.provider.user(input);
    const inventory = await this.search.provider.inventory(roblox.id);
    this.store.link(discordId, roblox.id, roblox.name);
    return linkMessage(roblox, inventory.holdings.length, await this.avatar(roblox.id));
  }
  private setAlerts(user: UserProfile, enabled: boolean) {
    user.alerts = enabled; user.alertError = null; this.store.save(user);
    return alertsMessage(user);
  }
  private async inventory(user: UserProfile) {
    const [inventory, items] = await Promise.all([this.search.provider.inventory(user.robloxId), this.search.provider.items()]);
    const available = priced(inventory, items.data, user.preferences.lockedIds);
    const total = totals(available);
    const csv = ['item_id,copy_id,name,rolimons_value,rap,effective_value,on_hold,locked', ...inventory.holdings.map(h => {
      const item = items.data.get(h.assetId);
      const name = item?.name ?? 'Unsupported item';
      // Quote CSV cells and prevent spreadsheet formula execution from remote names.
      const safeName = /^[=+@\-\t\r]/.test(name) ? `'${name}` : name;
      return [h.assetId, h.userAssetId, `"${safeName.replaceAll('"', '""')}"`, item?.value ?? '', item?.rap ?? '', item ? effectiveValue(item) : '', h.onHold, user.preferences.lockedIds.includes(h.assetId)].join(',');
    })].join('\n');
    return { ...inventoryMessage(user, { copies: inventory.holdings.length, available, value: total.value, rap: total.rap }, await this.avatar(user.robloxId)), files: [new AttachmentBuilder(Buffer.from(csv), { name: 'inventory.csv' })] };
  }
  private cooldown(discordId: string): void {
    const last = this.lastSearch.get(discordId) ?? 0;
    if (Date.now() - last < 30_000) throw new UserError(`Please wait ${Math.ceil((30_000 - (Date.now() - last)) / 1000)} more seconds between searches or analyses.`);
    this.lastSearch.set(discordId, Date.now());
    // Keep the cooldown map bounded for long-running public bots.
    for (const [id, at] of this.lastSearch) if (Date.now() - at > 60_000) this.lastSearch.delete(id);
  }
  private async find(i: Replyable, user: UserProfile, query: SearchQuery): Promise<void> {
    this.cooldown(user.discordId);
    const prefs = { ...user.preferences };
    if (query.mode) prefs.mode = query.mode;
    let targetName: string | undefined;
    if (query.targetId) { prefs.targetIds = [query.targetId]; targetName = (await this.itemNames())?.get(query.targetId)?.name; }
    const result = await this.search.search(user, prefs);
    await i.editReply(searchMessage(result, query, targetName));
    for (const r of result.recommendations.slice(0, query.results)) await i.followUp({ ...recommendationMessage(r, { avatar: await this.avatar(r.ad.userId) }), flags: MessageFlags.Ephemeral });
  }
  private async analyze(user: UserProfile, partnerInput: string, giveIds: number[], receiveIds: number[]) {
    this.cooldown(user.discordId);
    const partner = await this.search.provider.user(partnerInput);
    if (partner.id === user.robloxId) throw new UserError('Choose a different trade partner.');
    const [own, theirs, items] = await Promise.all([this.search.provider.inventory(user.robloxId), this.search.provider.inventory(partner.id), this.search.provider.items()]);
    if ([own.fetchedAt, theirs.fetchedAt, items.fetchedAt].some(at => Date.now() - at > 300_000))
      throw new UserError('An inventory or price snapshot became stale during analysis. Please retry.');
    const give = selectCopies(giveIds, priced(own, items.data)), receive = selectCopies(receiveIds, priced(theirs, items.data));
    if (!give || !receive) throw new UserError('One side lacks enough available copies, or an item is held or has no supported price.');
    return analysisMessage(evaluate(give, receive, user.preferences), partner, await this.avatar(partner.id));
  }
}

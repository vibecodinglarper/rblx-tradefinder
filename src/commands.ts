import { SlashCommandBuilder } from 'discord.js';

/**
 * Every command is top level and runs with no options. Each one opens a private interactive panel (buttons, select
 * menus and pop-up forms) so nothing has to be typed on the command line. `/trade` is the finder itself.
 */
const command = (name: string, description: string) => new SlashCommandBuilder().setName(name).setDescription(description).toJSON();
export const commandJSON = [
  command('trade', '🔎 Find trades: pick a mode and target, search recent trade ads, then place an offer'),
  command('help', '👋 What the bot does and how to get started'),
  command('connect', '🔐 Connect your Roblox session privately to send trades'),
  command('disconnect', '🔓 Remove your saved Roblox session and stop bot trade sending'),
  command('link', '🔗 Track a public Roblox inventory (no password or cookie needed)'),
  command('profit', '💰 Set how much profit or loss you are willing to take on a trade'),
  command('watch', '⭐ Manage the wanted items used by searches and alerts'),
  command('alerts', '🔔 Turn personal trade recommendation DMs on or off'),
  command('settings', '⚙️ Account, filters, wanted list and archive coverage'),
  command('inventory', '🎒 Show your available items and their Rolimons value/RAP'),
  command('delete', '🗑️ Delete your tracked account, settings and alert history'),
];
/** Names the router answers to; anything else belongs to another bot in the same server. */
export const COMMAND_NAMES = new Set(commandJSON.map(c => c.name));

import { SlashCommandBuilder } from 'discord.js';

/**
 * Every subcommand runs with no options. Each one opens a private interactive panel (buttons, select menus and
 * pop-up forms) so nothing has to be typed on the command line.
 */
export const tradeCommand = new SlashCommandBuilder().setName('trade').setDescription('Find and evaluate Roblox limited item trades')
  .addSubcommand(s => s.setName('help').setDescription('👋 What the bot does and how to get started'))
  .addSubcommand(s => s.setName('link').setDescription('🔗 Track a public Roblox inventory (no password or cookie needed)'))
  .addSubcommand(s => s.setName('find').setDescription('🔎 Pick a mode and target, then search recent trade ads for offers'))
  .addSubcommand(s => s.setName('profit').setDescription('💰 Set how much profit or loss you are willing to take on a trade'))
  .addSubcommand(s => s.setName('watch').setDescription('⭐ Manage the wanted items used by searches and alerts'))
  .addSubcommand(s => s.setName('alerts').setDescription('🔔 Turn personal trade recommendation DMs on or off'))
  .addSubcommand(s => s.setName('settings').setDescription('⚙️ Account, alerts, mode, demand and your wanted list'))
  .addSubcommand(s => s.setName('inventory').setDescription('🎒 Show your available items and their Rolimons value/RAP'))
  .addSubcommand(s => s.setName('delete').setDescription('🗑️ Delete your tracked account, settings and alert history'));

export const commandJSON = [tradeCommand.toJSON()];

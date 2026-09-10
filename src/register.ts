import { REST, Routes } from 'discord.js';
import { commandJSON } from './commands.js';
import { config } from './config.js';

try {
  const env = config();
  const rest = new REST({ version: '10' }).setToken(env.DISCORD_TOKEN);
  const route = env.DISCORD_GUILD_ID ? Routes.applicationGuildCommands(env.DISCORD_CLIENT_ID, env.DISCORD_GUILD_ID) : Routes.applicationCommands(env.DISCORD_CLIENT_ID);
  await rest.put(route, { body: commandJSON });
  console.log(`Registered /trade ${env.DISCORD_GUILD_ID ? 'in the configured server' : 'globally'}.`);
} catch {
  console.error('Command registration failed. Check DISCORD_TOKEN, DISCORD_CLIENT_ID and DISCORD_GUILD_ID in .env; ensure the bot is installed in the server.');
  process.exitCode = 1;
}

import { REST, Routes } from 'discord.js';
import { commandJSON } from './commands.js';
import { config } from './config.js';

try {
  const env = config();
  const rest = new REST({ version: '10' }).setToken(env.DISCORD_TOKEN);
  const global = Routes.applicationCommands(env.DISCORD_CLIENT_ID);
  if (env.DISCORD_GUILD_ID) {
    // Registering in one server while a global copy still exists makes every command show up twice, so clear the global scope.
    await rest.put(Routes.applicationGuildCommands(env.DISCORD_CLIENT_ID, env.DISCORD_GUILD_ID), { body: commandJSON });
    await rest.put(global, { body: [] });
    console.log('Registered /trade in the configured server and removed any global copy.');
  } else {
    await rest.put(global, { body: commandJSON });
    console.log('Registered /trade globally. If it appears twice in a server, set DISCORD_GUILD_ID and register again, or remove the server-scoped copy.');
  }
} catch {
  console.error('Command registration failed. Check DISCORD_TOKEN, DISCORD_CLIENT_ID and DISCORD_GUILD_ID in .env; ensure the bot is installed in the server.');
  process.exitCode = 1;
}

import { Client, Events, GatewayIntentBits } from 'discord.js';
import { config } from './config.js';
import { Providers } from './providers.js';
import { SearchService } from './search.js';
import { Store } from './store.js';
import { Bot } from './bot.js';
import { Monitor } from './monitor.js';
import { recommendationMessage } from './presentation.js';

async function main() {
  const env = config();
  const store = new Store(env.DATABASE_PATH);
  const client = new Client({ intents: [GatewayIntentBits.Guilds], allowedMentions: { parse: [] } });
  const providers = new Providers();
  const search = new SearchService(providers, env.MAX_SELLERS_PER_SEARCH);
  const bot = new Bot(store, search);
  const monitor = new Monitor(store, search, async (id, r) => {
    const user = await client.users.fetch(id);
    const avatar = await providers.avatar(r.ad.userId).catch(() => null);
    await user.send(recommendationMessage(r, { alert: true, avatar }));
  }, env.POLL_INTERVAL_SECONDS * 1000);
  client.once(Events.ClientReady, ready => { console.log(`Tradefinder connected as ${ready.user.tag}`); monitor.start(); });
  client.on(Events.InteractionCreate, interaction => {
    const task = interaction.isAutocomplete() ? bot.autocomplete(interaction) : interaction.isChatInputCommand() ? bot.handle(interaction)
      : interaction.isMessageComponent() || interaction.isModalSubmit() ? bot.component(interaction) : undefined;
    void task?.catch(error => console.error('Interaction error:', error instanceof Error ? error.name : 'Unknown error'));
  });
  client.on(Events.Error, error => console.error('Discord client error:', error.name));
  let closing = false;
  const stop = async () => {
    if (closing) return;
    closing = true;
    console.log('Stopping trade monitor…');
    await monitor.stop();
    client.destroy(); store.close();
    process.exit(0);
  };
  process.once('SIGINT', () => { void stop(); }); process.once('SIGTERM', () => { void stop(); });
  try { await client.login(env.DISCORD_TOKEN); }
  catch { await monitor.stop(); client.destroy(); store.close(); throw new Error('Discord login failed. Check DISCORD_TOKEN in .env.'); }
}
void main().catch(error => {
  // Do not dump request objects, environment variables or authentication headers.
  console.error(error instanceof Error ? error.message : 'Startup failed.');
  process.exitCode = 1;
});

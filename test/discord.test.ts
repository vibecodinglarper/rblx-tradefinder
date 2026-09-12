import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commandJSON } from '../src/commands.js';
import { alertMessage, recommendationMessage } from '../src/presentation.js';
import { SearchService } from '../src/search.js';
import { fixtureProvider, profile } from './fixtures.js';

test('slash command definition is valid and within Discord limits', () => {
  assert.deepEqual(commandJSON.map(c => c.name), ['trade', 'connect', 'disconnect', 'find']);
  assert.equal(commandJSON.find(c => c.name === 'find')?.options?.[0]?.name, 'trades');
  assert.ok(commandJSON[0]!.options!.length <= 25);
  const names = commandJSON[0]!.options!.map(o => o.name);
  for (const expected of ['link', 'inventory', 'find', 'profit', 'settings', 'watch', 'alerts', 'delete']) assert.ok(names.includes(expected));
  // Every subcommand runs bare: no typed options, so each one opens a panel or form instead.
  for (const sub of commandJSON[0]!.options!) assert.equal((sub as { options?: unknown[] }).options?.length ?? 0, 0, `${sub.name} should take no options`);
});
test('recommendation embeds contain calculations, unique copies and valid profile links within Discord limits', async () => {
  const result = await new SearchService(fixtureProvider()).search(profile());
  const message = recommendationMessage(result.recommendations[0]!);
  const embed = message.embeds[0]!.toJSON(); const fields = embed.fields!;
  const text = fields.map(f => f.value).join('\n');
  assert.match(text, /Copy 100/); assert.match(text, /110 received − 100 given/);
  assert.match(embed.description!, /Exact advertised/);
  // Avatars are optional decoration: absent without a lookup, present (and only as https) when supplied.
  assert.equal(embed.thumbnail, undefined); assert.equal(embed.author?.icon_url, undefined);
  const withAvatar = recommendationMessage(result.recommendations[0]!, { avatar: 'https://tr.rbxcdn.com/x.png' }).embeds[0]!.toJSON();
  assert.equal(withAvatar.thumbnail?.url, 'https://tr.rbxcdn.com/x.png'); assert.equal(withAvatar.author?.icon_url, 'https://tr.rbxcdn.com/x.png');
  assert.ok(fields.length <= 25); assert.ok(fields.every(f => f.value.length <= 1024));
  const length = (embed.title?.length ?? 0) + (embed.description?.length ?? 0) + (embed.footer?.text.length ?? 0) + fields.reduce((n, f) => n + f.name.length + f.value.length, 0);
  assert.ok(length < 6000);
  const [linksRow, actionsRow] = message.components.map(c => c.toJSON());
  assert.ok(linksRow!.components.every(b => 'url' in b && b.url.startsWith('https://')));
  assert.ok(actionsRow!.components.every(b => 'custom_id' in b && b.custom_id.startsWith('tf:') && b.custom_id.length <= 100));
  assert.equal(actionsRow!.components.length, 1);
  assert.equal(recommendationMessage(result.recommendations[0]!, { alert: true }).components[1]!.toJSON().components.length, 2);
  assert.deepEqual(message.allowedMentions.parse, []);
  // Alert DMs use the trade finder's card layout: image plus seller line, with the trade link and Re-check / Stop alerts buttons.
  const alert = alertMessage(result.recommendations[0]!, { card: true, character: 'https://tr.rbxcdn.com/c.png' });
  const alertEmbed = alert.embeds[0]!.toJSON();
  assert.equal(alertEmbed.image?.url, 'attachment://trade-1.png'); assert.equal(alertEmbed.thumbnail?.url, 'https://tr.rbxcdn.com/c.png');
  assert.match(alertEmbed.title!, /🔔 🟢 \+10 value \(\+10%\)/); assert.match(alertEmbed.description!, /Open the trade window with ExampleSeller/);
  assert.match(alertEmbed.fields?.[0]?.name ?? '', /Tradability checked/);
  assert.match(JSON.stringify(alertMessage(result.recommendations[0]!).embeds[0]!.toJSON()), /✅ Tradable/);
  const [alertLinks, alertActions] = alert.components.map(c => c.toJSON());
  assert.ok(alertLinks!.components.every(b => 'url' in b && b.url.includes('/trade#tradefinder')));
  assert.deepEqual(alertActions!.components.map(b => ('custom_id' in b ? b.custom_id.split(':')[1] : '')), ['alerts']);
  assert.ok(alertMessage(result.recommendations[0]!).embeds[0]!.toJSON().fields?.some(f => f.name === '📤 You give'));
});

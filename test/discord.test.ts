import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commandJSON } from '../src/commands.js';
import { alertMessage, analysisMessage } from '../src/presentation.js';
import { SearchService } from '../src/search.js';
import { fixtureProvider, profile } from './fixtures.js';

test('slash command definition is flat, valid and within Discord limits', () => {
  assert.deepEqual(commandJSON.map(c => c.name), ['trade', 'help', 'connect', 'disconnect', 'link', 'profit', 'watch', 'alerts', 'settings', 'inventory', 'delete']);
  // `/trade` is the finder and the only command with "trade" in its name; every command runs bare, with no subcommands or options.
  assert.deepEqual(commandJSON.filter(c => c.name.includes('trade')).map(c => c.name), ['trade']);
  for (const c of commandJSON) { assert.equal(c.options?.length ?? 0, 0, `${c.name} should take no options`); assert.ok(c.description.length <= 100); }
  assert.ok(commandJSON.length <= 100);
});
test('exchange embeds contain calculations, unique copies and valid links within Discord limits', async () => {
  const result = await new SearchService(fixtureProvider()).search(profile());
  const r = result.recommendations[0]!; const partner = { id: r.ad.userId, name: r.ad.username };
  // Re-check draws the full maths of one exchange: both sides copy by copy, then the value, RAP and balance tiles.
  const message = analysisMessage(r, partner);
  const embed = message.embeds[0]!.toJSON(); const fields = embed.fields!;
  const text = fields.map(f => f.value).join('\n');
  assert.match(text, /Copy 100/); assert.match(text, /110 received − 100 given/);
  // Avatars are optional decoration: absent without a lookup, present (and only as https) when supplied.
  assert.equal(embed.thumbnail, undefined); assert.equal(embed.author?.icon_url, undefined);
  const withAvatar = analysisMessage(r, partner, 'https://tr.rbxcdn.com/x.png').embeds[0]!.toJSON();
  assert.equal(withAvatar.thumbnail?.url, 'https://tr.rbxcdn.com/x.png'); assert.equal(withAvatar.author?.icon_url, 'https://tr.rbxcdn.com/x.png');
  assert.ok(fields.length <= 25); assert.ok(fields.every(f => f.value.length <= 1024));
  const length = (embed.title?.length ?? 0) + (embed.description?.length ?? 0) + (embed.footer?.text.length ?? 0) + fields.reduce((n, f) => n + f.name.length + f.value.length, 0);
  assert.ok(length < 6000);
  const [linksRow, actionsRow] = message.components.map(c => c.toJSON());
  assert.ok(linksRow!.components.every(b => 'url' in b && b.url.startsWith('https://')));
  assert.ok(actionsRow!.components.every(b => 'custom_id' in b && b.custom_id.startsWith('tf:') && b.custom_id.length <= 100));
  assert.equal(actionsRow!.components.length, 1);
  assert.deepEqual(message.allowedMentions.parse, []);
  // Alert DMs use the trade finder's card layout: image plus seller line, the trade-window link as a button (never repeated
  // in the text), when tradability was checked, and Stop alerts.
  const alert = alertMessage(r, { card: true, character: 'https://tr.rbxcdn.com/c.png' });
  const alertEmbed = alert.embeds[0]!.toJSON();
  assert.equal(alertEmbed.image?.url, 'attachment://trade-1.png'); assert.equal(alertEmbed.thumbnail?.url, 'https://tr.rbxcdn.com/c.png');
  assert.match(alertEmbed.title!, /🔔 🟢 \+10 value \(\+10%\)/); assert.match(alertEmbed.description!, /\*\*ExampleSeller\*\* · \[Profile\]/);
  assert.doesNotMatch(alertEmbed.description!, /Open the trade window/);
  assert.match(alertEmbed.fields?.[0]?.name ?? '', /Tradability checked/);
  assert.doesNotMatch(JSON.stringify(alertMessage(r).embeds[0]!.toJSON()), /Tradable/);
  const [alertLinks, alertActions] = alert.components.map(c => c.toJSON());
  assert.ok(alertLinks!.components.every(b => 'url' in b && b.url.includes('/trade#tradefinder')));
  assert.deepEqual(alertActions!.components.map(b => ('custom_id' in b ? b.custom_id.split(':')[1] : '')), ['alerts']);
  assert.ok(alertMessage(r).embeds[0]!.toJSON().fields?.some(f => f.name === '📤 You give'));
  // With a token the DM carries a Place Trade button whose custom ID decodes to that token, next to Stop alerts.
  const token = 'c'.repeat(32);
  const placeable = alertMessage(r, { placeToken: token });
  const actions = placeable.components[1]!.toJSON().components;
  assert.deepEqual(actions.map(b => ('custom_id' in b ? b.custom_id : '')), [`tf:placealert:${token}`, 'tf:alerts:off']);
  assert.ok(actions.every(b => !('custom_id' in b) || b.custom_id.length <= 100));
  assert.match(placeable.embeds[0]!.toJSON().description!, /Place Trade.*\/connect/);
});

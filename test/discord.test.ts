import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commandJSON } from '../src/commands.js';
import { recommendationMessage } from '../src/presentation.js';
import { SearchService } from '../src/search.js';
import { fixtureProvider, profile } from './fixtures.js';

test('slash command definition is valid and within Discord limits', () => {
  assert.equal(commandJSON.length, 1); assert.equal(commandJSON[0]?.name, 'trade');
  assert.ok(commandJSON[0]!.options!.length <= 25);
  const names = commandJSON[0]!.options!.map(o => o.name);
  for (const expected of ['link', 'inventory', 'find', 'analyze', 'settings', 'watch', 'lock', 'alerts', 'forget']) assert.ok(names.includes(expected));
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
  assert.equal(actionsRow!.components.length, 2);
  assert.equal(recommendationMessage(result.recommendations[0]!, { alert: true }).components[1]!.toJSON().components.length, 3);
  assert.deepEqual(message.allowedMentions.parse, []);
});

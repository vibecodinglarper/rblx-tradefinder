/**
 * Renders every bot panel to Discord-styled HTML using synthetic fixture data, then `scripts/screenshot.py`
 * captures them as PNGs for the README. No Discord token or live API is used.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import type { APIActionRowComponent, APIComponentInMessageActionRow, APIEmbed } from 'discord.js';
import { defaults, type Inventory, type Item, type TradeAd, type UserProfile } from '../src/domain.js';
import { Providers, type DataProvider } from '../src/providers.js';
import { SearchService } from '../src/search.js';
import { evaluate, priced, selectCopies } from '../src/engine.js';
import { groupInventory } from '../src/inventory.js';
import {
  alertMessage, alertsMessage, analysisMessage, errorMessage, helpMessage, inventoryMessage, linkMessage, profitMessage, settingsMessage, tradeListMessage,
} from '../src/presentation.js';

const item = (id: number, name: string, acronym: string, value: number | null, rap: number, extra: Partial<Item> = {}): Item =>
  ({ id, name, acronym, value, rap, demand: 2, trend: 2, projected: false, hyped: false, rare: false, ...extra });
const items = new Map([
  item(1029025, 'Sparkle Time Fedora', 'STF', 165_000, 158_400, { demand: 3, trend: 3 }),
  item(1031429, 'Clockwork\'s Headphones', 'CH', 130_000, 127_200, { demand: 3 }),
  item(1365767, 'Valkyrie Helm', 'Valk', 310_000, 305_100, { demand: 4, trend: 3 }),
  item(21070012, 'Blackvalk', 'BV', 250_000, 244_000, { demand: 3 }),
  item(1235488, 'Red Sparkle Time Fedora', 'RSTF', null, 96_000, { demand: 1, projected: true }),
  item(16630147, 'Deadly Dark Dominus', 'DDD', 900_000, 905_000, { demand: 4, rare: true }),
].map(i => [i.id, i]));
const inventory = (userId: number, ids: number[]): Inventory => ({ userId, holdings: ids.map((assetId, i) => ({ assetId, userAssetId: userId * 1000 + i, onHold: false, tradable: true })), fetchedAt: Date.now() - 40_000 });
const ad: TradeAd = { id: 48211397, userId: 2, username: 'LimitedFlipper', createdAt: Date.now() - 6 * 60_000, offering: [1365767], requesting: [1029025, 1031429], tags: [], offeringRobux: 0, requestingRobux: 0 };
const provider: DataProvider = {
  async items() { return { data: items, fetchedAt: Date.now() - 20_000 }; },
  async ads() { return { data: [ad], fetchedAt: Date.now() }; },
  async inventory(id) { return id === 1 ? inventory(1, [1029025, 1031429, 21070012, 1235488]) : inventory(2, [1365767, 16630147]); },
  async user(input) { return { id: Number(input) || 2, name: 'LimitedFlipper' }; },
};
const user: UserProfile = { discordId: '1', robloxId: 1, username: 'AsherTrades', preferences: { ...defaults(), mode: 'upgrade', targetIds: [1365767, 16630147] }, alerts: true, alertError: null, inventoryAlerts: true };

// Real avatars make the mock faithful; fall back to a generated placeholder when offline.
const placeholder = (label: string, color: string) => `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="150" height="150"><rect width="150" height="150" rx="16" fill="${color}"/><text x="75" y="95" font-family="sans-serif" font-size="64" font-weight="700" fill="#fff" text-anchor="middle">${label}</text></svg>`)}`;
const avatarOf = async (id: number, label: string, color: string) => (await new Providers().avatar(id).catch(() => null)) ?? placeholder(label, color);
const [ownAvatar, partnerAvatar] = await Promise.all([avatarOf(1, 'A', '#5865f2'), avatarOf(156, 'L', '#eb459e')]);
const result = await new SearchService(provider).search(user);
const rec = result.recommendations[0]!;
const own = priced(await provider.inventory(1), items), theirs = priced(await provider.inventory(2), items);
const failing = evaluate(selectCopies([1029025], own)!, selectCopies([16630147], theirs)!, user.preferences);
const panels: Record<string, { embeds: { toJSON(): APIEmbed }[]; components: { toJSON(): APIActionRowComponent<APIComponentInMessageActionRow> }[]; files?: unknown[] }> = {
  help: helpMessage(),
  link: linkMessage({ id: 1, name: 'AsherTrades' }, 4, ownAvatar),
  profit: profitMessage(user, items, '✅ Profit filters updated.'),
  settings: settingsMessage(user, items, ownAvatar),
  inventory: { ...inventoryMessage(user, { view: 'text', page: 0, pages: 1, entries: groupInventory(inventory(1, [1029025, 1031429, 21070012, 1235488]), items), total: 4, copies: 4, value: 391_000, rap: 381_600 }, ownAvatar), files: [1] },
  search: tradeListMessage(result, { mode: 'upgrade', targetIds: [1365767], results: 3 }, { items, characters: new Map([[rec.ad.userId, partnerAvatar]]) }),
  recommendation: alertMessage(rec, { character: partnerAvatar }),
  analyze: analysisMessage(failing, { id: 2, name: 'LimitedFlipper' }, partnerAvatar),
  alerts: alertsMessage(user),
  error: { embeds: [...(errorMessage('Please wait 12 more seconds between searches or analyses.').embeds as { toJSON(): APIEmbed }[])], components: [] },
};

// ---------- Discord-style rendering ----------
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const relative = (ts: number) => { const m = Math.round((Date.now() / 1000 - ts) / 60); return m < 1 ? 'just now' : m === 1 ? '1 minute ago' : m < 60 ? `${m} minutes ago` : `${Math.round(m / 60)} hours ago`; };
function md(s: string): string {
  return esc(s)
    .replace(/```\n?([\s\S]*?)```/g, (_, c) => `<pre>${c.trim()}</pre>`)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\\\*/g, '*')
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/&lt;t:(\d+):R&gt;/g, (_, ts) => `<span class="ts">${relative(Number(ts))}</span>`)
    .replace(/\n/g, '<br>');
}
const hex = (n?: number) => `#${(n ?? 0x2b2d31).toString(16).padStart(6, '0')}`;
function embedHtml(e: APIEmbed): string {
  const all = e.fields ?? [];
  const spans: number[] = [];
  for (let i = 0; i < all.length; i++) {
    if (!all[i]!.inline) { spans.push(12); continue; }
    let n = 0; while (all[i + n]?.inline && n < 3) n++;
    for (let k = 0; k < n; k++) spans.push(12 / n);
    i += n - 1;
  }
  const fields = all.map((f, i) => `<div class="field" style="grid-column:span ${spans[i]}"><div class="fname">${md(f.name)}</div><div class="fvalue">${md(f.value)}</div></div>`).join('');
  return `<div class="embed" style="border-left-color:${hex(e.color)}">
    <div class="embed-body">
      ${e.author ? `<div class="author">${e.author.icon_url ? `<img src="${e.author.icon_url}" onerror="this.style.display='none'">` : ''}<span>${esc(e.author.name)}</span></div>` : ''}
      ${e.title ? `<div class="title">${md(e.title)}</div>` : ''}
      ${e.description ? `<div class="desc">${md(e.description)}</div>` : ''}
      <div class="fields">${fields}</div>
      ${e.footer ? `<div class="footer">${esc(e.footer.text)}${e.timestamp ? ` • ${new Date(e.timestamp).toLocaleString('en-US', { hour: 'numeric', minute: '2-digit' })}` : ''}</div>` : ''}
    </div>
    ${e.thumbnail ? `<img class="thumb" src="${e.thumbnail.url}" onerror="this.style.display='none'">` : ''}
  </div>`;
}
const STYLE: Record<number, string> = { 1: 'primary', 2: 'secondary', 3: 'success', 4: 'danger', 5: 'link' };
function rowHtml(r: APIActionRowComponent<APIComponentInMessageActionRow>): string {
  const parts = r.components.map(c => {
    if (c.type === 2) {
      const b = c as { style: number; disabled?: boolean; emoji?: { name?: string }; label?: string };
      return `<button class="btn ${STYLE[b.style]}${b.disabled ? ' disabled' : ''}">${b.emoji?.name ? `<span class="emoji">${b.emoji.name}</span>` : ''}${esc(b.label ?? '')}${b.style === 5 ? '<span class="ext">↗</span>' : ''}</button>`;
    }
    if (c.type === 3) { const d = c.options.find(o => o.default); return `<div class="select">${d?.emoji?.name ? `<span class="emoji">${d.emoji.name}</span>` : ''}${esc(d?.label ?? c.placeholder ?? 'Select')}<span class="chev">⌄</span></div>`; }
    return '';
  }).join('');
  return `<div class="row">${parts}</div>`;
}
const page = (p: (typeof panels)[string]) => `<!doctype html><html><head><meta charset="utf-8"><style>
  body{margin:0;background:#313338;font-family:"gg sans","Noto Sans","Segoe UI",Helvetica,Arial,sans-serif;color:#dbdee1;font-size:15px;line-height:1.375}
  .msg{display:flex;gap:16px;padding:18px 24px 20px 20px;width:640px}
  .avatar{width:40px;height:40px;border-radius:50%;background:#5865f2;display:flex;align-items:center;justify-content:center;font-size:22px;flex:none}
  .meta{display:flex;align-items:center;gap:6px;margin-bottom:6px}.name{font-weight:600;color:#f2f3f5}
  .app{background:#5865f2;color:#fff;font-size:10px;font-weight:600;padding:1px 4px;border-radius:3px;vertical-align:middle}
  .eph{color:#949ba4;font-size:12px}.eph b{color:#00a8fc;font-weight:500}
  .embed{display:flex;background:#2b2d31;border-left:4px solid;border-radius:4px;padding:10px 16px 12px 12px;max-width:520px;margin-top:4px}
  .embed-body{flex:1;min-width:0}.thumb{width:80px;height:80px;border-radius:6px;margin-left:16px;flex:none;object-fit:cover;background:#1e1f22}
  .author{display:flex;align-items:center;gap:8px;font-weight:600;font-size:14px;color:#f2f3f5;margin-bottom:6px}.author img{width:24px;height:24px;border-radius:50%}
  .title{font-weight:600;color:#f2f3f5;font-size:16px;margin-bottom:6px}.desc{font-size:14px;margin-bottom:6px}
  .fields{display:grid;grid-template-columns:repeat(12,1fr);gap:8px;margin-top:6px}.field{font-size:14px;min-width:0}
  img.emoji{height:1.15em;width:1.15em;vertical-align:-0.2em}
  .fname{font-weight:600;color:#f2f3f5;margin-bottom:2px}.fvalue{color:#dbdee1;word-wrap:break-word}
  .footer{font-size:12px;color:#949ba4;margin-top:10px}
  a{color:#00a8fc;text-decoration:none}code{background:#1e1f22;padding:1px 4px;border-radius:3px;font-size:13px;font-family:Consolas,"Courier New",monospace}
  pre{background:#1e1f22;border:1px solid #232428;border-radius:4px;padding:8px;font-size:12.5px;font-family:Consolas,"Courier New",monospace;white-space:pre;margin:4px 0}
  .ts{background:#3f4147;padding:0 2px;border-radius:3px}
  .row{display:flex;gap:8px;margin-top:8px;flex-wrap:wrap}
  .btn{border:0;border-radius:3px;padding:2px 16px;height:32px;font-size:14px;font-weight:500;color:#fff;display:inline-flex;align-items:center;gap:6px;font-family:inherit}
  .primary{background:#5865f2}.secondary{background:#4e5058}.success{background:#248046}.danger{background:#da373c}.link{background:#4e5058}
  .disabled{opacity:.5}.ext{font-size:12px;margin-left:2px}.emoji{font-size:16px}
  .select{background:#1e1f22;border:1px solid #111214;border-radius:4px;padding:6px 10px;width:480px;font-size:14px;color:#dbdee1;display:flex;align-items:center;gap:8px;margin-top:8px}.chev{margin-left:auto;font-size:18px;color:#949ba4}
  .file{margin-top:8px;background:#2b2d31;border:1px solid #1e1f22;border-radius:4px;padding:10px;width:300px;display:flex;gap:10px;align-items:center}.file .n{color:#00a8fc}.file .s{font-size:12px;color:#949ba4}
</style></head><body><div class="msg" id="shot"><div class="avatar">📈</div><div style="min-width:0;flex:1">
  <div class="meta"><span class="name">Tradefinder</span><span class="app">APP</span></div>
  ${p.embeds.map(e => embedHtml(e.toJSON())).join('')}
  ${p.files?.length ? '<div class="file">📄<div><div class="n">inventory.csv</div><div class="s">412 bytes</div></div></div>' : ''}
  ${p.components.map(c => rowHtml(c.toJSON())).join('')}
  <div class="eph" style="margin-top:8px">👁 Only you can see this • <b>Dismiss message</b></div>
</div></div>
<script src="https://cdn.jsdelivr.net/npm/@twemoji/api@16.0.1/dist/twemoji.min.js" crossorigin="anonymous"></script>
<script>twemoji.parse(document.body, { folder: 'svg', ext: '.svg', base: 'https://cdn.jsdelivr.net/gh/jdecked/twemoji@16.0.1/assets/' }); document.title = 'ready';</script>
</body></html>`;

const dir = 'docs/screenshots/html';
mkdirSync(dir, { recursive: true });
for (const [name, p] of Object.entries(panels)) writeFileSync(`${dir}/${name}.html`, page(p));
console.log(`Wrote ${Object.keys(panels).length} panels to ${dir}. Run: python3 scripts/screenshot.py`);

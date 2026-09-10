import { Providers } from '../src/providers.js';
import { parseId } from '../src/domain.js';

// Read-only real API check. No Discord credentials, login or message sending.
const provider = new Providers();
const [items, ads] = await Promise.all([provider.items(), provider.ads()]);
console.log(`Rolimons: ${items.data.size} priced items, ${ads.data.length} recent ads parsed.`);
const userId = process.env.SMOKE_ROBLOX_ID ? parseId(process.env.SMOKE_ROBLOX_ID) : ads.data[0]?.userId;
if (!userId) throw new Error('No advertiser available to test inventory; set SMOKE_ROBLOX_ID.');
const inventory = await provider.inventory(userId);
console.log(`Roblox: complete public inventory parsed (${inventory.holdings.length} unique copies, ${inventory.holdings.filter(h => h.onHold).length} held).`);

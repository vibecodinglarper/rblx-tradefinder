# Roblox Tradefinder

A Discord bot that reads Rolimons trade ads, checks Roblox tradable inventories, and recommends limited-item exchanges you can review and send with **Place Trade** after connecting your Roblox account.

Every reply is a private, styled Discord embed with buttons. `/connect` accepts a Roblox session cookie in a private modal, verifies the account and saves the session encrypted. The bot sends an outbound trade only when you click its **Place Trade** button.

<p align="center"><img src="docs/screenshots/recommendation.png" width="640" alt="A trade recommendation card: seller avatar, give and receive columns with Rolimons links, value, RAP and balance tiles, reasoning, warnings, and buttons to open the Roblox trade, re-check the exchange or stop alerts"></p>

## Features

- **Exact ad matches and generated counteroffers** from the recent Rolimons trade-ad feed, verified against both authenticated tradable inventories, including asset and bundle copies.
- **Upgrades, downgrades and swaps** judged on value alone (RAP shown for reference), with configurable profit range, overpay, partner-loss, demand and ad-age filters; projected items are always excluded.
- **Inventory DMs** (toggle in Settings): whenever copies leave or join your public inventory — a trade completes, an item sells, you buy one — you get a card of what went out, what came in and the value gained or lost.
- **Wanted items** with per-item profit rules, a paged inventory view, and opt-in recommendation DMs deduplicated for 24 hours.
- **Interactive UI**: link your account from a form, switch mode and demand with buttons and a select menu, jump between the settings, profit and inventory panels, re-run a search, or re-check a specific exchange.
- **Transparent maths**: every card shows the totals, percentages and a heuristic ranking score, plus the caveats.

## Screenshots

Rendered from synthetic data with `npm run screenshots`; they show the real embed and component payloads the bot sends.

| `/connect` | Private session-cookie form. Verifies your identity and trade eligibility, then enables verified recommendations and Place Trade. |
| `/disconnect` | Removes the saved Roblox session and disables sending. |
| `/find trades` | Alias for `/trade find`, including numbered Place Trade buttons. |
| `/trade help` | `/trade profit` |
| --- | --- |
| ![Help panel with numbered steps and a Link Roblox account button](docs/screenshots/help.png) | ![Trade profit panel with the loss you accept, profit range, per-item rules and overpay caps](docs/screenshots/profit.png) |

| `/trade find` summary |
| --- |
| ![Search summary with target, ads screened, sellers verified and a Search again button](docs/screenshots/search.png) |

| `/trade settings` | `/trade inventory` |
| --- | --- |
| ![Settings panel with avatar, alerts, mode buttons, demand menu and wanted items](docs/screenshots/settings.png) | ![Inventory panel with copy counts, totals and a grid of items](docs/screenshots/inventory.png) |

| `/trade link` | `/trade alerts` | Calculation guide |
| --- | --- | --- |
| ![Link confirmation](docs/screenshots/link.png) | ![Alerts enabled panel](docs/screenshots/alerts.png) |

Errors and cooldowns are embeds too:

<img src="docs/screenshots/error.png" width="420" alt="Yellow warning embed asking the user to wait before searching again">

## Run locally

Requires **Node.js 24.17 or newer** and a Discord application.

1. Create an application and bot token in the [Discord Developer Portal](https://discord.com/developers/applications) → your application → Bot. Never share or commit the token.
2. Install and configure:

   ```sh
   npm ci
   cp .env.example .env
   ```

3. Edit `.env`: set `DISCORD_TOKEN` and your application's `DISCORD_CLIENT_ID`. Set `DISCORD_GUILD_ID` to your test server ID for server-scoped command registration. To enable `/connect`, generate a key with `openssl rand -hex 32` and set `ROBLOX_CREDENTIAL_KEY` to the result. Keep this key separate from the SQLite database, retain it across restarts, and keep `.env` private. Without the key, public inventory tracking still works, but tradability verification, recommendations and sending require a connection.
4. In the Developer Portal's installation settings, enable a **Guild Install** with the `bot` and `applications.commands` scopes. Install in your server. Only the Guilds gateway intent is used; no Message Content or Server Members privileged intents or Administrator permission are needed. The bot uses private command replies and personal DMs.
5. Register and start:

   ```sh
   npm run register
   npm run build
   npm start
   ```

For development use `npm run dev`. With no guild ID, `npm run register` registers global commands; they can take time to propagate. Registration replaces commands in the configured scope, so use a dedicated application. Register again when command definitions change.

The bot process must keep running for alerts. In Discord, run:

```text
/connect         → enter your Roblox session cookie in the private form
/trade link      → alternatively, track a public inventory without sending access
/trade settings  → click a mode, pick demand
/trade profit    → press ✏️ Edit profit / loss
/trade watch     → press ⭐ Add wanted item
/find trades     → choose mode and target, search, then review and click Place Trade
/trade alerts    → press 🔔 Turn alerts on
```

Make the Roblox inventory public for discovery. `/trade link` only tracks public data and does not verify ownership or authorize sending. `/connect` verifies the cookie’s authenticated identity and trading eligibility, then links that account. Switching accounts clears previous sending credentials and resets preferences and alerts.

A `.ROBLOSECURITY` cookie grants full account access. Only connect to a bot and operator you trust; Discord and the bot receive the modal submission. Never paste it into a chat message. The bot stores sessions using AES-256-GCM with account-bound authenticated encryption and never includes cookies or upstream response bodies in replies or logs. `/disconnect` removes the saved session while preserving public tracking; `/trade delete` also removes it. These commands do not cancel existing outbound trades or revoke the Roblox session itself; log out that session in Roblox settings to revoke it. Changing or losing the encryption key requires users to reconnect.

## Commands

Every command takes **no options**. Run it and a private panel appears; everything is changed by clicking buttons, choosing from select menus, or filling in a pop-up form.

| Command | What opens |
| --- | --- |
| `/trade help` | 👋 Getting-started panel with shortcut buttons to every other panel. |
| `/trade link` | 🔗 Form for a Roblox username or numeric user ID. Changing accounts resets settings and disables alerts. |
| `/trade find` | 🔎 Trade finder with three modes. **Both** (default): one search covering upgrades and downgrades, each ranked by its own rule. **Upgrade**: pick or type items you want (several at once); the bot screens every archived ad for people offering them, builds bundles of up to 4 of your items for 1 of theirs, slight losses first because sellers accept them. **Downgrade**: pick one of your items to give away; the bot screens every ad for bundles, closest to +10% first. Every mode uses your own loss floor from `/trade profit`; gains are kept to a realistic +10% unless the seller's ad asks for exactly the items you would give. In Both mode the list alternates upgrade-shaped and downgrade-shaped sellers. **Affordable** limits what you receive to the band your items can pay for (cheapest copy up to your four most valuable together); type your own value range under Filters to replace that band. Any ad offering the item counts; seller tags and requests are only hints. Projected items never take part in the maths. Results are Rolimons-style cards with numbered **Place Trade** buttons and **Trade with …** browser links. **Filters** adds a downgrade profit range and an upgrade overpay range (each side a percent or a value), the receive value range and ad age. |
| `/trade profit` | 💰 How much profit or loss you will take on a trade: the loss you accept (gains are realistic, +10% at most, unless the ad asks for your exact items), a profit range and per-item profit rules. **Edit profit / loss** opens the form. Value-based only; projected items are always excluded. |
| `/trade watch` | ⭐ Wanted items panel: add several items at once (comma separated names, acronyms or IDs), remove or clear through the menus, and set **per-item profit rules** (a profit range that applies whenever a trade brings that item in). Up to 100 wanted items, 25 rules; the remove menus take several picks at once. |
| `/trade alerts` | 🔔 Everything about DMs: toggles for recommendation and inventory alerts, how many trades each check may send, the last DM and the last alert error. |
| `/trade settings` | ⚙️ Account, ad age, receive range, profit, wanted list and archive coverage, with tabs to every panel including alerts. The username carries the Rolimons logo and links to that player's Rolimons page. |
| `/trade inventory` | 🎒 Paged grid of item squares with quantity badges, value, RAP, Tradable/Not tradable status and rare/projected/hyped/hold tags, sorted by value (Rolimons value, else Rolimons RAP, else Roblox RAP); toggle to a text list for large inventories. |
| `/trade delete` | 🗑️ Confirmation panel; only **Yes, delete everything** removes your data. |

## Interactive UI

Every form box is validated before anything is saved: a rejected entry names the box and says what it accepts; credential input is never echoed, and the stored value is left untouched. Every reply is a private embed with buttons that redraw in place. Recommendation cards carry **Open Roblox trade**, **Roblox profile** and **Rolimons player** links plus **Re-check now** (re-evaluates that exact exchange against fresh inventories) and, on alert DMs, **Stop alerts**. Result lists have numbered **Place Trade** and **Trade with …** buttons, one per seller, plus **Search again** and **Change search**. Place Trade immediately sends the displayed item quantities with **0 Robux**, using fresh available copies of each catalog item; serial-number selection is not supported. Buttons belong to one Discord user, Roblox account and search, expire after 15 minutes, and stop working after a new search, reconnect, disconnect or restart. Each panel only offers buttons that relate to it.

Registering with `DISCORD_GUILD_ID` set also clears any global registration, so `/trade` never appears twice in a server.

## Trade ad coverage

Two sources feed every search:

- The Rolimons API (`getrecentads`), which serves the ads created in roughly the last three minutes.
- The Rolimons trades page (`https://www.rolimons.com/trades`), which embeds its full ad list: about 2,000 ads that the site splits into 50 pages of 40 in the browser. One download reads all 50 pages; `?page=N` returns the same data, so nothing is gained by requesting pages separately. It is refreshed at most every 2.5 minutes.

Both are polled every 60 seconds while the bot runs and archived in SQLite at `DATABASE_PATH` (`./data/tradefinder.sqlite` locally, the `bot-data` volume in the container), in a table of `id`, `created_at` and the ad itself. Because the API window is three minutes, continuous uptime captures every ad from the API alone; the page only backfills the previous half hour after a restart. If the page ever refuses the bot (HTTP 403 or rate limiting) it is left alone for 30 minutes and nothing else changes. The archive is a rolling window, rolled forward every time new ads arrive: anything past `AD_ARCHIVE_HOURS` (default 24) is deleted, and once `AD_ARCHIVE_MAX_ADS` (default 100,000) rows are reached each new ad displaces the oldest, so both the file and the time a search takes stay bounded however busy the feed gets. Freed pages are returned to the filesystem incrementally rather than left as slack. The find and settings panels show what the archive currently holds — ads kept against the cap, how far back they reach, arrivals per hour and the size on disk. A search screens the whole archive inside your **max ad age** filter (default 60 minutes, up to 24 hours), then price-screens the ads locally and verifies up to `MAX_SELLERS_PER_SEARCH` (default 30) seller inventories, best candidates first.

Roughly two of every three archived ads are a repost of an identical offer, so only the newest copy of each `(seller, offering, requesting)` is screened. Within an ad, only the bundle sizes the shape rules allow are considered, and each is binary-searched straight into the value range its shape's window needs — a bundle whose only possible outcome is rejection is never evaluated. Seller inventories are then fetched concurrently, paced by the shared per-host rate limiter, and a prospective partner's may be reused for up to three minutes; your own is always read fresh, so a trade is never proposed on a copy you have just traded away. The search summary reports how many ads were screened and how far back they reached.

## Calculations and filters

Every decision is made on **value** alone. For each item, value is the assigned Rolimons value; an item with no assigned value (Rose Amazeface, for example) counts its RAP as its value, and the UI labels it **value = RAP**. RAP totals are shown on every card for reference and never change a decision. Projected items are excluded from both sides of every calculation. None of this is a catalog purchase price or a cash valuation.

```text
Value gain     = total received value − total given value
Value gain %   = value gain / total given value × 100
Your overpay % = max(0, given value − received value) / received value × 100
Partner loss % = max(0, received value − given value) / received value × 100
```

Only trades that genuinely consolidate or split are proposed: at least two items given per item received (an upgrade) or received per item given (a downgrade). A 4-for-3 or an even-count shuffle moves a pile of items without changing what anyone owns, so it is rejected outright, and a 1-for-1 only stands when the ad asked for exactly that. An upgrade must also end with a better single item than it gave, and a downgrade the reverse.

Each shape then has to be worth doing. An upgrade hands the other side more items to look after, so it only gets accepted with an overpay — **4% to 20%** by default. A downgrade is the other end of that same trade, so it collects one: **4% to 35% profit**. Type your own window in **Filters** to replace either. Results are banded by size against your best item before anything else, so neat percentages on your cheapest copies rank behind real trades, and within a band each trade is judged against what its own shape is for. Alert batches lead with downgrades.

| Setting | Default | Meaning |
| --- | --- | --- |
| `mode` | `any` | Alert mode: upgrade, downgrade or any |
| `min_value_gain` | `-5` | Minimum value gain percentage for alerts |
| `max_overpay` | `5` | Maximum overpay relative to received value |
| `max_partner_loss` | `15` | Avoid proposing extreme value losses to the seller |
| `min_demand` | `-1` | Permit unknown demand; 0–4 = terrible, low, normal, high, amazing |
| `max_ad_age` | `60` | Maximum ad age in minutes |

Downgrade profit and upgrade overpay windows, watch lists and per-item profit rules are also enforced by the **Re-check now** button on a recommendation.

Only passing candidates are ranked. The transparent **heuristic score** is:

```text
value gain %
+ 2 × (incoming weighted demand − outgoing weighted demand)
+ (incoming weighted trend − outgoing weighted trend)
+ match bonus − incoming risk penalties
```

Demand and trend averages are weighted by value. Unknown demand scores as 0; unknown trend is neutral. Trend scores: lowering −1, unstable −0.5, stable 0, raising +1, fluctuating −0.5. Match bonus is 8 for an exact advertised exchange, 3 for a counteroffer including a requested item, otherwise 0. Incoming penalties per copy: hyped 5, rare 3. Unknown attributes and RAP-as-value items are disclosed.

The score ranks current snapshots. It is **not a statistically calibrated probability**, price forecast, historical volatility analysis, acceptance guarantee or expected profit. RAP and effective value are correlated, especially for unvalued items. The available endpoints do not supply the price history or accepted-trade dataset needed to claim those models.

## Discovery, verification and alerts

- Uses the [Rolimons item and recent-ad endpoints](https://github.com/maddoxbouldin/Rolimons-API) from the supplied Lua wrapper, accessed directly with a typed HTTP adapter. No Lua runtime is required. The inventory display retains items from [Roblox's public inventory API](https://inventory.roblox.com/docs/index.html) and adds actual copies from authenticated `GET /v2/users/{userId}/tradableItems`. Complete authenticated reads mark copies Tradable or Not tradable; held copies are unavailable. Without a session, or when verification fails, public items stay visible as Tradability unknown and are excluded from recommendations. Both sides of recommendations and manual analyses require verified copies. The requesting user's session is used for these checks; cached results are scoped to that session.
- Reads recent ads, filters for wanted items, and generates item bundles. Exact exchanges require the full requested multiset and full offered multiset. Partial matches are clearly labeled counteroffers. Seller upgrading/downgrading tags are interpreted from the seller's perspective.
- Checks complete paginated inventories for you and shortlisted sellers. Uses unique user-asset IDs, excludes holds, respects duplicate quantities, and skips unpriced assets. If an advertised copy is missing, that ad is discarded. Private/blocked inventories never become verified recommendations.
- Discovery covers **recent advertisers**, not every owner on Roblox. It does not scrape hidden inventories or enumerate the world's owners. Item-only proposals are supported; ads involving Robux are skipped because their cash component and fees would change the calculation. Migrated face bundles use explicit pricing-ID-to-bundle-ID mappings in the Rolimons trades page. Retained classic faces remain separate and non-tradable when absent from the authenticated response. If a bundle mapping is unavailable, its owned copies remain visible with Roblox RAP but are excluded from suggestions; names are never used to guess a price mapping.
- Maximum 12 seller inventories per search by default. All eligible ads are price-screened first; the best candidate sellers are verified. Large outgoing inventories use a 28-copy sample spanning requested items and price points; up to four copies per asset are useful. Exact requested bundles still use the full inventory. For each advertised subset, up to 160 eligible outgoing bundles are sampled. This bounded search may miss deals and is not an exhaustive optimizer.
- Price cache: 120 seconds; recent ads: 30 seconds; own inventories: 60 seconds; partner screening inventories: 180 seconds; bundle mappings: one hour. No stale-on-error fallback. Results over five minutes old are rejected. Public inventories allow 100 pages of 100 copies; authenticated inventories allow 100 pages of 25 items within a two-minute request deadline. Failed or incomplete checks never establish tradability. Snapshots cannot be atomic across pages or accounts; recheck at trade time.
- The monitor runs every 180 seconds **after the previous scan finishes**, sharing API caches and spacing requests by host. It sends up to two new recommendations per subscriber per cycle. Each recipient/partner/item-bundle combination is suppressed for 24 hours, including reposted ads, and persists across restarts. Failed sends are not marked delivered. A crash between Discord delivery and writing its receipt can cause one duplicate on restart.
- DMs require opt-in. Each seller/item pair is alerted once per 24 hours whatever bundle of your items pays for it, up to `alertsPerScan` alerts per scan (three by default; set it on `/trade alerts`, scans run every minute) and an hourly ceiling of thirty per slot, never under sixty. Blocked DMs disable alerts and leave an explanation in `/trade settings`; transient failures retry later. Preferences are rechecked before delivery. Manual searches are limited to one per user per 30 seconds. A single bot process should use the database; horizontal multi-process coordination is not implemented.
- Place Trade verifies the cookie’s authenticated identity, both accounts’ eligibility, current item limits and available inventory before calling `POST https://trades.roblox.com/v2/trades/send`. It matches both item type and target ID, including bundles, and uses fresh string `collectibleItemInstanceIds` from authenticated v2 inventories, never catalog IDs or v1 numeric copy IDs. The price calculation remains the displayed search snapshot; inventories can change between validation and sending.
- Authenticated requests use fixed Roblox HTTPS hosts, reject redirects and have a 12-second timeout. Inventory reads share a queue across connected accounts, with at least 5.5 seconds between requests, so sender and recipient checks cannot collide with Roblox’s five-second limit. GET rate limits honor Retry-After (seconds or HTTP dates) and retry at most twice within the offer’s lifetime, with a private waiting message. POST requests retry only a CSRF rejection, once; send rate limits report the remaining wait and require a new explicit click. For a supported two-step challenge, the bot shows **Verify this trade** with the exact item quantities and an **Enter authenticator code** button. The private form submits the six-digit code to Roblox, continues that challenge, rechecks both inventories and sends the same offer with Roblox’s verification proof. Codes are never persisted or logged. Verification is bound to the Discord user, Roblox account and connected session; it expires after five minutes or the search lifetime, permits at most three submitted codes, and is invalidated by a new search, disconnect, relink or restart. CAPTCHA, sign-in and unsupported challenges offer a direct **Complete trade on Roblox** link. No automatic challenge bypass or send loop is used. The authenticator endpoint is documented in [Roblox’s two-step verification API](https://create.roblox.com/docs/cloud/reference/domains/twostepverification); challenge continuation follows [Roblox’s browser client](https://js.rbxcdn.com/70a780b0c5eef6336ec626e544c98e75cb12f38e208eae0735dd42b118f6ba72-Challenge.js).
- SQLite claims prevent concurrent duplicate sends for the same Roblox accounts and item quantities. Successful offers are blocked from repetition for 24 hours. A timeout, ambiguous server response or crash during sending leaves a durable block: check outbound trades on Roblox and handle any retry there. Pending hashes are retained until an operator reconciles them; they survive disconnect and account deletion to avoid accidental duplicate sends. Definite rejections release the claim for a later explicit click. Live trade sending is not part of the test suite.

## Validation

```sh
npm run check  # TypeScript build and offline tests
npm run demo   # Synthetic recommendation; writes data/demo-recommendation.json
npm run smoke  # Read-only live items, ads and a public advertiser inventory
npm run screenshots  # Re-render docs/screenshots/*.png (needs Python Playwright with Chromium)
```

For a specific live inventory: `SMOKE_ROBLOX_ID=123 npm run smoke`. Live smoke checks can fail if the selected inventory is private or services rate limit requests. Tests cover calculations, quantity checks, risk filters, generation, tags, pagination, API schema errors, rate limits, concurrency, persistent settings, alert deduplication and delivery failures. No Discord token is needed for tests or demo. Actual Discord registration, login, rendering and DM delivery need real credentials and an installed bot.

## Container deployment

First register commands locally as above, then:

```sh
docker compose up -d --build
docker compose logs -f bot
```

The container runs as a non-root user with a persistent SQLite volume. `.env` and database files are excluded from the image and Git. Back up the `bot-data` volume. Stop the bot before copying the database or use a SQLite-aware backup that includes its WAL state.

### Moving to a host

The image is self-contained and needs only outbound access to Discord, Rolimons and Roblox, plus one writable volume. What a platform needs from it:

| Requirement | How it is met |
| --- | --- |
| Configuration | Every setting is an environment variable; see `.env.example`. Nothing is read from a file except the database. |
| Persistent state | One SQLite file at `DATABASE_PATH`. Mount a volume there — linked accounts, alert history and the ad archive all live in it. The archive is self-limiting, so the volume does not grow without bound. |
| Health checks | Set `HEALTH_PORT` (the image defaults it to 8080) and point the platform at `/health`. It answers 200 while the gateway is connected and scans are still completing, and 503 otherwise, so a wedged process is restarted rather than left idling. `GET /` and `/healthz` are the same endpoint. It exposes no token, account or Discord ID. |
| Graceful shutdown | `SIGTERM` and `SIGINT` stop the monitor, close the gateway and close the database before exiting, so a rolling deploy never truncates a scan. |
| Logs | Every line is stamped with an ISO timestamp on stdout, ready for an aggregator. No credentials are ever logged. |
| Single instance | The database has no cross-process coordination, so run exactly one replica. Scaling out needs a shared store first. |

Run exactly one instance. Two processes against the same volume will both scan and both DM.

## Code layout

`providers.ts` validates upstream schemas, inventories and avatar lookups; `engine.ts` calculates and constructs exchanges; `search.ts` handles discovery and seller verification; `store.ts` persists profiles; `monitor.ts` delivers opt-in alerts; `commands.ts` defines the slash command, `bot.ts` handles commands, buttons, select menus and modals, and `presentation.ts` builds every embed and component. `scripts/screenshots.ts` renders those payloads to Discord-styled HTML for the README. `index.ts` starts the service and `register.ts` registers slash commands.

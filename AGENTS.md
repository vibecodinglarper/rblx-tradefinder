# Roblox limited-item trading: domain reference

Background knowledge from the user's own "Roblox Trading 101" deck, including what its screenshots show.
This is context for understanding Roblox trading, not a specification to implement. Nothing here is a
request to change code.

## Prices

**Value** — the value assigned to an item on rolimons.com. If Rolimons has not assigned one, the item's
value *is* its RAP.

**RAP** — recent average price: what the item has sold for on average, all time, on Roblox.

A Rolimons item page shows Best Price, RAP, Value and Demand along the bottom, with Type, Available
Copies, Premium Copies, Avg Daily Sales, Acronym, RAP After Sale, Hoarded % and Trend above. Clockwork's
Headphones (CWHP) in the deck: Best Price 887,000, RAP 910,397, Value 930,000, Demand Amazing, 912
available, 4.9% hoarded, Trend Stable.

**Projected** — an item whose price is artificially inflated far beyond what it is normally worth. Rolimons
puts a "⚠ Projected" badge next to the item name and refuses to assign a value, so Value, Demand and
Trend all read "Not Assigned".

The deck's example, Mr. Hatbot, shows why the damage is real: Best Price 180,000 against a RAP of 453,363.
Its sale history shows the mechanism. Natural sales sat between roughly 124,000 and 333,000, then a single
sale at 3,600,004 took the RAP from 149,214 to 494,293 in one step. Since a projected item has no assigned
value, falling back to RAP adopts that spike as if it were real.

**Rares** — items with roughly 100 copies or fewer. Scarcity makes them highly desired, so they command
very large overpays and hold value well. Rolimons marks them with a 💎 "Rare" badge and has an "Only
Rares" category filter, alongside Only Projecteds, Tablets and Unobtainables.

Two things stand out on the rares list. Available copies really are tiny, from about 4 to 36. And Value sits
far above RAP: Dominus Empyreus is valued at 110,000,000 against a RAP of 13,577,229. The "Price" column
for these is meaningless, full of placeholder not-for-sale numbers like 618,033,988 or 999,999,999,999.

## Trade shapes

**Upgrade** — you give multiple items and get back fewer, more valuable ones. The other side takes on more
items, so **you must overpay for them to accept**.

**Downgrade** — you give one item and get back two or more items each worth less than it. The single item
is the one being overpaid for, so the downgrader collects the profit.

**Overpay** — the value given in excess to make a trade worth accepting for whoever is downgrading. Profit
for one side, a deliberate loss for the other. Aim for about 10% on an upgrade. The deck's example is 21%
and it calls that already large. Around 50% is only reasonable for rares.

That example trade: four items worth 23,354 given for two items worth 18,430, marked −4,924 (−21%). The
Cincinnati Bengals helmet at 430 is a throw-in, almost negligible, included to make the offer feel bigger.

**Fluke** — a trade that makes no sense for anyone trading for profit: an extreme overpay, or an upgrade
that costs far too little. Usually EDaters handing out unreasonable trades. Note that a fluke is defined by
its size, not by who benefits; someone is on the winning end of one.

The deck reuses one trade for both the downgrade and the fluke slide: 8-Bit Dark Horns of Prominence
(55,701) given for an 8-Bit HP Bar, an 8-Bit Royal Crown and Recycled Cardboard Wings together worth
110,000, marked +54,299 (+97%). The shape is an ordinary downgrade; the +97% is what makes it a fluke.

## Reading a trade screen

Roblox and Rolimons show "Items you gave" over "Items you received", each item with its RAP and Value,
with per-side totals and a coloured difference chip between them.

- **The percentage is measured against what you gave.** In the 21% example, 4,924 over the 23,354 given.
  In the counter example, 1,000 over 55,000 given reads as −1.8%.
- **Values shown are current, not the values at the time of the trade.** The deck points this out about its
  downgrade example, where the items were each worth less than the 8HOP when it was actually sent.
- RAP and Value are listed separately per item and often disagree, which is the whole reason both are shown.

## People and communication

**Hoard / hoarder** — someone holding a large quantity of one specific item. The deck's example profile
holds only 10 distinct collectibles but hundreds of copies of each, including 440 Blue Wistful Winks, 427
Lavender Amazefaces and 407 Green Goofs. Rolimons has a "Stack Hoards" toggle for viewing this.

**Abbreviations** — most items have a short community acronym, shown in parentheses after the name on
Rolimons: 8BRC (8-Bit Royal Crown), Frig (Dominus Frigidus), Bling (Bling $$ Necklace), PISTF (Pink
Sparkle Time Fedora).

**W/L** or **A/D** — win/loss, accept/decline. Someone posts their pending trade in a Rolimons Discord
channel and the room votes with 👍 and 👎. The deck's example is even on value, 30,000 each way, but down
2,500 RAP (−8%), and the room voted it 6 down against 3 up. Worth knowing that traders weigh RAP when
judging a trade even though value is the headline number.

**Counter** — the Roblox feature for answering an inbound trade with an adjusted counteroffer instead of a
plain accept or decline. The trade screen carries Accept, Counter and Decline, plus History and Analyze
Trade. The deck's example is a downgrade that would lose 1,000 value (−1.8%), which is the kind of offer
worth countering rather than declining outright.

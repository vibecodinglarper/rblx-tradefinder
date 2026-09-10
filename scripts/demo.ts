import { writeFileSync, mkdirSync } from 'node:fs';
import { SearchService } from '../src/search.js';
import { recommendationMessage } from '../src/presentation.js';
import { fixtureProvider, profile } from '../test/fixtures.js';

const result = await new SearchService(fixtureProvider()).search(profile());
const recommendation = result.recommendations[0]!;
const payload = recommendationMessage(recommendation);
mkdirSync('data', { recursive: true });
writeFileSync('data/demo-recommendation.json', JSON.stringify({
  ...payload, embeds: payload.embeds.map(e => e.toJSON()), components: payload.components.map(c => c.toJSON()),
}, null, 2));
console.log('Synthetic example, not a live trade:');
console.log(`Give 2 items (${recommendation.giving.value} value / ${recommendation.giving.rap} RAP).`);
console.log(`Receive 1 item (${recommendation.receiving.value} value / ${recommendation.receiving.rap} RAP).`);
console.log(`Value gain +${recommendation.valueGainPct}%; RAP gain +${recommendation.rapGainPct}%; ${recommendation.match} ad match.`);
console.log('Discord message preview written to data/demo-recommendation.json.');

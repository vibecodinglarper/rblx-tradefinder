/**
 * Shows what the bot has in Firestore: the heartbeat and the ad-bucket window. Read-only; needs the same
 * FIREBASE_SERVICE_ACCOUNT (or _JSON) and FIRESTORE_PREFIX the bot uses. Run with `npm run firestore`.
 */
import { openFirestore } from '../src/firestore.js';

const prefix = process.env.FIRESTORE_PREFIX || 'tradefinder';
const { db, projectId } = openFirestore({ serviceAccountPath: process.env.FIREBASE_SERVICE_ACCOUNT || undefined,
  serviceAccountJson: process.env.FIREBASE_SERVICE_ACCOUNT_JSON || undefined, prefix }, { hours: 24, maxAds: 100_000 });
const status = await db.collection(`${prefix}-status`).doc('bot').get();
const beat = status.data() as { status?: string; updatedAt?: number; host?: string; archive?: { ads: number; reachMinutes: number } } | undefined;
console.log(`Project ${projectId}, collections ${prefix}-status and ${prefix}-ad-buckets`);
if (!beat) console.log('Heartbeat: none written yet.');
else console.log(`Heartbeat: ${beat.status} on ${beat.host}, ${Math.round((Date.now() - (beat.updatedAt ?? 0)) / 1000)} s ago, archive ${beat.archive?.ads ?? 0} ads back ${beat.archive?.reachMinutes ?? 0} min.`);
const buckets = await db.collection(`${prefix}-ad-buckets`).orderBy('start').get();
let ads = 0, bytes = 0;
for (const doc of buckets.docs) { const d = doc.data() as { count: number; gz: Buffer }; ads += d.count; bytes += d.gz.length; }
const first = buckets.docs[0]?.data() as { start: number } | undefined, last = buckets.docs.at(-1)?.data() as { start: number } | undefined;
console.log(`Buckets: ${buckets.size} documents, ${ads} ads, ${(bytes / 1024).toFixed(0)} KB compressed` + (first && last ? `, ${new Date(first.start).toISOString()} → ${new Date(last.start).toISOString()}` : '.'));
process.exit(0);

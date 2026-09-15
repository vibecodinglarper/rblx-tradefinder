import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { cert, initializeApp } from 'firebase-admin/app';
import { getFirestore, type CollectionReference, type DocumentReference, type Firestore } from 'firebase-admin/firestore';
import { BucketedArchive, type BucketDoc, type BucketStore } from './archive.js';
import type { HealthReport } from './health.js';
import type { ArchivePolicy } from './store.js';

/** Where the service account comes from: a file on disk, or the JSON itself for hosts that only offer variables. */
export interface FirestoreConfig { serviceAccountPath?: string; serviceAccountJson?: string; prefix: string }

function credentials(config: FirestoreConfig): object {
  const raw = config.serviceAccountJson ?? (config.serviceAccountPath ? readFileSync(config.serviceAccountPath, 'utf8') : undefined);
  if (!raw) throw new Error('Firestore needs FIREBASE_SERVICE_ACCOUNT (a file path) or FIREBASE_SERVICE_ACCOUNT_JSON.');
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error('The Firebase service account is not valid JSON.'); }
  if (!parsed || typeof parsed !== 'object' || !('project_id' in parsed) || !('private_key' in parsed)) throw new Error('The Firebase service account is missing project_id or private_key.');
  return parsed;
}

/** The bucket store over a real Firestore collection. Bytes fields come back as Buffers in the admin SDK. */
export class FirestoreBuckets implements BucketStore {
  constructor(private collection: CollectionReference) {}
  async list(sinceStart: number): Promise<{ id: string; doc: BucketDoc }[]> {
    const snapshot = await this.collection.where('start', '>=', sinceStart).get();
    return snapshot.docs.map(d => ({ id: d.id, doc: d.data() as BucketDoc }));
  }
  async put(id: string, doc: BucketDoc): Promise<void> { await this.collection.doc(id).set(doc); }
  async remove(ids: string[]): Promise<void> {
    // A batch takes 500 operations at most; the window only ever retires a bucket or two at a time, but be safe.
    for (let i = 0; i < ids.length; i += 400) {
      const batch = this.collection.firestore.batch();
      for (const id of ids.slice(i, i + 400)) batch.delete(this.collection.doc(id));
      await batch.commit();
    }
  }
}

/**
 * A liveness record the operator can read in the Firebase console without shell access to the host: the same facts
 * the health endpoint reports, plus which machine wrote them and when. Nothing secret goes in — no token, no user.
 */
export class Heartbeat {
  private startedAt = Date.now();
  constructor(private doc: DocumentReference) {}
  async beat(report: HealthReport, extra: { archiveError?: string | null } = {}): Promise<void> {
    const now = Date.now();
    await this.doc.set({
      status: report.discord ? 'online' : 'gateway-disconnected', discord: report.discord,
      lastScanAt: report.lastScanAt, lastScanSecondsAgo: report.lastScanAt === null ? null : Math.round((now - report.lastScanAt) / 1000),
      archive: { ads: report.archive.count, reachMinutes: report.archive.minutes, kilobytes: Math.round(report.archive.bytes / 1024), error: extra.archiveError ?? null },
      host: hostname(), pid: process.pid, startedAt: this.startedAt, updatedAt: now, uptimeSeconds: Math.round(process.uptime()),
    });
  }
  /** Written on a clean shutdown so the console distinguishes a stopped bot from a silent one. */
  async stopped(): Promise<void> { await this.doc.set({ status: 'stopped', updatedAt: Date.now() }, { merge: true }); }
}

export interface FirestoreServices { db: Firestore; archive: BucketedArchive; heartbeat: Heartbeat; projectId: string }
/** Connects once. The archive is empty until `archive.load()` has run. */
export function openFirestore(config: FirestoreConfig, policy: ArchivePolicy): FirestoreServices {
  const account = credentials(config) as { project_id: string };
  const app = initializeApp({ credential: cert(account as Parameters<typeof cert>[0]) });
  const db = getFirestore(app);
  db.settings({ ignoreUndefinedProperties: true });
  return {
    db, projectId: account.project_id,
    archive: new BucketedArchive(new FirestoreBuckets(db.collection(`${config.prefix}-ad-buckets`)), policy),
    heartbeat: new Heartbeat(db.collection(`${config.prefix}-status`).doc('bot')),
  };
}

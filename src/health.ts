import { createServer, type Server } from 'node:http';

export interface HealthReport {
  /** Whether the Discord gateway connection is up. */
  discord: boolean;
  /** When the monitor last finished a scan, or null before the first one completes. */
  lastScanAt: number | null;
  /** Rolling ad archive: rows kept, how far back they reach, and the file size on disk. */
  archive: { count: number; minutes: number; bytes: number };
}

/**
 * A readiness endpoint for a hosting platform to poll. It answers 200 while the gateway is connected and a scan has
 * finished inside `staleScanMs`, and 503 otherwise — so a platform restarts a wedged process rather than leaving one
 * that is running but no longer doing anything. Nothing here is secret: no token, no user, no Discord ID.
 *
 * Returns null when `port` is 0, which is how a local run leaves it switched off.
 */
export function startHealthServer(port: number, report: () => HealthReport, staleScanMs = 600_000): Server | null {
  if (!port) return null;
  const server = createServer((request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { allow: 'GET, HEAD' }).end();
      return;
    }
    const path = (request.url ?? '/').split('?')[0];
    if (path !== '/' && path !== '/health' && path !== '/healthz') {
      response.writeHead(404).end();
      return;
    }
    const now = Date.now();
    const state = report();
    // Before the first scan completes the process is starting up, which is healthy; after that, silence is not.
    const scanning = state.lastScanAt === null || now - state.lastScanAt < staleScanMs;
    const ready = state.discord && scanning;
    const body = JSON.stringify({
      status: ready ? 'ok' : 'unhealthy',
      discord: state.discord ? 'connected' : 'disconnected',
      lastScanSecondsAgo: state.lastScanAt === null ? null : Math.round((now - state.lastScanAt) / 1000),
      archive: { ads: state.archive.count, reachMinutes: state.archive.minutes, megabytes: Number((state.archive.bytes / 1048576).toFixed(1)) },
      uptimeSeconds: Math.round(process.uptime()),
    });
    response.writeHead(ready ? 200 : 503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    if (request.method === 'HEAD') response.end(); else response.end(body);
  });
  server.on('error', error => console.error('Health endpoint unavailable:', error instanceof Error ? error.message : 'Unknown error'));
  server.listen(port, () => console.log(`Health endpoint listening on :${port}`));
  return server;
}

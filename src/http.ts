import { UserError } from './domain.js';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export class HttpClient {
  private queues = new Map<string, Promise<void>>();
  private nextAt = new Map<string, number>();
  private blockedUntil = new Map<string, number>();
  constructor(private fetcher: typeof fetch = fetch, private spacingMs = 350) {}

  private async slot(host: string): Promise<void> {
    const previous = this.queues.get(host) ?? Promise.resolve();
    const next = previous.then(async () => {
      if ((this.blockedUntil.get(host) ?? 0) > Date.now()) throw new UserError(`${host} is rate limited. Try again later.`);
      await sleep(Math.max(0, (this.nextAt.get(host) ?? 0) - Date.now()));
      this.nextAt.set(host, Date.now() + this.spacingMs);
    });
    this.queues.set(host, next.catch(() => {}));
    await next;
  }

  async json(url: string, init?: RequestInit): Promise<unknown> {
    const host = new URL(url).host;
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.slot(host);
      let response: Response;
      try {
        response = await this.fetcher(url, {
          ...init, signal: AbortSignal.timeout(12_000),
          headers: { 'User-Agent': 'Tradefinder/1.0', 'Content-Type': 'application/json', ...init?.headers },
        });
      } catch {
        if (attempt < 2) { await sleep(500 * (attempt + 1)); continue; }
        throw new UserError(`${host} could not be reached. Try again shortly.`);
      }
      if (response.status === 403) throw new UserError(`${host} denied access. The inventory may be private or the service may be blocking this server.`);
      if (response.status === 404) throw new UserError(`${host}: user or resource not found.`);
      if (response.status === 429 || response.status >= 500) {
        const retryHeader = response.headers.get('retry-after');
        const seconds = retryHeader ? Number(retryHeader) : NaN;
        const delay = Number.isFinite(seconds) ? seconds * 1000
          : retryHeader ? Math.max(0, Date.parse(retryHeader) - Date.now()) : 1000 * (attempt + 1);
        const wait = Number.isFinite(delay) ? Math.max(0, delay) : 2000;
        if (wait > 5000) this.blockedUntil.set(host, Date.now() + wait);
        else this.nextAt.set(host, Math.max(this.nextAt.get(host) ?? 0, Date.now() + wait));
        if (attempt < 2 && wait <= 5000) { await sleep(wait); continue; }
        throw new UserError(`${host} is busy or rate limited. Try again later.`);
      }
      if (!response.ok) throw new UserError(`${host} returned HTTP ${response.status}.`);
      try { return await response.json(); }
      catch { throw new UserError(`${host} returned invalid JSON; no recommendations were calculated.`); }
    }
    throw new UserError('Request failed.');
  }
  /** HTML page download. Uses the same host spacing and retry-after handling as JSON requests. */
  async text(url: string, maxBytes = 4_000_000): Promise<string> {
    const host = new URL(url).host;
    await this.slot(host);
    let response: Response;
    try {
      response = await this.fetcher(url, { signal: AbortSignal.timeout(20_000), headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36 Tradefinder/1.0',
        Accept: 'text/html,application/xhtml+xml' } });
    } catch { throw new UserError(`${host} could not be reached. Try again shortly.`); }
    if (response.status === 429 || response.status >= 500) { this.blockedUntil.set(host, Date.now() + 60_000); throw new UserError(`${host} is busy or rate limited. Try again later.`); }
    if (!response.ok) throw new UserError(`${host} returned HTTP ${response.status}.`);
    const body = await response.text();
    if (body.length > maxBytes) throw new UserError(`${host} returned an unexpectedly large page.`);
    return body;
  }
  /** Small binary download (thumbnails). Decoration only: any failure returns null instead of throwing. */
  async bytes(url: string, maxBytes = 2_000_000): Promise<Buffer | null> {
    const host = new URL(url).host;
    try {
      await this.slot(host);
      const response = await this.fetcher(url, { signal: AbortSignal.timeout(12_000), headers: { 'User-Agent': 'Tradefinder/1.0' } });
      if (!response.ok) return null;
      const data = Buffer.from(await response.arrayBuffer());
      return data.length > maxBytes ? null : data;
    } catch { return null; }
  }
}

/** Bounded cache with in-flight request sharing; errors and stale data are never cached. */
export class Cache {
  private values = new Map<string, { loadedAt: number; data: unknown }>();
  private pending = new Map<string, Promise<unknown>>();
  async get<T>(key: string, ttl: number, loader: () => Promise<T>): Promise<T> {
    const cached = this.values.get(key);
    if (cached && Date.now() - cached.loadedAt < ttl) return cached.data as T;
    const running = this.pending.get(key);
    if (running) return running as Promise<T>;
    const loadedAt = Date.now();
    const promise = loader().then(data => {
      this.values.delete(key);
      this.values.set(key, { loadedAt, data });
      if (this.values.size > 500) this.values.delete(this.values.keys().next().value!);
      return data;
    }).finally(() => this.pending.delete(key));
    this.pending.set(key, promise);
    return promise;
  }
}

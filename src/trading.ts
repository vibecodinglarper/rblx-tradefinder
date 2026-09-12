import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { UserError, type UserProfile } from './domain.js';
import type { Recommendation } from './engine.js';
import type { Store } from './store.js';
import { inventoryRoute, retryDelay, robloxRoute, RobloxThrottle } from './roblox-throttle.js';

const userId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const identity = z.object({ id: userId, name: z.string().min(1) });
const target = z.object({ itemType: z.string(), targetId: z.string() });
const inventoryPage = z.object({
  userId,
  items: z.array(z.object({ itemTarget: target, instances: z.array(z.object({
    collectibleItemInstanceId: z.string().min(1), itemTarget: target, isOnHold: z.boolean(),
  })) })),
  nextPageCursor: z.string().nullable(),
});
export interface TradeRequest {
  senderOffer: { userId: number; robux: number; collectibleItemInstanceIds: string[] };
  recipientOffer: { userId: number; robux: number; collectibleItemInstanceIds: string[] };
}
/** No upstream message, request, response body or credential is ever attached to these errors. */
export class RobloxRequestError extends UserError {
  constructor(message: string, readonly uncertain = false, readonly unauthorized = false) { super(message); }
}
export class RobloxRateLimitError extends RobloxRequestError {
  constructor(readonly retryAt: number, readonly stage: string, now = Date.now()) {
    super(`Roblox is rate limiting ${stage}. Try again in ${Math.max(1, Math.ceil((retryAt - now) / 1000))} seconds. No trade was sent.`);
  }
}
type ChallengeKind = 'twostepverification' | 'captcha' | 'reauthentication' | 'unknown';
export interface AuthenticatorChallenge { id: string; challengeId: string; userId: string; actionType: 3 | 7 | 8 }
interface ChallengeProof { id: string; metadata: string }
export class RobloxChallengeError extends RobloxRequestError {
  #details?: AuthenticatorChallenge;
  constructor(readonly kind: ChallengeKind, details?: AuthenticatorChallenge) {
    super('Roblox requires a security challenge for this trade.'); this.#details = details;
  }
  get details(): AuthenticatorChallenge | undefined { return this.#details; }
}
export class TradeVerificationRequired extends UserError {
  constructor(readonly offer: Recommendation, readonly kind: ChallengeKind, readonly token?: string, message = 'Roblox needs you to verify this trade.') { super(message); }
}
class InvalidVerificationCode extends UserError {}
/** Only accept a Roblox-issued trade/generic challenge for the connected user; never turn other actions into trade proofs. */
export function parseChallenge(headers: Headers): RobloxChallengeError {
  const rawKind = headers.get('rblx-challenge-type');
  const kind: ChallengeKind = rawKind === 'twostepverification' || rawKind === 'captcha' || rawKind === 'reauthentication' ? rawKind : 'unknown';
  const id = headers.get('rblx-challenge-id') ?? '';
  const encoded = headers.get('rblx-challenge-metadata') ?? '';
  if (kind === 'twostepverification' && /^[a-zA-Z0-9-]{1,128}$/.test(id) && encoded.length <= 16_384) {
    try {
      const value = z.object({ userId: z.union([z.string().regex(/^\d+$/), userId]), challengeId: z.string().regex(/^[a-zA-Z0-9-]{1,128}$/),
        actionType: z.union([z.literal('ItemTrade'), z.literal('Generic'), z.literal('GenericWithRecoveryCodes'), z.literal(3), z.literal(7), z.literal(8)]) })
        .parse(JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')));
      const actionType = typeof value.actionType === 'number' ? value.actionType : value.actionType === 'ItemTrade' ? 3 : value.actionType === 'Generic' ? 7 : 8;
      return new RobloxChallengeError(kind, { id, challengeId: value.challengeId, userId: String(value.userId), actionType });
    } catch { /* Malformed and unsupported challenges use Roblox's own browser flow. */ }
  }
  return new RobloxChallengeError(kind);
}
type TradeProgress = (message: string) => Promise<void>;
export function normalizeCookie(input: string): string {
  const cookie = input.trim().replace(/^\.ROBLOSECURITY=/, '');
  if (!cookie || cookie.length > 4000 || !/^[\x21-\x7e]+$/.test(cookie) || /[;",\\]/.test(cookie)) {
    throw new UserError('Enter only the .ROBLOSECURITY cookie value, without other cookies or headers.');
  }
  return cookie;
}

/** Dedicated authenticated transport: never use the public client's automatic POST retries. */
export class RobloxTradesClient {
  private csrf?: string;
  private proof?: ChallengeProof;
  constructor(private cookie: string, private fetcher: typeof fetch = fetch, private deadline = Date.now() + 120_000,
    private throttle = new RobloxThrottle(), private progress?: TradeProgress) {}
  private async request(path: string, body?: object, host: 'trades' | 'users' | 'twostepverification' | 'apis' = 'trades'): Promise<unknown> {
    const writing = body !== undefined;
    const sending = writing && host === 'trades';
    const verifying = host === 'twostepverification' || host === 'apis';
    const route = robloxRoute(path);
    const stage = route === inventoryRoute ? 'inventory checks' : sending ? 'trade sending' : verifying ? 'verification' : 'account checks';
    const expired = () => new RobloxRequestError('Trade verification took too long or the offer expired. Run a new search.');
    let csrfRetried = false, rateRetries = 0;
    while (true) {
      const response = await this.throttle.run(route, this.deadline, async () => {
        try {
          const response = await this.fetcher(`https://${host}.roblox.com${path}`, {
            method: writing ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(Math.max(1, Math.min(12_000, this.deadline - this.throttle.now()))),
            headers: { Cookie: `.ROBLOSECURITY=${this.cookie}`, Accept: 'application/json',
              ...(writing ? { 'Content-Type': 'application/json' } : {}),
              ...(sending && this.proof ? { 'rblx-challenge-id': this.proof.id, 'rblx-challenge-type': 'twostepverification', 'rblx-challenge-metadata': this.proof.metadata } : {}),
              ...(this.csrf ? { 'X-CSRF-TOKEN': this.csrf } : {}) },
            ...(writing ? { body: JSON.stringify(body) } : {}),
          });
          if (response.status === 429) this.throttle.pause(route, retryDelay(response.headers.get('retry-after'), this.throttle.now()));
          return response;
        } catch {
          throw new RobloxRequestError(sending ? 'Roblox did not confirm the send. Check outbound trades before trying again; this offer will not be resent automatically.' : 'Roblox could not be reached. Try again shortly.', sending);
        }
      }, expired);
      if (response.headers.has('rblx-challenge-id') || response.headers.has('rblx-challenge-type')) {
        const challenge = parseChallenge(response.headers);
        console.warn('Roblox verification required:', JSON.stringify({ route, kind: challenge.kind, status: response.status }));
        if (response.status === 403) throw challenge;
        throw new RobloxRequestError('Roblox returned an unexpected verification response. Check outbound trades on Roblox.', sending);
      }
      const csrf = response.headers.get('x-csrf-token');
      if (writing && response.status === 403 && csrf && !csrfRetried) { this.csrf = csrf; csrfRetried = true; await response.body?.cancel(); continue; }
      if (!response.ok) {
        // Codes are interpreted locally; never echo Roblox's arbitrary error text.
        const data = await response.json().catch(() => null) as { errors?: { code?: number }[] } | null;
        const code = data?.errors?.[0]?.code;
        // Numeric trade validation codes apply to send requests, not unrelated GET endpoint codes.
        if (response.status === 429 || (sending && code === 14)) {
          const delay = retryDelay(response.headers.get('retry-after'), this.throttle.now());
          const retryAt = this.throttle.pause(route, delay);
          console.warn('Roblox rate limit:', JSON.stringify({ route, method: writing ? 'POST' : 'GET', status: response.status, retrySeconds: Math.ceil(delay / 1000) }));
          // GET retries cannot duplicate a trade. POST rate limits require another explicit click.
          if (!writing && rateRetries < 2 && retryAt + 12_000 < this.deadline) {
            rateRetries++;
            await this.progress?.(`Roblox asked us to wait ${Math.ceil(delay / 1000)} seconds during ${stage}. I’ll continue automatically.`).catch(() => {});
            continue;
          }
          throw new RobloxRateLimitError(retryAt, stage, this.throttle.now());
        }
        if (verifying && response.status === 400 && code === 10) throw new InvalidVerificationCode('That authenticator code was rejected. Enter a fresh code from your authenticator app.');
        if (verifying && response.status !== 401) throw new RobloxRequestError('Roblox could not verify this challenge. Use a fresh Place Trade request or complete the trade on Roblox.');
        const message = response.status === 401 ? 'Your Roblox session expired or was rejected. Use /connect again.'
          : code === 23 ? 'Roblox requires two-step verification. Complete verification and send this trade on Roblox.'
          : code === 22 ? 'Roblox privacy settings prevent this trade.'
          : code === 7 ? 'One of these accounts cannot trade. Check Premium and trading eligibility on Roblox.'
          : code === 12 || code === 13 ? 'The offered items are no longer available for this trade. Run a new search.'
          : response.status >= 500 ? 'Roblox is unavailable. Check outbound trades before trying again.'
          : response.status === 403 ? 'Roblox denied this request. Check account verification and trade permissions on Roblox.'
          : `Roblox rejected the request (HTTP ${response.status}). Check the trade on Roblox.`;
        const uncertain = sending && (response.status >= 500 || response.status === 408 || code === 19);
        throw new RobloxRequestError(uncertain ? `${message} Automatic resending is blocked; check outbound trades on Roblox.` : message, uncertain, response.status === 401);
      }
      try { return await response.json(); }
      catch { throw new RobloxRequestError(sending ? 'Roblox returned an unreadable send result. Check outbound trades; automatic resending is blocked.' : 'Roblox returned an unreadable response.', sending); }
    }
  }
  async authenticated() {
    const result = identity.safeParse(await this.request('/v1/users/authenticated', undefined, 'users'));
    if (!result.success) throw new UserError('Roblox returned an invalid account identity.');
    return result.data;
  }
  async checkEligibility(sender: number, recipient?: number): Promise<void> {
    const own = z.object({ userId, canTrade: z.boolean() }).safeParse(await this.request('/v2/users/me/can-trade'));
    if (!own.success || own.data.userId !== sender) throw new UserError('Roblox returned mismatched trading eligibility. Reconnect your account.');
    if (!own.data.canTrade) throw new UserError('Your Roblox account cannot trade. Check Premium membership and trading eligibility on Roblox.');
    if (recipient === undefined) return;
    if (sender === recipient) throw new UserError('You cannot trade with yourself.');
    const both = z.object({ userId, targetUserId: userId, canTrade: z.boolean() })
      .safeParse(await this.request(`/v2/users/${recipient}/can-trade-with`));
    if (!both.success || both.data.userId !== sender || both.data.targetUserId !== recipient) throw new UserError('Roblox returned mismatched partner eligibility.');
    if (!both.data.canTrade) throw new UserError('Roblox does not allow these accounts to trade. Check Premium and both accounts’ privacy settings.');
  }
  async maxItems(): Promise<number> {
    const result = z.object({ maxItemsPerSide: z.number().int().positive() }).safeParse(await this.request('/v1/trades/metadata'));
    if (!result.success) throw new UserError('Roblox trade limits could not be verified.');
    return result.data.maxItemsPerSide;
  }
  /** Match quantities to fresh, distinct v2 instances. Asset IDs and numeric v1 copy IDs are never sent. */
  async instances(owner: number, assets: number[]): Promise<string[]> {
    const available = new Map<string, number>();
    const cursors = new Set<string>();
    let cursor = '';
    for (let page = 0; page < 100; page++) {
      const query = new URLSearchParams({ limit: '25', ...(cursor ? { cursor } : {}) });
      const parsed = inventoryPage.safeParse(await this.request(`/v2/users/${owner}/tradableItems?${query}`));
      if (!parsed.success || parsed.data.userId !== owner) throw new UserError('Roblox returned invalid tradable inventory data.');
      for (const item of parsed.data.items) {
        if (item.itemTarget.itemType !== 'Asset') continue;
        for (const instance of item.instances) {
          if (instance.isOnHold || instance.itemTarget.itemType !== 'Asset' || instance.itemTarget.targetId !== item.itemTarget.targetId) continue;
          const asset = Number(instance.itemTarget.targetId);
          if (assets.includes(asset)) available.set(instance.collectibleItemInstanceId, asset);
        }
      }
      const selected: string[] = [];
      for (const asset of assets) {
        const entry = [...available].find(([id, idAsset]) => idAsset === asset && !selected.includes(id));
        if (!entry) break;
        selected.push(entry[0]);
      }
      if (selected.length === assets.length) return selected;
      cursor = parsed.data.nextPageCursor ?? '';
      if (!cursor) throw new UserError('One or more items are unavailable or on hold. Run a new search.');
      if (cursors.has(cursor)) throw new UserError('Roblox repeated an inventory page. Try a new search later.');
      cursors.add(cursor);
    }
    throw new UserError('This inventory is too large to verify completely. No trade was sent.');
  }
  async send(body: TradeRequest): Promise<number> {
    const result = z.object({ tradeId: userId }).safeParse(await this.request('/v2/trades/send', body));
    if (!result.success) throw new RobloxRequestError('Roblox did not return a trade ID. Check outbound trades; automatic resending is blocked.', true);
    return result.data.tradeId;
  }
  async verifyAuthenticator(challenge: AuthenticatorChallenge, owner: number, code: string): Promise<void> {
    if (challenge.userId !== String(owner)) throw new UserError('This verification belongs to another Roblox account. Start a new search.');
    if (!/^\d{6}$/.test(code)) throw new UserError('Enter the six-digit code from your authenticator app.');
    const verified = z.object({ verificationToken: z.string().min(1).max(8192) }).safeParse(await this.request(
      `/v1/users/${owner}/challenges/authenticator/verify`, { challengeId: challenge.challengeId, actionType: challenge.actionType, code }, 'twostepverification'));
    if (!verified.success) throw new UserError('Roblox did not confirm verification. Start a new Place Trade request.');
    const metadata = JSON.stringify({ verificationToken: verified.data.verificationToken, rememberDevice: false, challengeId: challenge.challengeId });
    const continued = z.object({ challengeType: z.string().nullable() }).safeParse(await this.request('/challenge/v1/continue', {
      challengeId: challenge.id, challengeType: 'twostepverification', challengeMetadata: metadata,
    }, 'apis'));
    if (!continued.success || continued.data.challengeType) throw new UserError('Roblox requires another verification step. Complete this trade on Roblox.');
    this.proof = { id: challenge.id, metadata: Buffer.from(metadata).toString('base64') };
  }
}

interface PendingVerification {
  token: string; owner: number; sessionHash: string; offer: Recommendation; challenge: AuthenticatorChallenge; expiresAt: number; attempts: number; busy: boolean;
}
export class TradingService {
  private pending = new Map<string, PendingVerification>();
  constructor(private store: Store, private fetcher: typeof fetch = fetch, private throttle = new RobloxThrottle()) {}
  cancelVerification(discordId: string): void { this.pending.delete(discordId); }
  available(): void { this.store.requireCredentialKey(); }
  async connect(discordId: string, input: string) {
    this.available();
    const cookie = normalizeCookie(input);
    const client = new RobloxTradesClient(cookie, this.fetcher, Date.now() + 120_000, this.throttle);
    const account = await client.authenticated();
    await client.checkEligibility(account.id);
    this.store.connect(discordId, account, cookie);
    this.pending.delete(discordId);
    return account;
  }
  async place(user: UserProfile, recommendation: Recommendation, expiresAt = Date.now() + 120_000, progress?: TradeProgress): Promise<number> {
    const cookie = this.store.session(user.discordId, user.robloxId);
    const client = new RobloxTradesClient(cookie, this.fetcher, Math.min(expiresAt, Date.now() + 120_000), this.throttle, progress);
    this.pending.delete(user.discordId);
    return this.placeWithClient(user, recommendation, expiresAt, client);
  }
  private async placeWithClient(user: UserProfile, recommendation: Recommendation, expiresAt: number, client: RobloxTradesClient): Promise<number> {
    try {
      const account = await client.authenticated();
      if (account.id !== user.robloxId) throw new UserError('The connected account does not match this search. Use /connect and search again.');
      const partner = recommendation.ad.userId;
      await client.checkEligibility(user.robloxId, partner);
      const max = Math.min(4, await client.maxItems());
      const give = recommendation.give.map(c => c.assetId), receive = recommendation.receive.map(c => c.assetId);
      if (!give.length || !receive.length || give.length > max || receive.length > max) throw new UserError('This offer exceeds Roblox’s item limits. Run a new search.');
      if (recommendation.ad.offeringRobux || recommendation.ad.requestingRobux) throw new UserError('Sending trades with Robux is not supported.');
      const [sender, recipient] = await Promise.all([client.instances(user.robloxId, give), client.instances(partner, receive)]);
      if (new Set([...sender, ...recipient]).size !== sender.length + recipient.length) throw new UserError('Roblox returned overlapping collectible instances. Run a new search.');
      const signature = createHash('sha256').update(JSON.stringify([user.robloxId, partner, [...give].sort((a,b) => a-b), [...receive].sort((a,b) => a-b)])).digest('hex');
      this.store.claimTrade(signature);
      let tradeId: number;
      try {
        tradeId = await client.send({ senderOffer: { userId: user.robloxId, robux: 0, collectibleItemInstanceIds: sender },
          recipientOffer: { userId: partner, robux: 0, collectibleItemInstanceIds: recipient } });
      } catch (error) {
        if (error instanceof RobloxRequestError && !error.uncertain) this.store.releaseTrade(signature);
        if (error instanceof RobloxChallengeError) {
          const challenge = error.details;
          let token: string | undefined;
          if (challenge && challenge.userId === String(user.robloxId)) {
            token = randomBytes(16).toString('hex');
            for (const [id, pending] of this.pending) if (pending.expiresAt <= Date.now()) this.pending.delete(id);
            const sessionHash = createHash('sha256').update(this.store.session(user.discordId, user.robloxId)).digest('hex');
            this.pending.set(user.discordId, { token, owner: user.robloxId, sessionHash, offer: recommendation, challenge,
              expiresAt: Math.min(expiresAt, Date.now() + 300_000), attempts: 0, busy: false });
          }
          throw new TradeVerificationRequired(recommendation, error.kind, token);
        }
        throw error;
      }
      this.store.finishTrade(signature, tradeId);
      return tradeId;
    } catch (error) {
      if (error instanceof RobloxRequestError && error.unauthorized) this.store.disconnect(user.discordId);
      throw error;
    }
  }
  private verification(discordId: string, token: string): PendingVerification {
    const pending = this.pending.get(discordId);
    if (!pending || pending.token !== token || pending.expiresAt <= Date.now() || this.store.get(discordId)?.robloxId !== pending.owner) {
      throw new UserError('This verification has expired. Click Place Trade on a fresh search.');
    }
    const sessionHash = createHash('sha256').update(this.store.session(discordId, pending.owner)).digest('hex');
    if (sessionHash !== pending.sessionHash) throw new UserError('Your Roblox connection changed. Start a new Place Trade request.');
    return pending;
  }
  checkVerification(discordId: string, token: string): void { this.verification(discordId, token); }
  async verifyAndPlace(discordId: string, token: string, code: string, progress?: TradeProgress): Promise<number> {
    const pending = this.verification(discordId, token);
    if (pending.busy) throw new UserError('This verification is already running.');
    if (!/^\d{6}$/.test(code.trim())) throw new TradeVerificationRequired(pending.offer, 'twostepverification', token, 'Enter the six-digit code from your authenticator app.');
    pending.busy = true; pending.attempts++;
    try {
      const user = this.store.get(discordId)!;
      const client = new RobloxTradesClient(this.store.session(discordId, pending.owner), this.fetcher, Math.min(pending.expiresAt, Date.now() + 120_000), this.throttle, progress);
      await client.verifyAuthenticator(pending.challenge, pending.owner, code.trim());
      this.verification(discordId, token);
      this.pending.delete(discordId);
      return await this.placeWithClient(user, pending.offer, pending.expiresAt, client);
    } catch (error) {
      if (error instanceof InvalidVerificationCode && pending.attempts < 3) throw new TradeVerificationRequired(pending.offer, 'twostepverification', token, error.message);
      // A newly issued challenge replaces this one; do not delete the replacement.
      if (this.pending.get(discordId) === pending) this.pending.delete(discordId);
      if (error instanceof RobloxRequestError && error.unauthorized) this.store.disconnect(discordId);
      throw error;
    } finally { pending.busy = false; }
  }
}

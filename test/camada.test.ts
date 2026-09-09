// @camada/bun against the golden v4 snapshot, driven through the wrapper as Bun.serve would call
// it: (req, server), with a stub server whose `requestIP` plays the socket. The fixtures are read
// through the file: symlink to @camada/core, so this package is pinned to the same bytes
// edge-analyst generates. Runs under vitest in Node (Bun rewrites the vitest import for `bun test`).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CHALLENGE_COOKIE } from '@camada/core';
import iife from '@camada/browser/iife-string';
import { camada, resetCamada, track, scriptTag, type BunServer, type CamadaBunOptions } from '../src/index.js';

const FIX = fileURLToPath(new URL('../node_modules/@camada/core/test/fixtures/blk3/', import.meta.url));
const V4 = {
  bin: readFileSync(FIX + 'v4-basic.bin'),
  meta: JSON.stringify(JSON.parse(readFileSync(FIX + 'v4-basic.meta.json', 'utf8'))),
};

const BLOCKED_IP = '203.0.113.66';     // block side
const CHALLENGED_IP = '192.0.2.20';    // challenge side only
const HTML = { accept: 'text/html', 'sec-fetch-dest': 'document' };
const BASE_CONFIG = { tenant: 'acme', beacon: true, sample: 1, exclude: [], trusted_proxy: { mode: 'none' }, poll_seconds: 30 };
const ENV = { CAMADA_KEY: 'tok-acme.snap-acme', CAMADA_INGEST_URL: 'http://analyst.test', CAMADA_SNAPSHOT_URL: 'http://analyst.test/snapshot' };

// 200 body frame: [u32 LE meta-length][meta JSON][BLK bin]
function frame(): ArrayBuffer {
  const m = new TextEncoder().encode(V4.meta);
  const f = new Uint8Array(4 + m.length + V4.bin.length);
  new DataView(f.buffer).setUint32(0, m.length, true);
  f.set(m, 4); f.set(new Uint8Array(V4.bin), 4 + m.length);
  return f.buffer;
}

let events: Array<Record<string, unknown>>;
let sdkHeaders: string[];
let polls = 0;

const fetchImpl: typeof fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  if (String(url).endsWith('/snapshot')) {
    polls++;
    return new Response(frame(), { status: 200, headers: { etag: `"${JSON.parse(V4.meta).version}"`, 'x-camada-config': JSON.stringify(BASE_CONFIG) } });
  }
  sdkHeaders.push(new Headers(init?.headers).get('x-camada-sdk') ?? '');
  events.push(...(JSON.parse(String(init?.body)) as Array<Record<string, unknown>>));
  return new Response(null, { status: 202 });
}) as typeof fetch;

type Wrapped = (req: Request, server: BunServer) => Promise<Response>;
const html = (s: string) => new Response(s, { headers: { 'content-type': 'text/html' } });

/** The app Bun.serve would run, wrapped the way the README shows. */
function app(opts: CamadaBunOptions = {}): Wrapped {
  return camada({ env: ENV, fetchImpl, ...opts })(async (req) => {
    const { pathname } = new URL(req.url);
    if (pathname === '/') return new Response('home');
    if (pathname === '/cart') return html('<p>cart</p>');
    if (pathname === '/checkout') return html('<p>checkout</p>');
    if (pathname === '/page') return html(`<html><head>${scriptTag(req)}</head><body>page</body></html>`);
    if (pathname === '/redirect') return Response.redirect('http://app.test/', 302);   // immutable headers
    if (pathname === '/login' && req.method === 'POST') { await track(req, 'login_failed', { user: 'alice@example.com' }); return new Response('no', { status: 401 }); }
    return new Response('not found', { status: 404 });
  });
}

/** A stand-in for Bun's server: `requestIP` is the socket, null where Bun has none (a unix socket, a replayed request). */
const server = (address: string | null): BunServer =>
  ({ requestIP: () => (address ? { address, port: 40312, family: 'IPv4' } : null) });

// No waitUntil on this host: one macrotask lets the snapshot load and the batch settle before we look.
const tick = () => new Promise((r) => setTimeout(r, 0));

async function call(a: Wrapped, path: string, init: RequestInit = {}, peer: string | null = '8.8.8.8', origin = 'http://app.test'): Promise<Response> {
  const res = await a(new Request(origin + path, init), server(peer));
  await tick();
  return res;
}

/** The first request is cold (fail open) and loads the snapshot. */
async function primed(opts: CamadaBunOptions = {}): Promise<Wrapped> {
  const a = app(opts);
  await call(a, '/');
  await call(a, '/');   // second request sees the loaded snapshot
  events.length = 0;
  return a;
}

const nonceOf = (page: string) => /name="nonce" value="([0-9a-f]{32})"/.exec(page)![1];
const solve = (nonce: string): string => {
  for (let n = 0; ; n++) if (createHash('sha256').update(`${nonce}.${n}`).digest('hex').startsWith('0000')) return String(n);
};
const ridOf = (page: string): string => /\?r=([0-9a-f-]{36})"/.exec(page)![1];
const postBeacon = (a: Wrapped, body: string, peer = '9.9.9.9'): Promise<Response> =>
  call(a, '/_cam/fp', { method: 'POST', headers: { 'content-type': 'application/json' }, body }, peer);

beforeEach(() => { events = []; sdkHeaders = []; polls = 0; });
afterEach(() => { resetCamada(); vi.useRealTimers(); });

describe('capture', () => {
  it('lets an unlisted request through and ships the event with the real status, the bun tap and this SDK id', async () => {
    const a = await primed();
    const res = await call(a, '/');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('home');
    expect(events.some((e) => e.tap === 'sdk-bun' && e.p === '/' && e.st === 200)).toBe(true);
    await call(a, '/nope');
    expect(events.at(-1)).toMatchObject({ p: '/nope', st: 404 });
    expect(sdkHeaders.length).toBeGreaterThan(0);
    expect(sdkHeaders.every((h) => h === '@camada/bun/0.1.0')).toBe(true);
  });
});

describe('enforcement', () => {
  it('blocks a listed peer with 403, x-block-reason and x-block-version', async () => {
    const a = await primed();
    const res = await call(a, '/', {}, BLOCKED_IP);
    expect(res.status).toBe(403);
    expect(res.headers.get('x-block-reason')).toBe('ip4');
    expect(res.headers.get('x-block-version')).toBeTruthy();
    expect(events.some((e) => e.st === 403 && e.blk === 'ip4' && e.ip === BLOCKED_IP)).toBe(true);
  });

  it('serves the challenge page, verifies the solution, and lets the cookie holder through', async () => {
    const a = await primed();
    const page = await call(a, '/cart', { headers: HTML }, CHALLENGED_IP);
    expect(page.status).toBe(403);
    expect(page.headers.get('x-camada-challenge')).toBe('1');
    expect(page.headers.get('content-type')).toContain('text/html');
    const nonce = nonceOf(await page.text());
    expect(events.some((e) => e.st === 403 && e.blk === 'challenge')).toBe(true);

    const ok = await call(a, '/__camada/challenge', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `nonce=${nonce}&solution=${solve(nonce)}&to=%2Fcart`,
    }, CHALLENGED_IP);
    expect(ok.status).toBe(302);
    expect(ok.headers.get('location')).toBe('/cart');
    expect(ok.headers.get('set-cookie')).toContain(`${CHALLENGE_COOKIE}=`);
    expect(events.some((e) => e.st === 200 && e.ch === 1)).toBe(true);

    const cookie = ok.headers.get('set-cookie')!.split(';')[0];
    expect((await call(a, '/cart', { headers: { cookie, ...HTML } }, CHALLENGED_IP)).status).toBe(200);
  });

  it('answers 403 JSON for a non-HTML challenge', async () => {
    const a = await primed();
    const res = await call(a, '/checkout', { headers: { accept: 'application/json' } });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'challenge_required' });
  });
});

describe('first-party beacon', () => {
  it('serves the IIFE at GET /_cam/b.js', async () => {
    const a = await primed();
    const res = await call(a, '/_cam/b.js?r=abc');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('javascript');
    expect(await res.text()).toBe(iife);
    expect(events).toEqual([]);
  });

  it('relays POST /_cam/fp as a sig:1 row with the server-resolved ip and the bun tap', async () => {
    const a = await primed();
    const res = await postBeacon(a, JSON.stringify({ rid: 'abc', tz: 'UTC', ip: '1.1.1.1', tap: 'proxy' }));
    expect(res.status).toBe(204);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ sig: 1, rid: 'abc', tz: 'UTC', ip: '9.9.9.9', tap: 'sdk-bun' });
  });

  it('still blocks a blocked client at both endpoints', async () => {
    const a = await primed();
    const script = await call(a, '/_cam/b.js', {}, BLOCKED_IP);
    expect(script.status).toBe(403);
    expect(script.headers.get('x-block-reason')).toBe('ip4');
    expect((await postBeacon(a, JSON.stringify({ rid: 'abc' }), BLOCKED_IP)).status).toBe(403);
    expect(events.every((e) => e.blk === 'ip4' && e.sig === undefined)).toBe(true);
  });

  it('scriptTag carries the rid of the page event, and is empty where the wrapper did not run', async () => {
    const a = await primed();
    const page = await (await call(a, '/page')).text();
    const rid = ridOf(page);
    expect(page).toContain(`<script src="/_cam/b.js?r=${rid}" async></script>`);
    expect(events.find((e) => e.p === '/page')).toMatchObject({ rid, tap: 'sdk-bun' });
    expect(scriptTag(new Request('http://app.test/page'))).toBe('');
  });
});

describe('session', () => {
  it('sets _sfp on a first visit, Secure on https, and never overwrites an existing session', async () => {
    const a = await primed();
    const res = await call(a, '/');
    const cookie = res.headers.get('set-cookie')!;
    expect(cookie).toContain('_sfp=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).not.toContain('Secure');
    expect(events.at(-1)).toMatchObject({ ns: 1, sid: /_sfp=([^;]+)/.exec(cookie)![1] });

    expect((await call(a, '/', {}, '8.8.8.8', 'https://app.test')).headers.get('set-cookie')).toContain('; Secure');

    const known = await call(a, '/', { headers: { cookie: '_sfp=known-sid' } });
    expect(known.headers.get('set-cookie')).toBeNull();
    expect(events.at(-1)).toMatchObject({ sid: 'known-sid', ns: 0 });
  });

  it('carries the cookie onto a Response.redirect whose headers are immutable', async () => {
    const a = await primed();
    const res = await call(a, '/redirect');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('http://app.test/');
    expect(res.headers.get('set-cookie')).toContain('_sfp=');
    expect(events.at(-1)).toMatchObject({ p: '/redirect', st: 302 });
  });
});

describe('track', () => {
  it('ships an app-context event joined to the request by rid and sid, with the user hashed', async () => {
    const a = await primed();
    const res = await call(a, '/login', { method: 'POST', headers: { cookie: '_sfp=known-sid' } });
    expect(res.status).toBe(401);
    const row = events.find((e) => e.et === 'login_failed')!;
    expect(row).toMatchObject({ tap: 'sdk-bun', sid: 'known-sid', ip: '8.8.8.8' });
    expect(row.uid).toMatch(/^[0-9a-f]{32}$/);
    expect(row.rid).toBe(events.find((e) => e.p === '/login')!.rid);
    expect(JSON.stringify(events)).not.toContain('alice');
  });

  it('is a silent no-op where the wrapper did not run', async () => {
    await primed();
    await expect(track(new Request('http://app.test/login', { method: 'POST' }), 'login_failed', { user: 'x' })).resolves.toBeUndefined();
    expect(events).toEqual([]);
  });
});

describe('fail open', () => {
  it('is inert without a key and with CAMADA_DISABLED=1: no polls, no events, the app answers', async () => {
    const a = app({ env: {} });
    expect((await call(a, '/', {}, BLOCKED_IP)).status).toBe(200);
    const b = app({ env: { ...ENV, CAMADA_DISABLED: '1' } });
    expect((await call(b, '/', {}, BLOCKED_IP)).status).toBe(200);
    expect(polls).toBe(0);
    expect(events).toEqual([]);
    expect(scriptTag(new Request('http://app.test/'))).toBe('');
  });

  it('answers the app response while ingest is down', async () => {
    const dead = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    const a = app({ fetchImpl: dead });
    expect((await call(a, '/login', { method: 'POST' })).status).toBe(401);
    expect((await call(a, '/')).status).toBe(200);
  });
});

describe('the peer', () => {
  it('is the address server.requestIP vouches for', async () => {
    const a = await primed();
    await call(a, '/', {}, '198.18.0.9');
    expect(events.at(-1)).toMatchObject({ ip: '198.18.0.9' });
    expect((await call(a, '/', {}, BLOCKED_IP)).status).toBe(403);
  });

  it('is null when requestIP has no socket, or there is no server at all', async () => {
    const a = await primed();
    await call(a, '/', {}, null);
    expect(events.at(-1)).toMatchObject({ p: '/', ip: null });
    const res = await a(new Request('http://app.test/'), undefined as unknown as BunServer);
    await tick();
    expect(res.status).toBe(200);
    expect(events.at(-1)).toMatchObject({ ip: null });
  });

  it('never comes from a client header alone', async () => {
    const a = await primed();
    for (const h of ['x-forwarded-for', 'cf-connecting-ip', 'x-real-ip']) {
      const res = await call(a, '/', { headers: { [h]: BLOCKED_IP } }, null);
      expect(res.status, h).toBe(200);
      expect(events.at(-1)).toMatchObject({ ip: null });
    }
    // With a peer, X-Forwarded-For is still ignored until a trusted-proxy config says otherwise.
    expect((await call(a, '/', { headers: { 'x-forwarded-for': BLOCKED_IP } }, '8.8.8.8')).status).toBe(200);
    expect(events.at(-1)).toMatchObject({ ip: '8.8.8.8' });
  });

  it('resolves X-Forwarded-For behind the peer under a trusted-proxy config', async () => {
    const a = await primed({ env: { ...ENV, CAMADA_TRUSTED_PROXY: 'hops:1' } });
    const res = await call(a, '/', { headers: { 'x-forwarded-for': BLOCKED_IP } }, '10.1.1.1');
    expect(res.status).toBe(403);
  });
});

describe('snapshot mode', () => {
  // Only the interval and the clock are faked: the test's own tick() and the fetch stub keep real timers.
  const fakeClock = () => vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });

  it('polls on its own in timer mode, and resetCamada() stops the poller', async () => {
    fakeClock();
    const a = await primed();
    expect(polls).toBe(1);
    await vi.advanceTimersByTimeAsync(31_000);
    await tick();
    expect(polls).toBe(2);   // the interval refreshed without a request
    resetCamada();
    await vi.advanceTimersByTimeAsync(31_000);
    await tick();
    expect(polls).toBe(2);
    await call(a, '/');   // still wired: the next request rebuilds the engine (cold, fails open) and polls again
    expect(polls).toBe(3);
    expect((await call(a, '/', {}, BLOCKED_IP)).status).toBe(403);
  });

  it('CAMADA_SERVERLESS=1 (or mode: lazy) refreshes per request instead', async () => {
    fakeClock();
    const a = await primed({ env: { ...ENV, CAMADA_SERVERLESS: '1' } });
    await vi.advanceTimersByTimeAsync(31_000);
    await tick();
    expect(polls).toBe(1);   // no interval
    await call(a, '/');
    expect(polls).toBe(2);   // the stale request refreshed
    const b = await primed({ mode: 'lazy' });
    polls = 0;
    await vi.advanceTimersByTimeAsync(31_000);
    await tick();
    expect(polls).toBe(0);
    await call(b, '/');
    expect(polls).toBe(1);
  });
});

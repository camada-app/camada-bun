# @camada/bun

camada for [Bun.serve](https://bun.sh/docs/api/http): enforces the tenant snapshot inline (your
ordered custom rules, then block, allow, challenge), serves a first-party proof-of-work challenge
page and beacon, records the outcomes your handlers know (`track()`), and ships wire events in
batches off the response path. A thin binding over `@camada/core/fetch`: the socket peer comes
from `server.requestIP`, the env from `Bun.env`, and the snapshot polls on a timer because a Bun
server lives long enough to have one. Fails open by design — a camada outage or bug never 5xxes
your app.

Not yet on npm — consumed via a `file:` dependency from a sibling checkout.

## Quickstart

```ts
import { camada } from '@camada/bun';

Bun.serve({
  fetch: camada()((req, server) => new Response('hello')),   // reads CAMADA_KEY / CAMADA_INGEST_URL / CAMADA_SNAPSHOT_URL from Bun.env
});
```

`camada()` builds one instance and returns `wrap`; call it once and wrap every handler the
server runs with the same `wrap`. With Bun's `routes` the fallback `fetch` and each route
handler are separate entry points, so each one is wrapped:

```ts
import { camada, scriptTag } from '@camada/bun';

const guard = camada();

Bun.serve({
  routes: {
    '/': guard((req) => new Response(`<html><head>${scriptTag(req)}</head><body>home</body></html>`, { headers: { 'content-type': 'text/html' } })),
    '/api/health': () => new Response('ok'),   // unwrapped: answers whatever the snapshot says
  },
  fetch: guard((req) => new Response('not found', { status: 404 })),
});
```

Env (printed by camada onboarding / `npm run seed` in dev):

```
CAMADA_KEY=<ingest_token>.<snap_token>
CAMADA_INGEST_URL=http://localhost:8787        # dev only; defaults to production ingest
```

The engine is built from `Bun.env` (or `process.env` under Node) on the first request, merged
with whatever the app passes in code:

```ts
const guard = camada({ key: MY_KEY, ingestUrl: MY_INGEST });
```

Without `CAMADA_KEY` the wrapper is inert (one log line, no requests, no enforcement), so an
unprovisioned environment behaves exactly as if camada were not installed.

## What it does per request

1. Keeps the snapshot fresh on an unref'd 30 s timer (the server steers the cadence per tenant)
   and drains the event queue on `beforeExit`, `SIGTERM` and `SIGINT`. `mode: 'lazy'` or
   `CAMADA_SERVERLESS=1` refreshes per request instead, for a Bun that is not a long-lived
   process. Every poll and event batch carries `x-camada-sdk: @camada/bun/<version>`, and polls
   ask for snapshot v5 (`x-camada-snapshot: 5`) — the container that carries your ordered
   custom rules.
2. Resolves the client from the socket Bun vouches for (`server.requestIP(req)`), then
   `X-Forwarded-For` under your tenant's trusted-proxy config. No header is ever trusted on its
   own: without a trusted-proxy config a forwarded header is just another header the caller
   controls, and `cf-connecting-ip` / `x-real-ip` are never read.
3. Runs your ordered custom rules, then the allow, block and challenge lists.
4. **Block** → `403` with `x-block-reason` before your handler; the event still ships, with
   `st: 403` and `blk: <reason>` so the analyst counts SDK blocks apart from your own 403s.
5. **Skip** → a skip rule or the allow list wins over a wider block.
6. **Challenge** → a `403` proof-of-work page: no external assets, `no-store`, an inline SHA-256
   solver that posts to `POST /__camada/challenge`, which sets `_cch` (an HMAC token bound to
   the client ip, 1 h) and 302s back. Non-HTML requests get `403 {"error":"challenge_required"}`.
7. Otherwise your handler runs, the `_sfp` session cookie is appended on a first visit (also
   onto a `Response.redirect()`, whose headers are immutable — the response is rebuilt around
   the same body), and the settled response ships one batched, redacted event with its real
   status (Authorization and Cookie values never leave the process — see `@camada/core`).

## Options

| option | default | meaning |
|---|---|---|
| `key` | `env.CAMADA_KEY` | `<ingest_token>.<snap_token>`; without it the wrapper is inert |
| `ingestUrl` | `env.CAMADA_INGEST_URL` | ingest base; batches go to `<ingestUrl>/e` |
| `snapshotUrl` | `<ingestUrl>/snapshot` | snapshot endpoint |
| `trustedProxy` | server config | `none` / `vercel` / `hops:N` / `cidrs:a,b`, or the parsed object |
| `challenge` | `true` | serve the proof-of-work page for `challenge` verdicts |
| `challengePath` | `/__camada/challenge` | where that page posts its solution |
| `snapshotVersion` | `5` | `4` drops the custom rules, `3` the allow/challenge sides too |
| `scriptPath` | `/_cam/b.js` | where the first-party beacon script is served |
| `fpPath` | `/_cam/fp` | where that script posts the beacon; keep it in `scriptPath`'s directory |
| `mode` | `timer` | `timer` polls the snapshot on an interval; `lazy` refreshes per request (`CAMADA_SERVERLESS=1` forces it) |
| `env` | `Bun.env` | overrides the host env (tests, and apps that read config themselves) |

`CAMADA_CHALLENGE=0` in the env switches the challenge off without a code change.

`CAMADA_DISABLED=1` in the env switches everything off, checked per request.

## The first-party beacon

Bots that never run JavaScript are the cheapest to catch. Put the tag in the `<head>` of the
pages you render and the wrapper does the rest:

```ts
import { camada, scriptTag } from '@camada/bun';

Bun.serve({
  fetch: camada()((req) => new Response(`<html><head>${scriptTag(req)}</head><body>…</body></html>`, { headers: { 'content-type': 'text/html' } })),
});
```

`scriptTag(req)` returns `<script src="/_cam/b.js?r=<rid>" async></script>` — the `rid` is this
request's event id, so the analyst joins the beacon to the page view. The wrapper serves the
script at `GET /_cam/b.js` (cacheable, 1 h) and relays `POST /_cam/fp` (≤ 32 KB, answers 204)
onto the event batch as a `sig: 1` row stamped with the client ip camada resolved — never the
one the body claims. Both endpoints sit behind the verdict: a blocked client gets 403 there
too. The tag is `''` when camada is off for the request or the project turned the beacon off
in its settings, and the endpoints stand down with it.

With `routes`, the two paths are answered by whichever wrapped handler Bun dispatches to — the
fallback `fetch` in the example above — so wrap the fallback even when every route is wrapped.
Moving them (`camada({ scriptPath: '/api/_cam/b.js', fpPath: '/api/_cam/fp' })`) keeps the
same rule: the script derives the post path from its own `src`, so the two must share a directory.

## App-context events

The wire shows a `POST /login`; only your handler knows whether it failed. Tell camada:

```ts
import { camada, track } from '@camada/bun';

Bun.serve({
  fetch: camada()(async (req) => {
    const ok = await signIn(req);
    if (!ok) track(req, 'login_failed', { user: email });   // await optional — it never throws
    return ok ? Response.redirect('/') : new Response('Invalid credentials', { status: 401 });
  }),
});
```

`track(req, event, { user? })` ships `{ et, uid, rid, sid, ip, ts }` joined to this request's
event. The user identifier is HMAC-hashed in-process with the ingest token — the raw value never
leaves the process. It never throws and is a no-op where the wrapper did not run. The event name
is free-form; the analyst's rules read this vocabulary:

| event | when |
|---|---|
| `login_failed` / `login_succeeded` | a credential check settled |
| `signup` | an account was created |
| `password_reset` | a reset was requested |
| `mfa_failed` | a second factor was rejected |
| `payment_failed` / `payment_succeeded` | a charge settled |
| `coupon_failed` | a promo code was rejected |

## What this tap can see

This is the in-app position: the beacon, the client hints the browser sends, the real response
status, the `_sfp` session and the app context from `track()`. Bun vouches for one connection
fact — the socket address from `server.requestIP` — and nothing else: no ASN, country or TLS
fingerprint (those rules never match here), no client protocol (the event's `proto` is null; a
forwarded protocol header is never read for it), and `Headers` normalises order, so the
raw-wire-order signal is not available either. The analyst knows all of that from the tap's
capability mask (`sdk-bun`) and never scores an absence as evidence. Behind a proxy, set
`trustedProxy` (or `CAMADA_TRUSTED_PROXY`) so the client behind it is the one enforced.

## Fail open

Every entry point runs inside camada's guard. A dead ingest, a corrupt snapshot, a bug in this
package: telemetry is lost, the request is not.

## Tests

`npm test` runs the suite under vitest in Node with a stub `server`; `bun test` runs the same
file under Bun (it rewrites the `vitest` import to `bun:test`).

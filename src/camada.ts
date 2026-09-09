// @camada/bun — the Bun.serve binding for @camada/core/fetch. `wrap` sits around the app's fetch
// handler: the socket peer comes from `server.requestIP` (the one address Bun vouches for), the
// env from Bun.env, and there is no waitUntil — a long-lived process polls on a timer and drains
// on exit instead. Bun has no per-request context object, so the Request itself keys the slot.
import { TAP_BUN, guarded } from '@camada/core';
import { createFetchCamada, withSetCookie, track as coreTrack, scriptTag as coreScriptTag, type FetchCamada, type FetchCamadaOptions, type FetchVars } from '@camada/core/fetch';
import iife from '@camada/browser/iife-string';
import { SDK_ID } from './version.js';

/** The one thing the wrapper needs from Bun's server, typed structurally so the emitted types need no `bun` import; any `Bun.Server` satisfies it. */
export interface BunServer { requestIP(req: Request): { address: string } | null }
/** A Bun fetch handler. `undefined`/`void` is what Bun's own websocket pattern returns after `server.upgrade(req)`. */
export type BunHandler<S extends BunServer = BunServer, R extends Response | undefined | void = Response> = (req: Request, server: S) => R | Promise<R>;
export type CamadaBunOptions = FetchCamadaOptions;
export type CamadaBunVars = FetchVars;

const slots = new WeakMap<Request, FetchVars>();   // set only when the app is about to run; camada's own answers leave nothing
const instances = new Set<FetchCamada>();

/**
 * Builds one camada instance and returns `wrap`, which turns a Bun fetch handler into a guarded
 * one: `Bun.serve({ fetch: camada()(handler) })`. Timer mode by default (a server process lives
 * long enough to poll); `mode: 'lazy'` or CAMADA_SERVERLESS=1 switches to per-request refresh.
 */
export function camada(opts: CamadaBunOptions = {}) {
  const cam = createFetchCamada({ tap: TAP_BUN, sdk: SDK_ID, iife }, { ...opts, mode: opts.mode ?? 'timer' });
  instances.add(cam);
  return function wrap<S extends BunServer, R extends Response | undefined | void>(handler: BunHandler<S, R>): (req: Request, server: S) => Promise<Response | R> {
    return async (req, server) => {
      // Guarded: a runtime that is not Bun (or a Bun without a socket for this request) hands us
      // no peer rather than a throw. Client headers are core's to judge under the trusted-proxy rules.
      const peer = guarded(() => server?.requestIP?.(req)?.address ?? null, null);
      const r = await cam.before(req, { peer, env: globalThis.Bun?.env ?? globalThis.process?.env });   // Bun.env is process.env under Bun; the fallback is this suite under Node
      if (!r) return handler(req, server);
      if (r.response) return r.response;
      slots.set(req, r.vars);
      let res: R;
      try {
        res = await handler(req, server);
      } catch (err) {
        cam.after(req, r.vars, 500);   // Bun answers 500 for a thrown handler (an `error` callback returning its own status is not visible here)
        throw err;
      }
      if (!res) { cam.after(req, r.vars, 101); return res; }   // a websocket upgrade: Bun answers 101 itself, so there is no Response to carry a cookie
      cam.after(req, r.vars, res.status);
      return r.vars.sessionCookie ? withSetCookie(res, r.vars.sessionCookie) : res;
    };
  };
}

/** An outcome the wire cannot show (`login_failed`, `signup`, …) joined to this request's event;
 *  the user is HMAC-hashed in-process. A silent no-op where the wrapper did not run. */
export const track = (req: Request, event: string, data?: { user?: string }): Promise<void> => coreTrack(slots.get(req), event, data);

/** The beacon `<script>` tag for an HTML response — `''` where the wrapper did not run or the tenant turned the beacon off. */
export const scriptTag = (req: Request): string => coreScriptTag(slots.get(req));

/** Test/reset hook: stops every poller and exit handler of every instance this module created. */
export function resetCamada(): void {
  for (const cam of instances) cam.reset();
}

// @camada/bun — the Bun.serve binding for @camada/core/fetch. `wrap` sits around the app's fetch
// handler: the socket peer comes from `server.requestIP` (the one address Bun vouches for), the
// env from Bun.env, and there is no waitUntil — a long-lived process polls on a timer and drains
// on exit instead. Bun has no per-request context object, so the Request itself keys the slot.
import type { Server } from 'bun';
import { TAP_BUN, guarded } from '@camada/core';
import { createFetchCamada, withSetCookie, type FetchCamada, type FetchCamadaOptions, type FetchVars } from '@camada/core/fetch';
import iife from '@camada/browser/iife-string';
import { SDK_ID } from './version.js';

/** The one thing the wrapper needs from Bun's server; any `Bun.Server<T>` satisfies it. */
export type BunServer = Pick<Server<unknown>, 'requestIP'>;
export type BunHandler<S extends BunServer = BunServer> = (req: Request, server: S) => Response | Promise<Response>;
export type CamadaBunOptions = FetchCamadaOptions;
export type CamadaBunVars = FetchVars;

interface Slot { cam: FetchCamada; vars: FetchVars }
const slots = new WeakMap<Request, Slot>();   // set only when the app is about to run; camada's own answers leave nothing
const instances = new Set<FetchCamada>();

/** Bun.env is process.env under Bun; the fallback covers this suite running under Node. */
const hostEnv = (): Record<string, string | undefined> | undefined => {
  const g = globalThis as { Bun?: { env?: Record<string, string | undefined> }; process?: { env?: Record<string, string | undefined> } };
  return g.Bun?.env ?? g.process?.env;
};

/**
 * Builds one camada instance and returns `wrap`, which turns a Bun fetch handler into a guarded
 * one: `Bun.serve({ fetch: camada()(handler) })`. Timer mode by default (a server process lives
 * long enough to poll); `mode: 'lazy'` or CAMADA_SERVERLESS=1 switches to per-request refresh.
 */
export function camada(opts: CamadaBunOptions = {}) {
  const cam = createFetchCamada({ tap: TAP_BUN, sdk: SDK_ID, iife }, { ...opts, mode: opts.mode ?? 'timer' });
  instances.add(cam);
  return function wrap<S extends BunServer>(handler: BunHandler<S>): (req: Request, server: S) => Promise<Response> {
    return async (req, server) => {
      // Guarded: a runtime that is not Bun (or a Bun without a socket for this request) hands us
      // no peer rather than a throw. Client headers are core's to judge under the trusted-proxy rules.
      const peer = guarded(() => server?.requestIP?.(req)?.address ?? null, null);
      const env = guarded(hostEnv, undefined);
      const r = await cam.before(req, { peer, env });
      if (!r) return handler(req, server);
      if (r.response) return r.response;
      slots.set(req, { cam, vars: r.vars });
      const res = await handler(req, server);
      cam.after(req, r.vars, res.status);
      return r.vars.sessionCookie ? withSetCookie(res, r.vars.sessionCookie) : res;
    };
  };
}

/** An outcome the wire cannot show (`login_failed`, `signup`, …) joined to this request's event;
 *  the user is HMAC-hashed in-process. A silent no-op where the wrapper did not run. */
export function track(req: Request, event: string, data?: { user?: string }): Promise<void> {
  const s = guarded(() => slots.get(req), undefined);
  return s ? s.cam.track(s.vars, event, data) : Promise.resolve();
}

/** The beacon `<script>` tag for an HTML response — `''` where the wrapper did not run or the tenant turned the beacon off. */
export function scriptTag(req: Request): string {
  const s = guarded(() => slots.get(req), undefined);
  return s ? s.cam.scriptTag(s.vars) : '';
}

/** Test/reset hook: stops every poller and exit handler of every instance this module created. */
export function resetCamada(): void {
  for (const cam of instances) cam.reset();
}

// @camada/bun — the one-line install for a Bun.serve app:
//   Bun.serve({ fetch: camada()(handler) });   // env: CAMADA_KEY (+ CAMADA_INGEST_URL / CAMADA_SNAPSHOT_URL in dev)
//   new Response(`<head>${scriptTag(req)}</head>…`, { headers: { 'content-type': 'text/html' } })   // the first-party beacon
//   track(req, 'login_failed', { user })       // an outcome the wire cannot show
export { camada, track, scriptTag, resetCamada, type CamadaBunOptions, type CamadaBunVars, type BunServer, type BunHandler } from './camada.js';

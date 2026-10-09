# Changelog

## 0.1.3 (2026-10-09; follows 0.1.2)

Needs `@camada/core` 0.5.1.

### Fixed

- The snapshot client no longer re-polls back to back when `/snapshot` fails. It keeps its blocks and
  waits max(`retry-after`, 5 s), capped at the refresh interval (through `@camada/core` 0.5.1,
  camada-all-pbv9).

## 0.1.2 (2026-10-04; follows 0.1.1)

Needs `@camada/core` 0.5.0.

### Added

- `x-rid` response header: the rid of the request's event row, on every response the app answers,
  via core's `finish()` (a faithful copy when the headers are immutable). Not on camada's own
  answers or a 101.

### Changed

- `ts` is the request start, so `[ts, ts + dur]` is when the request ran.
- `dur` for a `text/event-stream` response runs to its last byte, or until the client leaves. The
  SSE body is re-wrapped with the same status and headers. Any other response goes out untouched
  (string and Blob bodies keep Bun's implicit `Content-Type` and `Content-Length`) and ships at
  once, with `dur` = time to first byte.

### Fixed

- Path rules match the canonical path (through `@camada/core` 0.5.0). A percent-encoded,
  upper-cased or trailing-slash spelling of a blocked path used to slip past the block.

Using Hono on Bun? WebSocket upgrades through `hono/bun` are fixed in `@camada/hono` 0.3.2.

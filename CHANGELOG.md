# Changelog

## 0.1.2 (unreleased; follows 0.1.1)

Needs `@camada/core` 0.5.0.

### Changed

- `ts` is the request start, so `[ts, ts + dur]` is when the request ran.
- `dur` for a `text/event-stream` response runs to its last byte, or until the client leaves. The
  SSE body is re-wrapped with the same status and headers. Any other response goes out untouched,
  so string and Blob bodies keep Bun's implicit `Content-Type` and `Content-Length`, and ships at
  once, with `dur` = time to first byte.

Using Hono on Bun? WebSocket upgrades through `hono/bun` are fixed in `@camada/hono` 0.3.2.

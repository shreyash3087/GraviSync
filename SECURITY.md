# Security Model — Antigravity Remote Connect

## Architecture

This extension uses a "Local-First" security model. It bridges your running Antigravity session to a mobile web app using the Chrome DevTools Protocol (CDP). It never extracts OAuth tokens or interacts with AI provider APIs directly.

## Threat Model

| Threat | Mitigation |
|:---|:---|
| Unauthorized access via tunnel URL guessing | HMAC-signed magic link tokens with 10-min expiry; URL alone is insufficient |
| Session hijacking | `httpOnly` + `Secure` + `SameSite=Strict` cookies; 256-bit random session ID |
| Replay attacks | Token nonce tracked server-side; each magic link is single-use |
| Brute-force password | Rate limiting: 5 attempts / 5 min per IP, 15-min block after limit |
| Man-in-the-middle | HTTPS for local (self-signed), TLS for ngrok tunnel |
| XSS on mobile app | Strict CSP: `script-src 'self'`; zero inline JS |
| CDP over-exposure | Only whitelisted operations; no `eval()` passthrough |
| Resource exhaustion | Max 5 concurrent clients; server auto-timeout configurable |

## Authentication Flow

1. **Token Generation**: Server generates a 256-bit session secret at startup
2. **Magic Link**: QR encodes `HMAC-SHA256(secret, nonce:timestamp)` — valid for 10 minutes, single-use
3. **Session**: After validation, a 256-bit session cookie is issued (`httpOnly`, `Secure`, `SameSite=Strict`)
4. **WebSocket**: Every WS upgrade validates the session cookie
5. **Expiry**: Sessions expire after 24h (configurable); idle timeout after 1h

## Secrets Management

- **Zero hardcoded secrets** — all tokens/passwords generated via `crypto.randomBytes()`
- Session secret lives only in server process memory — never written to disk
- ngrok auth token stored in VS Code settings (encrypted by the IDE)

## Content Security Policy

```
Content-Security-Policy:
  default-src 'none';
  script-src 'self';
  style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;
  font-src 'self' https://fonts.gstatic.com;
  img-src 'self' data: blob:;
  connect-src 'self' wss:;
  frame-ancestors 'none'
```

## Reporting Vulnerabilities

If you discover a security vulnerability, please email [security@example.com] or open a private advisory on GitHub. Do not open public issues for security problems.

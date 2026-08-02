# Security Policy

## Reporting a vulnerability

Please report privately rather than opening a public issue: use GitHub's
[private vulnerability reporting](https://github.com/zscontributor/open-rocket-chat-gateway/security/advisories/new)
on this repository.

Please include the affected version or commit, what an attacker can achieve, and steps to reproduce.

We aim to acknowledge within a few days. This is a volunteer-maintained project, so please be patient with fixes.

## Scope

This project is a proxy in front of Rocket.Chat. Vulnerabilities **in Rocket.Chat itself** should go to
[Rocket.Chat's security team](https://docs.rocket.chat/docs/security), not here.

In scope for this repository:

- Session handling — cookie signing, fixation, expiry, cross-site exposure.
- Leakage of Rocket.Chat auth tokens to browsers, logs, or error responses.
- Authorisation gaps where the gateway lets a session act outside its own permissions.
- The media proxy serving files a session should not be able to read.
- WebSocket upgrade authentication and origin checks.

## Why the gateway is mandatory for the web client

The [web client](https://github.com/zscontributor/open-rocket-chat-client) has no mode that connects a browser
straight to Rocket.Chat. Rocket.Chat's REST API authenticates with an `X-Auth-Token` header, so a browser
talking to it directly would have to hold a credential granting full account access, recoverable by any XSS
bug on the page. Keeping that token server-side is the property this project exists to provide, and it is not
one that can hold "sometimes".

The SDK packages (`rc-rest-client`, `rc-realtime-client`) are still usable on their own — from a script, a
bot or another server-side service. They are simply not intended to run in a browser holding real credentials.

## What this project does not protect against

The gateway relies on Rocket.Chat for authorisation of everything it forwards. It narrows the blast radius of a compromised browser session; it does not add a permission model of its own, and it is not a substitute for correct Rocket.Chat configuration.

## Deployment notes

- `SESSION_SECRET` must be a high-entropy value, kept secret, and stable across restarts.
- Use HTTPS in production. `SESSION_COOKIE_SAMESITE=none` requires it, and browsers silently drop the cookie otherwise.
- Set `CORS_ORIGINS` to your frontend's exact origins. It also gates WebSocket upgrades — a wildcard would let any site open an authenticated socket with a visitor's cookie.
- Prefer `REDIS_URL` in multi-instance deployments so sessions are revoked everywhere at once.

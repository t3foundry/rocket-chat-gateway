# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Until 1.0.0, minor versions may carry breaking changes to `@t3foundry/open-rocket-chat-api-contract`; a contract change lands here together with a matching pull request in [open-rocket-chat-client](https://github.com/zscontributor/open-rocket-chat-client).

## [0.1.1] — 2026-08-02

A file upload of any real size failed against a Rocket.Chat that is not on localhost, and a cancelled upload landed in the room anyway. Pairs with **client 0.1.1**. No change to `@t3foundry/open-rocket-chat-api-contract`.

### Fixed

- **Uploads no longer share the ordinary request timeout.** Every call to Rocket.Chat was capped at 15s, uploads included — but how long an upload takes is a property of the file's size and of the link, not of how healthy the server is. Against a real remote server at ~2.2 MB/s a 40 MB file landed in 12.6s and a 60 MB file failed at 15.2s, reported to the user as `upstream_unavailable` — "the Rocket.Chat server is not responding" — about a server that was answering perfectly well. Uploading the same file straight into Rocket.Chat worked, because a browser applies no such cap. File-carrying requests now get their own window: `UPLOAD_TIMEOUT_SECONDS`, defaulting to 300s, which is the largest upload `MAX_UPLOAD_BYTES` admits at roughly 350 KB/s. Ordinary calls keep their 15s, so a server that has genuinely stopped answering still fails fast
- **Cancelling an upload now reaches Rocket.Chat.** Aborting in the browser only cancelled the browser's own request; the gateway already held the bytes and carried on, so a file taken back mid-upload appeared in the room seconds after the sender had let go of it. The client disconnecting now aborts the upstream call, through both legs of the two-phase upload
- Message fields sent after the file in a multipart request — a caption, most often — are read once the file has gone up, so they land whichever order a client writes them in

### Changed

- **An upload is relayed as it arrives rather than collected first.** Rocket.Chat receives the file while the browser is still sending it, so the upload costs the slower of the two legs rather than their sum, and the gateway no longer holds an entire file per upload in flight — previously bounded only by how many people upload at once. `FormData` cannot carry a stream, so the multipart body is now written directly
- **The upload route is detected before the file is read, not by spending it on the attempt.** A streamed body cannot be sent twice, so the old "try `rooms.media`, fall back to `rooms.upload` on a 404" probe is gone: by the time the first attempt fails the bytes are spent. A request carrying no file settles it instead — Rocket.Chat answers `error-no-file` where the route exists and `unknown-endpoint` where it does not, and stores nothing either way. Still cached per server, so it costs one request per server per process

### Notes for operators

- `UPLOAD_TIMEOUT_SECONDS` is new and optional; the 300s default suits `MAX_UPLOAD_BYTES` at its own default of 100 MB. Raise both together, or raise the timeout alone when the Rocket.Chat server is far enough away that a large upload cannot finish inside the window
- Uploads now reach Rocket.Chat with `Transfer-Encoding: chunked` and no `Content-Length`. Verified against a self-hosted Rocket.Chat 8.6 and against a deployment behind a CDN; a reverse proxy in front of Rocket.Chat that refuses chunked request bodies would need configuring

### Known limitation

A browser's upload progress can only measure the browser-to-gateway leg. Neither undici's `fetch` nor `node:https` propagates TLS socket backpressure at these sizes — both accept roughly 17 MB of a 20 MB file at 30 MB/s — so streaming does not make a sender's progress track the gateway-to-Rocket.Chat leg. Where the gateway sits near Rocket.Chat, which is the deployment this is built for, that leg is short and the measurement is sound.

## [0.1.0] — 2026-08-02

First public release. A backend-for-frontend that fronts a [Rocket.Chat](https://rocket.chat) server with a small, stable, version-independent API — plus the TypeScript SDK it is built from. It keeps the Rocket.Chat auth token server-side and hands the browser an opaque `HttpOnly` session cookie instead, absorbs upstream API churn behind a versioned contract, and normalises Rocket.Chat's Meteor-shaped records once so no client has to.

Pairs with **client 0.1.0**. This is a `0.x` release: it has run in production at [Z-SOFT](https://z-soft.com.vn) for internal team chat, but the API contract is not frozen yet.

> Not affiliated with, endorsed by, or supported by Rocket.Chat Technologies Corp. "Rocket.Chat" is a trademark of its respective owner, used here only to describe compatibility.

### Added

**The gateway service** — NestJS on Fastify, a single Node process serving HTTP under `/api/v1` and realtime at `/ws`.

- Cookie sessions: sign-in exchanges credentials for an opaque `HttpOnly` cookie; the Rocket.Chat `X-Auth-Token` never leaves the server. In memory by default, Redis (`REDIS_URL`) for more than one instance
- **Multi-server as the default shape**: signing in again with the same cookie adds a server to the session, `X-Server-Id` picks which one a request acts on, and one client WebSocket carries them all. Asking for a server the session is not signed in to is a `401` rather than a `404`. The Rocket.Chat servers are ordinary, unmodified deployments that know nothing about each other
- OAuth sign-in: `auth/servers` reports `passwordLoginEnabled` and the enabled `loginServices` with a ready-to-open `authorizeUrl` resolved from Rocket.Chat's service records, so a client renders buttons without knowing where any provider lives. `auth/login/oauth` trades the credential pair for a session. Flows this cannot drive (Twitter OAuth 1.0a, SAML, CAS, LDAP, Apple) are left out
- Runtime capability probing, cached per server, so servers that diverge — the `rooms.upload` versus `rooms.media` + `rooms.mediaConfirm` split, for instance — are handled without branching on a version string. What a server genuinely cannot do returns `unsupported_by_server`, not a confusing 404
- Media proxied with server-side credentials (`files/*`, `avatars/:username`, `avatars/room/:id`, `?serverId=`), because an `<img>` cannot carry a token
- Errors always match `ApiErrorSchema` with a stable `code`; prose is negotiated with `Accept-Language` (English and Japanese today) while codes, `upstream` identifiers and structured `details` never change — see [docs/i18n.md](docs/i18n.md)
- Liveness and readiness at `health` and `health/upstream`; structured logging with pino; Helmet, CORS and cookie configuration for cross-site deployments

**HTTP API** covering auth and session, server capabilities, rooms (list with delta sync, create, edit, direct messages, read/unread, favourite/hide, leave, prune, avatar), members and role assignments, messages (history anchored on `before`/`after`, send with `clientMessageId` and `threadId`, edit, delete, reactions, pin, star, search), threads, the pinned/starred/mentions collections, files and upload, per-room notification preferences, custom emoji, slash commands, and user profiles, search, presence and avatar.

**Realtime** at `/ws` with the same session cookie.

- Events: `connection.ready`, `connection.degraded`, `message.created`, `message.updated`, `message.deleted`, `room.updated`, `room.removed`, `typing.changed`, `presence.changed`, `room.read`, `notification`
- Commands: `room.subscribe`, `room.unsubscribe`, `typing.set`, `ping`
- One upstream Rocket.Chat connection per session per server, shared by every tab that session has open, so five open tabs cost Rocket.Chat one connection rather than five
- `notification` arrives without any subscription, for every room the user belongs to — Rocket.Chat has already weighed the subscription's alert setting, mentions, presence and workspace defaults, so a client shows it rather than re-deriving the decision
- `gapBefore` on a message page marks a range that could not be made contiguous, so a client reloads the room instead of appending

**Packages published from this repository at 0.1.0** — usable on their own; take the two clients if you only want a typed Rocket.Chat SDK for a script, a bot or another server-side service.

| Package                                          | What it is                                                                                     |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `@t3foundry/open-rocket-chat-api-contract`       | Domain models, HTTP contract and realtime events as zod schemas, shared by gateway and clients |
| `@t3foundry/open-rocket-chat-rc-rest-client`     | Typed, dependency-free client for the Rocket.Chat REST API                                     |
| `@t3foundry/open-rocket-chat-rc-realtime-client` | DDP-over-WebSocket client with reconnect and subscription recovery                             |
| `@t3foundry/open-rocket-chat-rc-adapter`         | Normalises Rocket.Chat records into the domain model                                           |

These are not meant to run in a browser holding real credentials — that puts a full-access Rocket.Chat token on the page, which is what the gateway exists to avoid. See [SECURITY.md](SECURITY.md).

**Deployment and tooling**

- `docker/gateway.Dockerfile`, a full `docker/stack.compose.yml`, and `docker/rocketchat.compose.yml` for a local Rocket.Chat + MongoDB (`pnpm run rc:up`)
- Configuration through [`apps/gateway/.env.example`](apps/gateway/.env.example); the two that matter are `ROCKETCHAT_SERVERS` (a bare URL, or a JSON array of `{id, name, url, publicUrl}`) and `SESSION_SECRET` (at least 32 characters, stable across restarts)
- An end-to-end suite that drives an actual Rocket.Chat rather than mocks — it logs in, sends, edits, reacts, uploads, deletes and asserts realtime delivery
- GitHub Actions for formatting, linting, types, build, unit tests, a dependency audit, CodeQL, and the Git Flow branch policy

### Requirements

- Node.js >= 20.11, pnpm 10.28.2
- Rocket.Chat 6.x or later; tested end-to-end against **8.6.1**
- Redis only if you run more than one instance

### Notes for operators

- If the frontend is on a different site, set `SESSION_COOKIE_SAMESITE=none` (which forces `Secure`, so HTTPS is required) and list its origin in `CORS_ORIGINS`. Same-site deployments need neither
- OAuth requires the browser client to be served from the same origin as Rocket.Chat, since the credential secret lands in that origin's storage. Rocket.Chat's `Site_Url` must match the address people actually use
- `fastify` is pinned to 5.11.0 (two copies break Nest's Fastify plugin typing) and `find-my-way` forward to `^9.7.0` for GHSA-c96f-x56v-gq3h, which `@nestjs/platform-fastify` still resolves transitively

### Not included

- **Omnichannel (Livechat)** — none of Rocket.Chat's `/v1/livechat/*` API is wrapped: no queue, routing, departments, transfers, canned responses, transcripts or visitor records. What exists is what ordinary room handling brings along: a room with `t: 'l'` normalises to the `omnichannel` room type and its system messages come through as typed events. Contributions start here — schemas in `packages/api-contract`, normalisation in `packages/rc-adapter`, routes in `apps/gateway` — because the client has nothing to call until the routes exist
- The packages are not on npm yet; the client repository resolves `@t3foundry/open-rocket-chat-api-contract` from a sibling checkout via a pnpm `link:` override

### Licence

MIT © [Z-SOFT Co., Ltd.](https://z-soft.com.vn) The whole production dependency tree is 92 packages under permissive terms only — no copyleft licence appears in what you deploy.

[0.1.1]: https://github.com/zscontributor/open-rocket-chat-gateway/releases/tag/v0.1.1
[0.1.0]: https://github.com/zscontributor/open-rocket-chat-gateway/releases/tag/v0.1.0

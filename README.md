# Open Rocket.Chat Gateway

**English** · [Tiếng Việt](README.vi.md) · [日本語](README.ja.md)

A backend-for-frontend that fronts a [Rocket.Chat](https://rocket.chat) server with a small, stable, version-independent API — plus the TypeScript SDK it is built from.

> **Not affiliated with, endorsed by, or supported by Rocket.Chat Technologies Corp.**
> This is an independent, community-driven project. "Rocket.Chat" is a trademark of its respective owner and is used here only to describe compatibility.

Its companion frontend lives in [open-rocket-chat-client](https://github.com/zscontributor/open-rocket-chat-client).

## Why a gateway

Talking to Rocket.Chat straight from a browser works, but it forces three problems onto every client that tries:

**The auth token ends up in the browser.** Rocket.Chat's REST API authenticates with `X-Auth-Token` and `X-User-Id` headers, so a browser client has to hold a long-lived token that grants full account access. Any XSS bug hands it over. This gateway keeps the token server-side and gives the browser an opaque `HttpOnly` session cookie instead.

**The API shifts under you.** Endpoints are renamed and replaced between releases — file upload moved from `rooms.upload/:rid` to a two-phase `rooms.media` + `rooms.mediaConfirm` handshake, and both are still in the field. The gateway detects which one a server speaks and hides the difference.

**The data model leaks Meteor.** Rooms encode their kind in a single letter plus two orthogonal flags; read state lives on a separate `subscription` record from the room itself; timestamps arrive as ISO strings over REST and `{ $date }` over WebSocket. Every client re-derives the same normalisations. This one does it once.

```
┌────────────────────────────────────────────────────────────────┐
│  Browser · apps/web                                            │
│  React 19 static bundle. Holds one opaque HttpOnly session     │
│  cookie — never a Rocket.Chat token.                           │
│                                                                │
│   ┌───┐  server rail     query cache            one WebSocket  │
│   │ A │◀── active        ['server', <id>, …]    for every      │
│   │ B │                                         server         │
│   └───┘                                                        │
└──────────────────────┬───────────────────────┬─────────────────┘
                       │                       │
             HTTPS /api/v1                 WSS /ws
      session cookie + X-Server-Id      session cookie
                       │                       │
                       ▼                       ▼
┌────────────────────────────────────────────────────────────────┐
│  Gateway · apps/gateway                                        │
│  NestJS + Fastify, a single Node process                       │
│                                                                │
│  session store — in memory, or Redis for more than one         │
│  instance:   cookie ──▶ { A: X-Auth-Token, B: X-Auth-Token }   │
│                                                                │
│  one upstream connection per session per server, shared by     │
│  every tab that session has open                               │
└────────┬───────────────────────┬───────────────────────┬───────┘
         │                       │                       │
   REST + DDP              REST + DDP              REST + DDP
  X-Auth-Token            X-Auth-Token            X-Auth-Token
         │                       │                       │
         ▼                       ▼                       ▼
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Rocket.Chat A  │     │  Rocket.Chat B  │     │  Rocket.Chat …  │
│    + MongoDB    │     │    + MongoDB    │     │                 │
└─────────────────┘     └─────────────────┘     └─────────────────┘
```

Several Rocket.Chat servers behind one session is the default shape rather than an add-on: signing in again with the same cookie adds a server, `X-Server-Id` picks which one a request acts on, and a single client WebSocket carries them all. The servers themselves are ordinary, unmodified deployments that know nothing about each other or about this arrangement — which is why room ids are only unique within one of them, and why the server travels with every request. The browser shown here is [open-rocket-chat-client](https://github.com/zscontributor/open-rocket-chat-client), but nothing above the API boundary is specific to it.

## What you get

| Package                                | Purpose                                                                                         |
| -------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `@t3foundry/open-rocket-chat-api-contract`       | Domain models, HTTP contract and realtime events as zod schemas. Shared by gateway and clients. |
| `@t3foundry/open-rocket-chat-rc-rest-client`     | Typed, dependency-free client for the Rocket.Chat REST API.                                     |
| `@t3foundry/open-rocket-chat-rc-realtime-client` | DDP-over-WebSocket client with reconnect and subscription recovery.                             |
| `@t3foundry/open-rocket-chat-rc-adapter`         | Normalises Rocket.Chat records into the domain model.                                           |
| `apps/gateway`                         | The NestJS + Fastify service that ties them together.                                           |

The packages are usable on their own. If you only want a typed Rocket.Chat SDK and no gateway, take
`rc-rest-client` and `rc-realtime-client` — for a script, a bot, or another server-side service.

They are not meant to run in a browser holding real credentials: doing so puts a full-access Rocket.Chat token
on the page, which is what the gateway exists to avoid. See [SECURITY.md](SECURITY.md).

## Quick start

```bash
pnpm install
pnpm run build

# Rocket.Chat + MongoDB on localhost:3000, admin/admin-password-123
pnpm run rc:up

cp apps/gateway/.env.example apps/gateway/.env
pnpm --filter @t3foundry/open-rocket-chat-gateway dev
```

The gateway listens on `http://localhost:4000`, serving HTTP under `/api/v1` and realtime at `/ws`.

```bash
curl -c jar -X POST http://localhost:4000/api/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"user":"admin","password":"admin-password-123"}'

curl -b jar http://localhost:4000/api/v1/rooms

# Signing in again with the same cookie adds a second server to the session,
# and `X-Server-Id` then picks which one a request acts on.
curl -b jar -c jar -X POST http://localhost:4000/api/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"serverId":"contoso","user":"admin","password":"admin-password-123"}'

curl -b jar -H 'x-server-id: contoso' http://localhost:4000/api/v1/rooms
```

## API

All routes are under `/api/v1`. Everything except `auth/login`, `auth/login/oauth`, `auth/servers` and `health` requires the session cookie.

One session can be signed in to several Rocket.Chat servers at once. Every request picks which one it acts on with the **`X-Server-Id`** header; omit it and the session's default server is used, which is all a single-server deployment ever needs. Asking for a server the session is not signed in to is a `401`, not a `404` — the resource may well exist, just not for this caller. The media routes accept `?serverId=` instead, because a browser cannot put a header on an `<img>`.

| Method           | Path                                                 | Purpose                                                        |
| ---------------- | ---------------------------------------------------- | -------------------------------------------------------------- |
| `GET`            | `auth/servers`                                       | Configured servers, with the sign-in methods each one offers   |
| `POST`           | `auth/login`                                         | Sign in; with a cookie present, adds a server to the session   |
| `POST`           | `auth/login/oauth`                                   | Finish an OAuth sign-in with a Rocket.Chat credential pair     |
| `GET`            | `auth/session`                                       | Every server connection, and which is the default              |
| `POST`           | `auth/logout`                                        | Disconnect one server, or all of them                          |
| `GET`            | `server/capabilities`                                | What this server supports, probed once and cached              |
| `GET`            | `rooms`                                              | Sidebar: rooms joined with subscription state, with delta sync |
| `POST`           | `rooms`                                              | Create a channel or private group                              |
| `GET`/`PATCH`    | `rooms/:roomId`                                      | One room; rename, topic, announcement, description             |
| `POST`           | `rooms/direct`                                       | Open or create a direct message                                |
| `POST`           | `rooms/:roomId/read` \| `/unread`                    | Clear the unread badge, or mark the room unread again          |
| `PATCH`          | `rooms/:roomId/state`                                | Favourite / hide                                               |
| `POST`           | `rooms/:roomId/leave`                                | Leave the room                                                 |
| `GET`/`POST`     | `rooms/:roomId/members`                              | Members (paginated); add one                                   |
| `PATCH`/`DELETE` | `rooms/:roomId/members/:userId`                      | Change a member's roles; remove them                           |
| `GET`            | `rooms/:roomId/roles`                                | Role assignments within the room                               |
| `GET`            | `rooms/:roomId/files`                                | Files shared in the room, filterable by name and type          |
| `GET`/`PATCH`    | `rooms/:roomId/notifications`                        | Per-room notification preferences                              |
| `POST`           | `rooms/:roomId/prune`                                | Delete a range of messages                                     |
| `GET`            | `rooms/:roomId/messages`                             | History, anchored on `before` / `after`                        |
| `POST`           | `rooms/:roomId/messages`                             | Send, with optional `clientMessageId` and `threadId`           |
| `PATCH`          | `rooms/:roomId/messages/:messageId`                  | Edit                                                           |
| `DELETE`         | `rooms/:roomId/messages/:messageId`                  | Delete                                                         |
| `PUT`/`DELETE`   | `rooms/:roomId/messages/:messageId/reactions/:emoji` | React                                                          |
| `POST`/`DELETE`  | `rooms/:roomId/messages/:messageId/pin` \| `/star`   | Flag                                                           |
| `GET`            | `rooms/:roomId/threads`                              | Thread parents                                                 |
| `GET`            | `rooms/:roomId/pinned` · `/starred` · `/mentions`    | The three message collections, paginated                       |
| `GET`            | `rooms/:roomId/messages/search`                      | Search within a room                                           |
| `POST`           | `rooms/:roomId/files`                                | Upload (`multipart/form-data`, `file` part)                    |
| `POST`/`DELETE`  | `rooms/:roomId/avatar`                               | Set the room's picture (`image` part), or clear it             |
| `GET`            | `files/*` · `avatars/:username` · `avatars/room/:id` | Media, proxied with server-side credentials                    |
| `GET`            | `emoji/custom`                                       | The server's custom emoji, with URLs a client can render       |
| `GET`/`POST`     | `commands` \| `commands/run`                         | Slash commands the server offers, and running one              |
| `GET`            | `users/:userIdOrUsername` · `users/search`           | Profiles and autocomplete                                      |
| `PATCH`          | `users/me/status`                                    | Own presence and status message                                |
| `POST`/`DELETE`  | `users/me/avatar`                                    | Set own picture (`image` part), or go back to initials         |
| `POST`           | `tasra/credentials/document-reader`                  | Mint a DocumentReader SD-JWT VC; bypasses OID4VCI by design    |
| `GET`            | `tasra/public-key`                                   | A slot's BLS group public key and epoch, from the registry     |
| `GET`            | `tasra/deployment`                                   | Chain id and key registry a manifest has to name               |
| `GET`            | `health` · `health/upstream`                         | Liveness and readiness                                         |

Errors always match `ApiErrorSchema`, with a stable `code` (`unauthorized`, `totp_required`, `unsupported_by_server`, …) rather than a Rocket.Chat error string. The human-readable prose is negotiated with `Accept-Language` — English and Japanese today — while codes, `upstream` identifiers and structured `details` never change, so clients branch on them regardless of language. See [docs/i18n.md](docs/i18n.md).

### OAuth sign-in

`auth/servers` reports, per server, whether the password form is still offered (`passwordLoginEnabled`) and which OAuth providers are enabled (`loginServices`). Each service carries a ready-to-open `authorizeUrl` — the gateway resolves the provider's endpoints from Rocket.Chat's service records and settings, so a client renders buttons rather than knowing where Google or GitLab lives. Services this flow cannot drive (Twitter's OAuth 1.0a, SAML, CAS, LDAP, Apple) are left out.

The handshake itself does not involve the gateway: Rocket.Chat holds the provider's client secret, so the browser opens `authorizeUrl` with a `state` of `base64({loginStyle: 'popup', credentialToken, isCordova: false})` and the provider returns to Rocket.Chat's own `/_oauth/<service>` callback. That callback leaves a credential secret in the storage of Rocket.Chat's origin, which the client posts back to `auth/login/oauth` as `{credentialToken, credentialSecret}` in exchange for a session.

**This means a browser client has to be served from the same origin as Rocket.Chat**, since it has to read that result — deploy the gateway and its client behind the same host as the Rocket.Chat server, or leave OAuth to the password form. Rocket.Chat's `Site_Url` is what the redirect is built from, so it must match the address people actually use.

### Realtime

Connect a WebSocket to `/ws` with the same session cookie. The gateway sends JSON events (`connection.ready`, `message.created`, `message.updated`, `message.deleted`, `room.updated`, `room.removed`, `typing.changed`, `presence.changed`, `room.read`, `notification`) and accepts commands (`room.subscribe`, `room.unsubscribe`, `typing.set`, `ping`).

Room events only flow after an explicit `room.subscribe`. One upstream Rocket.Chat connection is shared by all of a session's sockets, so five open tabs cost Rocket.Chat one connection rather than five — one per server, which is what keeps unread counts moving on servers nobody is currently looking at.

One socket carries every server the session is signed in to. Each event and each command names its server in `serverId` (`ping` is the exception: it belongs to the socket, not to any server), and one `connection.ready` arrives per attached server. Room ids are only unique within a Rocket.Chat server, so a command for a server this socket is not attached to is dropped rather than guessed at.

Three behaviours are worth knowing:

- **`connection.degraded`** means the gateway lost its upstream link. Events produced during the gap are _not_ replayed — refetch when the next `connection.ready` arrives.
- **`gapBefore`** on a message page means an `after` query could not be made contiguous. Rocket.Chat can only return the _newest_ messages in a time range, so catching up across a very long disconnect can leave a hole. Reload the room rather than appending.
- **`notification`** arrives without any subscription, for every room the user belongs to. Rocket.Chat has already decided the message is worth interrupting someone for — weighing the subscription's alert setting, mentions, presence and the workspace defaults — so a client should show it rather than re-deriving the decision from `message.created`, which only fires for rooms it happens to be watching.

### Issuing reader credentials

`tasra/credentials/document-reader` mints a Holder-bound `DocumentReader` SD-JWT VC directly, skipping OID4VCI entirely: no credential offer, token endpoint, nonce or proof JWT. A valid gateway session is the only gate, so there is nothing to register in Rocket.Chat and no callback to host. The body names the slot id that becomes the credential's `key` claim and the holder's `did:jwk`; the holder is bound through `cnf` (`<did>#0`) and, exactly as the OID4VCI flow does, no `sub` claim is written.

The request names the slot, so any session holder can mint a `DocumentReader` for any slot id and bind it to their own `did:jwk`. A slot must not treat a credential from this issuer as evidence that its presenter is authorised for that particular slot.

The signing key is `TASRA_ISSUER_SEED`, an `0x`-prefixed 32-byte hex seed, and it is the credential's whole identity. The seed configured for the Tasra deployment derives the issuer `did:jwk:eyJrdHkiOiJPS1AiLCJjcnYiOiJFZDI1NTE5IiwieCI6ImRqMVdYSzJoem1lTWE5NzVPZllTR25aZkhLOGZMVG5CeGItNXdfN1N5ZFEifQ`. Rotating the seed changes that DID, so a slot's credential policy has to pin whichever DID is currently signing — otherwise the credential presented for it does not satisfy the rule:

```ts
import { credentialPolicy } from '@t3foundry/tasra-sdk/app';

credentialPolicy({ issuer: '<issuer did>', type: 'DocumentReader', claims: { key: [slotId] } });
```

Leave `TASRA_ISSUER_SEED` unset and the route answers `500` with code `internal_error` and message key `tasraIssuerNotConfigured`, while the rest of the gateway keeps working.

### Encrypted channels

A channel whose room description starts with `tasra:0x<slotId>` carries sealed
messages instead of text. The gateway's part is small — it mints the reader
credential, serves the slot's public key, and reports the chain identity a manifest
has to name — while encryption happens in the client and decryption goes through the
slot's verifier and keeper committees. The message format, those three calls, and the
invariants a reader has to check are documented in
[docs/tasra-encrypted-channels.md](docs/tasra-encrypted-channels.md).

## Configuration

See [`apps/gateway/.env.example`](apps/gateway/.env.example). The two that matter:

- **`ROCKETCHAT_SERVERS`** — a bare URL for one server, or a JSON array of `{id, name, url, publicUrl}` for several.
- **`SESSION_SECRET`** — at least 32 characters, stable across restarts, or every session dies on deploy.

Sessions live in memory by default. Set `REDIS_URL` for more than one instance.

If the frontend is on a different site, set `SESSION_COOKIE_SAMESITE=none` (which forces `Secure`, so HTTPS is required) and list its origin in `CORS_ORIGINS`.

## Compatibility

Tested end-to-end against Rocket.Chat 8.6.1. The adapter layer targets 6.x and later; where the two diverge the gateway probes at runtime and caches the answer per server. Where a server genuinely cannot do something, the error code is `unsupported_by_server` rather than a confusing 404.

### Omnichannel is not covered

None of Rocket.Chat's `/v1/livechat/*` API is wrapped here — no queue, routing, departments, transfers, canned responses, transcripts or visitor records. What exists is only what the ordinary room handling brings along: a room with `t: 'l'` normalises to the `omnichannel` room type, so an agent's own Omnichannel rooms list, read and send like any other, and the Livechat system messages come through as typed events.

Contributions are welcome, and this is where the work starts — the [client](https://github.com/zscontributor/open-rocket-chat-client) has nothing to call until the routes exist. Schemas in `packages/api-contract`, normalisation in `packages/rc-adapter`, routes in `apps/gateway`, and Rocket.Chat's Livechat endpoints have moved around more than most, so probe at runtime rather than branching on a version string. See [CONTRIBUTING.md](CONTRIBUTING.md) — a contract change needs a matching pull request in the client repository.

## Development

```bash
pnpm run build          # all packages and the gateway
pnpm run typecheck
pnpm run test           # unit tests
pnpm run test:e2e       # drives a real Rocket.Chat; needs `pnpm run rc:up`
pnpm run rc:down
```

`pnpm run test:e2e` is not a mocked suite — it logs in, sends, edits, reacts, uploads, deletes and asserts realtime delivery against an actual server. Mocks would only restate our assumptions about Rocket.Chat, and those assumptions are exactly what this layer exists to get right.

## Dependencies and licences

Every direct runtime dependency, with what it is there for. Versions live in `package.json`.

| Package                                                   | What it does                                    | Licence    |
| --------------------------------------------------------- | ----------------------------------------------- | ---------- |
| `@nestjs/core` · `common` · `config` · `platform-fastify` | The application framework                       | MIT        |
| `fastify`                                                 | The HTTP server underneath it                   | MIT        |
| `@fastify/cookie` · `cors` · `helmet` · `multipart`       | Session cookie, CORS, security headers, uploads | MIT        |
| `ws`                                                      | The `/ws` server, and DDP upstream              | MIT        |
| `ioredis`                                                 | Shared session store for more than one instance | MIT        |
| `pino` · `pino-http` · `nestjs-pino`                      | Structured logging                              | MIT        |
| `zod`                                                     | Contract schemas, validated at the edges        | MIT        |
| `rxjs`                                                    | Nest's interceptor and pipe pipeline            | Apache-2.0 |
| `reflect-metadata`                                        | Decorator metadata Nest depends on              | Apache-2.0 |

Build and test only:

| Package                           | What it does                 | Licence    |
| --------------------------------- | ---------------------------- | ---------- |
| `typescript`                      | Types                        | Apache-2.0 |
| `vitest`                          | Unit and end-to-end tests    | MIT        |
| `tsup`                            | Package builds               | MIT        |
| `@nestjs/cli` · `@nestjs/testing` | Scaffolding and test harness | MIT        |
| `pino-pretty`                     | Readable logs in development | MIT        |
| `eslint` · `prettier` · `turbo`   | Linting, formatting, builds  | MIT        |

**The whole production tree is 92 packages**: 76 MIT, five ISC, four Apache-2.0 (`rxjs`, `reflect-metadata`, `cluster-key-slot`, `denque`), four BSD-3-Clause (`fast-uri`, `ieee754`, `light-my-request`, `secure-json-parse`), two BSD-2-Clause (`dotenv`, `dotenv-expand`) and one 0BSD (`tslib`). No copyleft licence appears anywhere in what you deploy.

Including build and test tooling the tree is 462 packages, still mostly MIT, with two MPL-2.0 entries (`lightningcss`) and one CC-BY-4.0 dataset (`caniuse-lite`) that exist only during the build.

Regenerate either list rather than trusting this table if a licence matters to you:

```bash
pnpm licenses list --prod          # what you deploy
pnpm licenses list                 # everything, tooling included
```

This project itself is MIT. Contributions are accepted under the same terms.

## Contributing

Patches are welcome. The repository follows Git Flow: branch from `develop`, open a pull request against it, and let a reviewer merge — `main` holds released versions only. [CONTRIBUTING.md](CONTRIBUTING.md) has the branching model, the layering rules and the checks to run first; [docs/branch-protection.md](docs/branch-protection.md) records how those rules are enforced on GitHub. A change to `packages/api-contract` needs a matching pull request in the client repository, so mention it in the description.

Vulnerabilities go to [SECURITY.md](SECURITY.md), not to a public issue or pull request.

## Licence

MIT © [Z-SOFT Co., Ltd.](https://z-soft.com.vn) See [LICENSE](LICENSE).

# Encrypted channels

How a chat client encrypts and decrypts messages in a channel whose security comes
from a Tasra BLS KEM slot rather than from the server.

The gateway is a small, deliberately limited party here. It **issues the reader
credential**, **serves the slot's public key**, and **reports the chain identity**
a manifest has to name; it never sees a plaintext message, never holds a data key,
and has no endpoint that decrypts anything. Encryption is entirely client-side and
needs only public material. Decryption is performed by the slot's keeper committee
after a verifier committee accepts the reader's credential, and is not proxied by
the gateway.

The wire format is [`apps/gateway/kem-wrapped.json`](../apps/gateway/kem-wrapped.json),
a JSON Schema titled `tasra-encrypt/v2`. That file is normative. This document
restates it in narrative form, fixes the choices the schema leaves to the
producer (IV placement, AAD derivation, identity bytes), and shows the gateway
calls that make a reader able to open it.

## What the gateway does and does not do

| Concern                                   | Owner                                              |
| ----------------------------------------- | -------------------------------------------------- |
| Mark a channel as encrypted               | client, via the room `description`                 |
| Issue the reader credential (SD-JWT VC)   | gateway — `POST tasra/credentials/document-reader` |
| Serve the slot's group public key + epoch | gateway — `GET tasra/public-key`                   |
| Report the chain id and key registry      | gateway — `GET tasra/deployment`                   |
| Generate and wrap the AES data key        | client, offline                                    |
| Authorize a decryption                    | Tasra verifier agent + slot policy                 |
| Produce the partial decryptions           | Tasra keeper committee                             |
| Decrypt the payload                       | client, with the recovered data key                |

The gateway has no decryption endpoint. If a design puts plaintext in reach of the
gateway, it has gone wrong: the whole point is that the server stores only
ciphertext.

## Provisioning checklist

A client cannot be built from the gateway URL alone. It needs six things before it
can open a single message:

| Input                                    | Where it comes from                                                                                                                                                            | Needed for                  |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------- |
| Gateway base URL                         | deployment                                                                                                                                                                     | everything                  |
| Gateway session                          | `POST /api/v1/auth/login` (cookie, `credentials: 'include'`)                                                                                                                   | requesting a VC             |
| Slot `chainId` and `keyRegistry` address | gateway — `GET /api/v1/tasra/deployment` ([§4](#4-get-the-slots-public-key-and-chain-identity))                                                                                | writing a manifest          |
| Verifier agent URL                       | deployment configuration                                                                                                                                                       | authorizing a decryption    |
| Operation signer                         | an EIP-712 signer the slot's policy accepts — in the reference flow the slot creator's wallet, or a signer delegated to it                                                     | authorizing a decryption    |
| Holder identity                          | created per login and thrown away with the session ([§5](#5-create-the-holder-did)); its `did` is the `did:jwk` you request the VC for, its private key signs the presentation | requesting a VC, decrypting |

The operation signer is the easiest requirement to miss. A credential that
satisfies the slot's rule is **necessary but not sufficient**: the verifier agent
also wants a signature over the exact operation from a wallet the slot trusts.
Plan for it before advertising a channel as readable by a group.

## 1. Recognise an encrypted channel

An encrypted channel is announced in its room description:

```
tasra:0x7f3a…c4d1
```

The description **starts with** `tasra:` immediately followed by the 66-character
slot id (`0x` and 64 hex digits). Text after the id is free-form and ignored, so
`tasra:0x7f3a…c4d1 Incident room` is valid and reads well in a room header.

```
^tasra:(?<slotId>0x[0-9a-fA-F]{64})(?=\s|$)
```

Rules:

- Anchor at the start. `Encrypted: tasra:0x…` is **not** an encrypted channel.
- The slot id is exactly 32 bytes. A truncated value is a different identifier,
  not a slot — the gateway rejects it with `bad_request`.
- Treat anything that merely contains `tasra:0x` as plaintext. Guessing here turns
  a rendering bug into a decryption attempt against an arbitrary slot.
- `room.encrypted` is Rocket.Chat's own end-to-end encryption flag and has
  nothing to do with this scheme. Do not use it to detect a Tasra channel.

Read the description from either endpoint that carries it:

```http
GET /api/v1/rooms                    → items[].description
GET /api/v1/rooms/:roomId            → description
```

A room known only through a subscription may briefly report `description: null`
before `rooms.get` catches up. Refetch rather than assume the channel is plaintext.

The description is **plaintext and world-readable to the room's members**. Never
put the channel's purpose, participants, or anything else sensitive in it.

## 2. Create an encrypted channel

Create or update a room with the description set. The contract caps it at 500
characters.

```http
POST /api/v1/rooms
{
  "name": "incident-2026-11",
  "type": "private",
  "description": "tasra:0x7f3a…c4d1 Incident room"
}
```

```http
PATCH /api/v1/rooms/:roomId
{ "description": "tasra:0x7f3a…c4d1 Incident room" }
```

Creating the room does **not** create the slot. The slot must already exist on
chain, with a rule that admits the people you expect to read it. Which slot
admits whom is a policy decision made at slot creation; see
[`tasra-create-slot`](../.agents/skills/tasra-create-slot/SKILL.md) and
[`tasra-dcql-rules`](../.agents/skills/tasra-dcql-rules/SKILL.md).

Leave `encrypted` at `false`. `POST /rooms` accepts an `encrypted` flag, but it
switches on Rocket.Chat's own end-to-end encryption, which is a different scheme:
turning it on makes Rocket.Chat clients in the room try to decrypt your payload
with keys they do not have. A Tasra channel is an ordinary room whose _description_
says it is encrypted, not a room with `encrypted: true`.

## 3. The message format

One encrypted message is one `tasra-encrypt/v2` record: a JSON object with a
`manifest` (identity and key parameters) and an `envelope` (ciphertext material).
Both halves are required, and unknown properties are rejected.

```json
{
  "manifest": {
    "schema": "tasra-encrypt/v2",
    "recordId": "0b6f8e0e-7f3f-4a4b-9c2f-2f6f6a1b4c77",
    "title": "message",
    "version": 0,
    "documentSha256": "<sha-256 of the plaintext, lowercase hex>",
    "chainId": 43113,
    "keyRegistry": "0x45f432ab5709e9920b5ec349d29663d7200a8c39",
    "slotId": "0x7f3a…c4d1"
  },
  "envelope": {
    "encryptedAesKey": "<base64 GroupEnvelope v0x02>",
    "aesCiphertext": "<base64 of iv ‖ AES-256-GCM ciphertext>",
    "epoch": 0
  }
}
```

### manifest

| Field            | Notes                                                                                                    |
| ---------------- | -------------------------------------------------------------------------------------------------------- |
| `schema`         | Literal `tasra-encrypt/v2`. Reject anything else.                                                        |
| `recordId`       | UUID you generate per message. Drives the AES AAD, and is how an edit is tied to its original.           |
| `title`          | Opaque label. Use a constant such as `message`; **it is plaintext**, so never put the message here.      |
| `version`        | `0` for a new message, incremented on each re-encryption of the same `recordId` (an edit).               |
| `documentSha256` | SHA-256 of the plaintext, lowercase hex, computed before encryption. Also the KEM identity — see below.  |
| `chainId`        | Chain the slot's key registry is deployed on (`43113` Fuji, `43114` Avalanche C-Chain).                  |
| `keyRegistry`    | KeyRegistry contract address for that chain.                                                             |
| `slotId`         | The channel's slot. Must equal the slot id in the room description and the one embedded in the envelope. |

### envelope

| Field             | Notes                                                                                   |
| ----------------- | --------------------------------------------------------------------------------------- |
| `encryptedAesKey` | Base64 of a serialized `GroupEnvelope` v0x02 — the AES data key wrapped by the BLS KEM. |
| `aesCiphertext`   | Base64 of the 12-byte AES-GCM IV followed by the ciphertext and its 16-byte tag.        |
| `epoch`           | The slot epoch you encrypted under, copied from `GET tasra/public-key`.                 |

### Invariants a reader must check

The schema cannot express these, so a client checks them after decoding.

1. `encryptedAesKey` decodes to a byte stream whose first byte is `0x02`.
2. The envelope's `slot_id` equals `manifest.slotId`.
3. The envelope's `epoch` equals `manifest.envelope.epoch`.
4. The envelope's `identity` is exactly the 64 ASCII bytes of `manifest.documentSha256`.
5. `aesCiphertext` is at least 12 + 16 bytes: an IV, then at least one tag, possibly no plaintext.
6. `manifest.slotId` equals the slot id the channel advertises.

Check 4 is the load-bearing one. The KEM binds `identity` as AEAD additional data,
so a manifest whose `documentSha256` has been altered does not merely fail a
comparison — the wrapped key refuses to unwrap. A tampered digest therefore costs
a failed decryption rather than a mis-verified one.

### Fixed producer choices

The schema permits a few variations. A channel that mixes clients needs exactly
one choice per item; these are the ones this format uses.

| Choice          | Value                                                                                  |
| --------------- | -------------------------------------------------------------------------------------- |
| AES AAD         | `SHA-256(UTF-8("tasra-encrypt/v2:" + recordId))` — 32 bytes                            |
| AES IV          | 12 random bytes, prefixed to `aesCiphertext`                                           |
| KEM identity    | `UTF-8(manifest.documentSha256)` — the 64 ASCII characters of the lowercase hex digest |
| Base64 alphabet | standard, padded (`+/`, `=`) — **not** base64url                                       |
| Hex digits      | lowercase, including `documentSha256` and in the identity bytes that mirror it         |

`recordId` is deliberately not `clientMessageId`: the gateway types the latter as
a Rocket.Chat id (17 characters), while the schema demands a UUID. Generate a
separate UUID per message and keep the mapping if you need it.

## 4. Get the slot's public key and chain identity

```http
GET /api/v1/tasra/public-key?slotId=0x7f3a…c4d1
```

```json
{
  "publicKey": "0xa5ee452b7d3fe9a9…19ec8a",
  "epoch": 0
}
```

`publicKey` is the 96-byte compressed BLS12-381 G2 group key, hex-encoded, and
`epoch` is the registry's key epoch. This endpoint takes no session: the public key
enables encryption only, never decryption, so it is safe to expose and safe to
cache.

Decode with `hexToBytes`, which accepts the `0x` prefix:

```ts
import { hexToBytes } from '@t3foundry/tasra-sdk';

const mpkBytes = hexToBytes(publicKey); // 96 bytes
```

The endpoint answers `404 not_found` when the registry has no such slot, and
`500 internal_error` with message key `tasraNotConfigured` when the gateway cannot
read the registry at all — no `TASRA_RPC_URL` / `TASRA_DEPLOYMENT_ADDRESSES`, or an
RPC call that failed. Distinguish the two: the first means the channel points at a
slot that does not exist, the second means the fault is on the gateway.

**Cache by `slotId`, and re-validate the epoch.** The endpoint only ever reports
the _current_ key. Once a slot is re-keyed it will not serve the key a past
message was sealed with, so persist the `(publicKey, epoch)` pair alongside any
record you need to re-verify later. Decryption itself is unaffected: the epoch the
message was sealed under is embedded in its envelope, and the keepers hold shares
for it.

### The chain identity the manifest needs

A manifest also names the chain and the registry the slot lives on, and neither is
derivable from the slot id — the same slot id could exist on another chain. Both
come from one endpoint, which is public for the same reason the group key is:

```http
GET /api/v1/tasra/deployment
```

```json
{
  "chainId": 43113,
  "keyRegistry": "0x45f432ab5709e9920b5ec349d29663d7200a8c39"
}
```

Write these straight into `manifest.chainId` and `manifest.keyRegistry`. Do not
hard-code them: an address that describes a different deployment is accepted by the
KEM (neither field is authenticated), so a client that guesses keeps working while
mislabelling every record it produces. Fetch once per session and cache — the pair
cannot change without a gateway restart.

Two details worth matching rather than assuming:

- **`keyRegistry` is lowercase.** The gateway normalises the address it was
  configured with, so compare it case-insensitively if you compare it at all. EVM
  addresses carry no meaning in their capitalisation.
- **`chainId` may be the SDK default.** When the deployment sets no
  `TASRA_CHAIN_ID`, the endpoint reports the SDK's default chain id — the same one
  the gateway's own chain client reads through. That is a value to trust, not a
  missing field to reject.

The endpoint answers `500 internal_error` with message key `tasraNotConfigured`
when `TASRA_DEPLOYMENT_ADDRESSES` is absent or carries no `KeyRegistry`. It needs no
`TASRA_RPC_URL`, because it reports configuration rather than reading the chain: a
gateway that can describe its deployment but not reach it answers here and fails on
the public-key call above instead.

## 5. Create the holder DID

Every credential is bound to a DID before it is issued, so a client needs a key
before it can ask for one. What matters is that the client holds the private half:
the credential is presented by signing with it, and a DID whose key is missing is a
credential nobody can use.

### DID creation

`open-rocket-chat-client` creates a **throwaway, session-scoped** `did:jwk` when the
user logs in. The private key is held with the W3C Web Cryptography API
(`crypto.subtle`) in a `CryptoKey` object: it exists for the lifetime of the session
and is not written anywhere else.

This is a deliberate trade. A key that does not outlive the login cannot be harvested
from storage, and one taken from a live session is only useful while that session is
open. The price is that credentials die with the key — a `DocumentReader` is bound to
its holder through `cnf`, so binding one to a new session means asking the gateway
to mint another, which is exactly what [§6](#6-request-the-reader-credential) does.

Two consequences follow, and both are easy to get wrong:

- **Request a credential per session.** Do not restore one from local storage at
  startup: its `cnf` names the DID of whichever session requested it, and the key
  behind that DID no longer exists.
- **`expiresAt` is not the real lifetime.** The gateway issues for a year, but a
  session-scoped DID makes the session the binding limit, so treat the credential as
  valid until logout.

### Handing the key to the SDK

The SDK's identity and signing adapters work on **raw 32-byte key material** — a
P-256 scalar or an Ed25519 seed (`TasraIdentity`, `HolderKey`, `JwsSigner`) — not on
a `CryptoKey`. A client that keeps its key in `crypto.subtle` therefore we will use an extractable key to call 
`createIdentity()` or presents a credential:

- an **extractable** key can be exported once with `crypto.subtle.exportKey('jwk', …)`,
  reduced to its 32-byte secret, and handed to `createIdentity({ seed })`;

## 6. Request the reader credential

A session is the entire authorization for this call — no OID4VCI offer, token
endpoint, nonce or proof JWT is involved.

```http
POST /api/v1/tasra/credentials/document-reader
Cookie: orc_session=…
Content-Type: application/json

{
  "slotId": "0x7f3a…c4d1",
  "did": "did:jwk:eyJrdHkiOiJFQyIsImNydiI6IlAtMjU2IiwieCI6…"
}
```

```json
{
  "credential": "eyJhbGciOiJFZERTQSIsImtpZCI6ImRpZDpqd2s6…#…~WyJ…",
  "issuer": "did:jwk:eyJrdHkiOiJPS1AiLCJjcnYiOiJFZDI1NTE5IiwieCI6ImRqMVdY…",
  "vct": "DocumentReader",
  "expiresAt": "2027-11-04T09:16:00.000Z"
}
```

- `slotId` identifies the slot whose DCQL rule the gateway reads to derive the
  `key` claim. The issuer extracts the value the slot's rule pins on `key` —
  that extracted value, not the slot id itself, becomes the credential's `key`
  claim. A credential minted against slot A's rule value does not satisfy slot B.
- `did` must be a `did:jwk`, and it must be the DID of a key **this client holds**.
  The gateway binds the credential through `cnf` (`<did>#0`), so a credential
  naming a DID whose private key you do not have is unusable. `createIdentity()`
  from the SDK produces one, and so does a `crypto.subtle` key of your own
  ([§5](#5-create-the-holder-did)).
- A credential lives as long as its DID, not as long as `expiresAt`. A year is the
  ceiling; with a session-scoped DID ([§5](#5-create-the-holder-did)) the session is
  the real limit, so request one at login and keep it in memory rather than in
  storage.

The response's `issuer` is what a slot policy pins. If your channel's slot was
created against a different issuer DID, the credential will be refused no matter
what claims it carries.

**A credential is not proof of access.** Any session holder can mint a
`DocumentReader` for any slot id and bind it to their own DID. What decides whether
a given slot's ciphertext opens is the slot's committed rule, evaluated by the
verifier committee. A client must therefore render "I hold a credential" and "I can
read this channel" as two different facts, and only learn the second by attempting
a decryption.

## 7. Encrypt

Four steps and one hard rule: the data key never leaves the client unwrapped, and
it is zeroized as soon as the envelope exists.

1. Derive `documentSha256` and the AES AAD.
2. Encrypt the message with AES-256-GCM under a fresh 32-byte data key.
3. Wrap that data key with the slot's public key, producing a `GroupEnvelope` v0x02.
4. Assemble the record and zeroize the data key.

```ts
import { encryptEnvelope, toBytes, hexToBytes } from '@t3foundry/tasra-sdk';

const enc = new TextEncoder();
const dec = new TextDecoder();
// `BufferSource`, not `Uint8Array`: WebCrypto refuses a view whose buffer might be
// a `SharedArrayBuffer`, which is what a bare `Uint8Array` may be.
const sha256 = async (bytes: BufferSource) => new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
const toHex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

interface SlotKey {
  slotId: `0x${string}`;
  publicKey: `0x${string}`;
  epoch: number;
}

async function sealMessage(
  text: string,
  slot: SlotKey,
  recordId: string,
  version: number,
  deployment: { chainId: number; keyRegistry: string },
) {
  const plaintext = enc.encode(text);

  // 1. Integrity anchor and AES AAD, both derived from public manifest fields.
  const documentSha256 = toHex(await sha256(plaintext));
  const aad = await sha256(enc.encode(`tasra-encrypt/v2:${recordId}`));

  // 2. AES-256-GCM under a fresh data key; the IV travels prefixed to the ciphertext.
  const dataKey = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aesKey = await crypto.subtle.importKey('raw', dataKey, 'AES-GCM', false, ['encrypt']);
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, aesKey, plaintext),
  );
  const aesCiphertext = new Uint8Array(iv.length + sealed.length);
  aesCiphertext.set(iv, 0);
  aesCiphertext.set(sealed, iv.length);

  // 3. Wrap only the data key. Pass the epoch to get a v0x02 envelope, which binds
  //    slot and epoch into the wire format instead of leaving them implicit.
  const envelope = encryptEnvelope(
    hexToBytes(slot.slotId),
    hexToBytes(slot.publicKey), // 96-byte compressed G2 from GET tasra/public-key
    enc.encode(documentSha256), // KEM identity, 64 ASCII bytes
    dataKey,
    BigInt(slot.epoch),
  );
  dataKey.fill(0);

  // 4. Assemble the record exactly as apps/gateway/kem-wrapped.json describes.
  return {
    manifest: {
      schema: 'tasra-encrypt/v2',
      recordId,
      title: 'message',
      version,
      documentSha256,
      chainId: deployment.chainId,
      keyRegistry: deployment.keyRegistry,
      slotId: slot.slotId,
    },
    envelope: {
      encryptedAesKey: b64(toBytes(envelope)),
      aesCiphertext: b64(aesCiphertext),
      epoch: slot.epoch,
    },
  };
}
```

`encryptEnvelope` needs no credential, no session and no network round-trip: the
public key and epoch from [§4](#4-get-the-slots-public-key-and-chain-identity) are the whole input.
That is what makes an encrypted channel writable by someone who cannot read it.

Do **not** use `buildTasraText` / the `[KK]<base64>` form here. It is a different
wire format for a different transport. In this channel format the payload is the
JSON record above, with the envelope base64 inside `envelope.encryptedAesKey`.

## 8. Send

Serialize the record and send it as the message body. No code fence, no prefix, no
surrounding prose — the reader parses the text as JSON.

```http
POST /api/v1/rooms/:roomId/messages
{ "text": "{\"manifest\":{…},\"envelope\":{…}}" }
```

On edit, re-encrypt with the same `recordId` and `version + 1`, then
`PATCH /api/v1/rooms/:roomId/messages/:messageId`. A reader that sees a lower or
equal `version` for a `recordId` it has already rendered is looking at a stale
copy and should keep the higher one.

Detect an encrypted body by parsing, not by prefix:

```ts
const looksEncrypted = (text: string): boolean => {
  if (!text.trimStart().startsWith('{')) return false;
  try {
    return JSON.parse(text)?.manifest?.schema === 'tasra-encrypt/v2';
  } catch {
    return false;
  }
};
```

Never silently fall back to plaintext. A message that looks encrypted but fails to
parse must render as "cannot decrypt", because falling back would show ciphertext
as message text and hide a tampering attempt.

## 9. Decrypt

Decryption is two operations: the keeper committee unwraps the data key, then the
client uses it on the payload. Validate the envelope before spending a committee
round-trip on it.

Order matters:

1. Parse the body; reject anything whose `manifest.schema` is not `tasra-encrypt/v2`.
2. Reject `manifest.slotId` ≠ the channel's slot id. Otherwise a message posted in
   one channel can name another channel's slot and be unwrapped with the wrong
   authority.
3. Decode `encryptedAesKey`, parse the envelope, and check the six invariants from
   [§3](#invariants-a-reader-must-check).
4. Unwrap the data key, authorized by the stored credential and the operation signer.
5. Rebuild the AES AAD from `recordId`, split off the IV, decrypt.
6. Verify the plaintext against `documentSha256`. Zeroize the data key.

This uses the same `enc`, `dec`, `sha256` and `toHex` helpers as [§7](#7-encrypt).

```ts
import { fromBytes } from '@t3foundry/tasra-sdk';
import { credentialAuthorization, type TasraApplication } from '@t3foundry/tasra-sdk/app';

const unb64 = (value: string) => Uint8Array.from(atob(value), (c) => c.charCodeAt(0));

interface EncryptedRecord {
  manifest: {
    schema: string;
    recordId: string;
    title: string;
    version: number;
    documentSha256: string;
    chainId: number;
    keyRegistry: string;
    slotId: `0x${string}`;
  };
  envelope: { encryptedAesKey: string; aesCiphertext: string; epoch: number };
}

async function openMessage(
  record: EncryptedRecord,
  channelSlotId: `0x${string}`,
  tasra: TasraApplication,
  authorize: ReturnType<typeof credentialAuthorization>,
): Promise<string> {
  const { manifest, envelope } = record;

  // 1-2. Format and slot binding, before any network or committee work.
  if (manifest?.schema !== 'tasra-encrypt/v2') throw new Error('Unsupported record schema');
  if (manifest.slotId.toLowerCase() !== channelSlotId.toLowerCase()) {
    throw new Error('Record names a slot this channel does not use');
  }

  // 3. Envelope invariants.
  const env = fromBytes(unb64(envelope.encryptedAesKey));
  if (toHex(env.slotId) !== manifest.slotId.slice(2).toLowerCase()) {
    throw new Error('Envelope slot mismatch');
  }
  if (env.epoch !== BigInt(envelope.epoch)) throw new Error('Envelope epoch mismatch');
  if (dec.decode(env.identity) !== manifest.documentSha256) {
    throw new Error('Envelope identity is not this record digest');
  }

  // 4. Committee-authorized unwrap of the AES data key.
  const slot = await tasra.slots.bls(manifest.slotId);
  const { plaintext: dataKey } = await slot.decrypt(env.identity, env.ciphertext, {
    authorize,
    requireReceipts: true,
    description: 'Decrypt a channel message',
  });

  try {
    // 5. AES-256-GCM with the IV prefixed to the payload.
    const aad = await sha256(enc.encode(`tasra-encrypt/v2:${manifest.recordId}`));
    const raw = unb64(envelope.aesCiphertext);
    const iv = raw.subarray(0, 12);
    const body = raw.subarray(12);
    // The SDK types `plaintext` as `Uint8Array<ArrayBufferLike>` because it cannot
    // promise who allocated the buffer, while WebCrypto accepts only
    // ArrayBuffer-backed views. Every real unwrap is array-backed, so this narrows
    // the type rather than asserting something untrue.
    const aesKey = await crypto.subtle.importKey('raw', dataKey as BufferSource, 'AES-GCM', false, ['decrypt']);
    const opened = new Uint8Array(
      await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad }, aesKey, body),
    );

    // 6. The manifest hash is the last word on what was decrypted.
    if (toHex(await sha256(opened)) !== manifest.documentSha256) {
      throw new Error('Plaintext does not match the manifest digest');
    }
    return dec.decode(opened);
  } finally {
    dataKey.fill(0);
  }
}
```

The authorizer is built once per session, not per message: `credentialAuthorization`
performs an OID4VP presentation, and the credential it presents is the one from
[§6](#6-request-the-reader-credential).

```ts
const authorize = credentialAuthorization({
  verifierAgentUrl,
  signer, // EIP-712 signer the slot's policy accepts
  identity, // holder identity whose did the credential was minted for
  credentials: [readerCredential],
  approve: () => confirm('This channel wants to decrypt a message. Allow?'),
});
```

`tasra` is a `createTasra({ deployment })` client for the chain the slot lives on,
using the same `chainId` and `keyRegistry` you wrote into the manifest.

Two behaviours worth designing around:

- **Batch deliberately.** Every failed attempt is a verifier round-trip and, on
  success, a charged keeper operation. Decrypt on demand (message visible, user
  clicks), cache plaintext in memory only, and never re-decrypt an unchanged
  `(recordId, version)`.
- **One credential, one authorizer.** Do not share an authorizer across users or
  contexts, and do not persist plaintext to local storage: this scheme protects
  data at rest on the server, and a client that caches plaintext gives that up.

## Failure modes

| Symptom                                            | Cause                                                                                                                                                                                             |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `400 bad_request`, `slotId` invalid                | Slot id is not `0x` + 64 hex digits                                                                                                                                                               |
| `404 not_found`, `resourceNotFound`                | No such slot in the registry; the channel points at nothing                                                                                                                                       |
| `500 internal_error`, `tasraNotConfigured`         | Gateway cannot report or read its deployment: `TASRA_DEPLOYMENT_ADDRESSES` absent or missing `KeyRegistry` (deployment endpoint), or no `TASRA_RPC_URL` / a failed RPC call (public-key endpoint) |
| `500 internal_error`, `tasraIssuerNotConfigured`   | Gateway has no `TASRA_ISSUER_SEED`; it cannot mint credentials                                                                                                                                    |
| `401 unauthorized` on the credential endpoint      | No or expired gateway session                                                                                                                                                                     |
| Verifier refuses: no credential satisfies the rule | Credential's issuer, `vct` or `key` claim does not match the slot rule; the `key` value comes from the rule itself |
| Envelope identity mismatch                         | `documentSha256` was altered, or the producer derived identity differently                                                                                                                        |
| Envelope epoch mismatch                            | Manifest and envelope disagree; the record was edited outside a client                                                                                                                            |
| AES-GCM authentication failure (`OperationError`)  | Wrong AAD derivation, wrong IV offset, or a truncated `aesCiphertext`                                                                                                                             |
| Digest mismatch after a successful unwrap          | Plaintext changed before it was hashed, or `documentSha256` is stale                                                                                                                              |

Treat every one of these as "cannot decrypt", never as "show the ciphertext".

## Limits and what stays visible

**Size.** The record is base64 in a JSON string inside a Rocket.Chat message, so
the server's message length limit is the real ceiling. Base64 costs 4 bytes per 3,
the envelope adds a fixed ~516 characters at a 64-byte identity, and the manifest
adds a few hundred. Against Rocket.Chat's default 5000-character message limit that
leaves roughly 2.5–3 KB of plaintext per message. Longer content belongs in an
uploaded file sealed to the slot, not in a message body.

**The KEM is single-shot.** One ciphertext wraps up to `MAX_PLAINTEXT_LEN`
(≈1 MiB), and a 32-byte data key is nowhere near that. The ceiling only matters if
someone repurposes this code to seal a payload directly with the KEM instead of
wrapping the key — which would also make the envelope far too large for a message
body.

**What remains plaintext.** Encryption covers the message `text` only. Still
readable by Rocket.Chat and by anyone with database access:

- the room name, description, topic, members and membership changes;
- the fact that a message exists, who sent it, when, and in which thread;
- message metadata: reactions, pins, stars, attachments and uploaded files;
- the record's own metadata — `recordId`, `title`, `version`, `chainId`, `keyRegistry`, `slotId`, `epoch`, `documentSha256`, and the ciphertext length (which leaks approximate plaintext size);
- edit and deletion history, which the server retains.

`documentSha256` is a plain hash of the plaintext. For a short, guessable message
("yes", "approved") that is a confirmation oracle: anyone who can read the room
can test a guess. If that matters, add a per-message random salt inside the
plaintext before hashing — but then the identity and the digest change together,
so agree on the construction channel-wide rather than per client.

Server-side search indexes ciphertext, so search returns nothing useful in an
encrypted channel. Search client-side over decrypted messages you already hold, or
not at all.

## Checklist

Before shipping an encrypted channel:

- [ ] Description detection anchored, exact-length, and tolerant of trailing text.
- [ ] Plaintext never written to `manifest.title`, logs, or local storage.
- [ ] A session-scoped DID means the credential is requested at login and never restored from storage.
- [ ] `documentSha256` computed before encryption, from plaintext, lowercase hex.
- [ ] `chainId` and `keyRegistry` fetched from `GET tasra/deployment`, not hard-coded.
- [ ] KEM identity is the 64 ASCII bytes of that digest, not the slot id.
- [ ] AES AAD is `SHA-256("tasra-encrypt/v2:" + recordId)`, agreed channel-wide.
- [ ] IV prefixed to `aesCiphertext`; standard base64, padded.
- [ ] `epoch` passed to `encryptEnvelope`, so the envelope is v0x02 and carries it.
- [ ] All six invariants checked before spending a committee decryption.
- [ ] `requireReceipts: true` on every unwrap.
- [ ] Data keys zeroized; plaintext cached in memory only and never persisted.
- [ ] Parse failures and decryption failures render as failures, never as plaintext.
- [ ] `(publicKey, epoch)` archived per slot if old ciphertext must be re-verified.

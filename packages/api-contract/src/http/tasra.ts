import { z } from 'zod';

import { IsoDateTimeSchema } from '../common.js';

/**
 * A Tasra slot is addressed by a `bytes32`, so its identifier is always
 * `0x` followed by 64 hex digits. Anchored and length-exact: a truncated or
 * unprefixed value is a different identifier, not a slot.
 */
export const TASRA_SLOT_ID_PATTERN = /^0x[0-9a-fA-F]{64}$/;

/** base64url alphabet, as RFC 4648 §5 defines it — no padding. */
const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/**
 * Decodes without `Buffer` or `atob`, because this package is also bundled for
 * the browser and `atob` rejects base64url's `-` and `_`.
 */
const decodeBase64Url = (value: string): string => {
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;

  for (const character of value) {
    const index = BASE64URL_ALPHABET.indexOf(character);
    // The caller's regex has already restricted the input to this alphabet.
    if (index < 0) return '';
    buffer = (buffer << 6) | index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }

  return new TextDecoder().decode(Uint8Array.from(bytes));
};

/**
 * Whether a `did:jwk` suffix decodes to a JWK — a JSON object whose `kty` is a
 * string naming the key type.
 *
 * A present-but-non-string `kty` is refused too: `{"kty":null}` names no key
 * type at all, and `{"kty":{"a":1}}` is not a JWK any wallet could present.
 */
const isJwkObject = (encoded: string): boolean => {
  try {
    const decoded: unknown = JSON.parse(decodeBase64Url(encoded));
    if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) return false;
    return typeof (decoded as { kty?: unknown }).kty === 'string';
  } catch {
    return false;
  }
};

/**
 * `POST /api/v1/tasra/credentials/document-reader`
 *
 * Mints a Holder-bound `DocumentReader` credential directly, with no OID4VCI
 * exchange in between: no offer, no token, no proof JWT. A valid gateway
 * session is the whole authorisation story, so the request only describes
 * *what* to bind the credential to.
 */
export const IssueDocumentReaderRequestSchema = z.object({
  /**
   * Becomes the credential's `key` claim. A slot's DCQL rule pins that claim to
   * one slot id, so this is what makes the credential usable against it.
   */
  slotId: z.string().regex(TASRA_SLOT_ID_PATTERN, 'slotId must be 0x followed by 32 bytes of hex'),
  /**
   * The holder's DID, as a `did:jwk` only.
   *
   * The reference OID4VCI flow rejects any holder key that is not a `did:jwk`
   * with a `#0` fragment — it binds the credential through
   * `cnf.kid = "<did>#0"`. Accepting `did:key` or `did:web` here would mint a
   * credential no wallet can present. The suffix must decode to a JWK carrying a
   * string `kty`, so a syntactically DID-shaped string that carries no usable
   * public key is refused before it can reach the issuer.
   */
  did: z
    .string()
    .regex(/^did:jwk:[A-Za-z0-9_-]+$/, 'did must be a did:jwk identifier')
    .refine((did) => isJwkObject(did.slice('did:jwk:'.length)), 'did:jwk must carry a base64url-encoded JWK'),
});
export type IssueDocumentReaderRequest = z.infer<typeof IssueDocumentReaderRequestSchema>;

/**
 * `POST /api/v1/tasra/credentials/document-reader`
 *
 * `credential` is the compact SD-JWT VC (`issuer~disclosure~…~`), returned
 * whole because the wallet stores it verbatim and presents it later. `issuer`
 * and `expiresAt` are repeated from its payload so a client can show what it
 * received, and pin the issuer, without parsing the credential itself.
 */
export const IssueDocumentReaderResponseSchema = z.object({
  credential: z.string().min(1),
  issuer: z.string(),
  vct: z.literal('DocumentReader'),
  expiresAt: IsoDateTimeSchema,
});
export type IssueDocumentReaderResponse = z.infer<typeof IssueDocumentReaderResponseSchema>;

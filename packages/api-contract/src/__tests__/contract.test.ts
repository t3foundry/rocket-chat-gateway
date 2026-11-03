import { describe, expect, it } from 'vitest';

import {
  ClientCommandSchema,
  IssueDocumentReaderRequestSchema,
  IssueDocumentReaderResponseSchema,
  ListMessagesQuerySchema,
  ListRoomsQuerySchema,
  ServerEventSchema,
  SlashCommandSchema,
  UpdateMyStatusRequestSchema,
  UpdateRoomStateRequestSchema,
} from '../index.js';

/** A `did:jwk` (Ed25519) — the only DID form the issuer can bind a holder to. */
const HOLDER_DID =
  'did:jwk:eyJrdHkiOiJPS1AiLCJjcnYiOiJFZDI1NTE5IiwieCI6IjBFcXlNblFydEtzNkUyaTlSaFhrNXRBaVNyY2FBV3V2aFNDak1zbDNoemMifQ';
const SLOT_ID = `0x${'ab'.repeat(32)}`;

describe('query schemas', () => {
  it('coerces query strings, which always arrive as text', () => {
    const parsed = ListMessagesQuerySchema.parse({ limit: '25', includeThreadReplies: 'true' });

    expect(parsed.limit).toBe(25);
    expect(parsed.includeThreadReplies).toBe(true);
  });

  it('applies defaults for an empty query', () => {
    expect(ListMessagesQuerySchema.parse({})).toMatchObject({ limit: 50, includeThreadReplies: false });
  });

  it('rejects an out-of-range limit rather than silently clamping', () => {
    expect(ListMessagesQuerySchema.safeParse({ limit: '5000' }).success).toBe(false);
  });

  it('accepts a room type filter as one value or many', () => {
    expect(ListRoomsQuerySchema.parse({ types: 'channel' }).types).toEqual(['channel']);
    expect(ListRoomsQuerySchema.parse({ types: ['channel', 'direct'] }).types).toEqual(['channel', 'direct']);
  });

  it('requires a room state patch to change something', () => {
    expect(UpdateRoomStateRequestSchema.safeParse({}).success).toBe(false);
    expect(UpdateRoomStateRequestSchema.safeParse({ favorite: true }).success).toBe(true);
  });
});

describe('slash command schema', () => {
  it('accepts Rocket.Chat commands guarded by any of several permissions', () => {
    const command = SlashCommandSchema.parse({
      command: 'create',
      params: null,
      description: null,
      clientOnly: false,
      providesPreview: false,
      permission: ['create-c', 'create-p'],
    });

    expect(command.permission).toEqual(['create-c', 'create-p']);
  });
});

describe('status schema', () => {
  it('takes presence and message together or on their own', () => {
    expect(UpdateMyStatusRequestSchema.safeParse({ status: 'busy' }).success).toBe(true);
    expect(UpdateMyStatusRequestSchema.safeParse({ statusText: 'In a meeting' }).success).toBe(true);
    expect(UpdateMyStatusRequestSchema.safeParse({ status: 'away', statusText: 'Back at 3' }).success).toBe(true);
  });

  it('treats an empty message as "clear it", not as a missing field', () => {
    expect(UpdateMyStatusRequestSchema.safeParse({ statusText: '' }).success).toBe(true);
  });

  it('rejects a patch that changes nothing', () => {
    expect(UpdateMyStatusRequestSchema.safeParse({}).success).toBe(false);
  });

  it('rejects an unknown presence and an over-long message', () => {
    expect(UpdateMyStatusRequestSchema.safeParse({ status: 'lunch' }).success).toBe(false);
    expect(UpdateMyStatusRequestSchema.safeParse({ statusText: 'x'.repeat(121) }).success).toBe(false);
  });
});

describe('realtime schemas', () => {
  it('discriminates server events by type', () => {
    const parsed = ServerEventSchema.parse({
      type: 'message.deleted',
      serverId: 'acme',
      roomId: 'r1',
      messageId: 'm1',
    });

    expect(parsed.type).toBe('message.deleted');
  });

  it('rejects an unknown event type', () => {
    expect(ServerEventSchema.safeParse({ type: 'message.exploded', serverId: 'acme', roomId: 'r1' }).success).toBe(
      false,
    );
  });

  it('requires every event to name the server it came from', () => {
    // One socket carries several Rocket.Chat servers, and room ids are only
    // unique within one of them — an unscoped event cannot be routed.
    expect(ServerEventSchema.safeParse({ type: 'message.deleted', roomId: 'r1', messageId: 'm1' }).success).toBe(false);
  });

  it('validates client commands, so a malformed frame cannot reach the upstream', () => {
    expect(ClientCommandSchema.safeParse({ type: 'room.subscribe', serverId: 'acme', roomId: 'r1' }).success).toBe(
      true,
    );
    // A missing roomId used to reach `subscribeRoom` as `undefined`.
    expect(ClientCommandSchema.safeParse({ type: 'room.subscribe', serverId: 'acme' }).success).toBe(false);
    // Without a server the gateway would have to guess which upstream to
    // subscribe on, so the command is rejected instead.
    expect(ClientCommandSchema.safeParse({ type: 'room.subscribe', roomId: 'r1' }).success).toBe(false);
    expect(
      ClientCommandSchema.safeParse({ type: 'typing.set', serverId: 'acme', roomId: 'r1', typing: 'yes' }).success,
    ).toBe(false);
  });

  it('leaves the keepalive unscoped, since it belongs to the socket', () => {
    expect(ClientCommandSchema.safeParse({ type: 'ping' }).success).toBe(true);
  });

  it('carries everything a desktop notification needs to be shown and clicked', () => {
    const parsed = ServerEventSchema.parse({
      type: 'notification',
      serverId: 'acme',
      title: 'general',
      text: 'Quy: deploy is green',
      duration: null,
      payload: {
        messageId: 'm1',
        roomId: 'r1',
        threadId: null,
        roomType: 'channel',
        roomName: 'general',
        sender: { id: 'u1', username: 'quy', displayName: 'Quy', avatarUrl: null, status: null },
        sound: null,
      },
    });

    expect(parsed).toMatchObject({ type: 'notification', payload: { roomId: 'r1' } });
  });

  it('rejects a notification with no message to open', () => {
    // Clicking one navigates to the message; without an id there is nowhere to
    // go, and a notification that does nothing is worse than none at all.
    const withoutMessage = {
      type: 'notification',
      serverId: 'acme',
      title: 'general',
      text: 'deploy is green',
      duration: null,
      payload: {
        roomId: 'r1',
        threadId: null,
        roomType: 'channel',
        roomName: 'general',
        sender: { id: 'u1', username: 'quy', displayName: 'Quy', avatarUrl: null, status: null },
        sound: null,
      },
    };

    expect(ServerEventSchema.safeParse(withoutMessage).success).toBe(false);
  });
});

describe('document reader issuance schema', () => {
  it('accepts a 32-byte slot id and a did:jwk holder', () => {
    const parsed = IssueDocumentReaderRequestSchema.parse({ slotId: SLOT_ID, did: HOLDER_DID });

    expect(parsed).toEqual({ slotId: SLOT_ID, did: HOLDER_DID });
  });

  it('rejects a slot id that is not exactly 32 bytes of hex', () => {
    expect(IssueDocumentReaderRequestSchema.safeParse({ slotId: '0xabcd', did: HOLDER_DID }).success).toBe(false);
    expect(
      IssueDocumentReaderRequestSchema.safeParse({ slotId: `0x${'zz'.repeat(32)}`, did: HOLDER_DID }).success,
    ).toBe(false);
    // No `0x` prefix is a different identifier, not a slot id.
    expect(IssueDocumentReaderRequestSchema.safeParse({ slotId: 'ab'.repeat(32), did: HOLDER_DID }).success).toBe(
      false,
    );
  });

  it('rejects anything that is not a DID', () => {
    expect(IssueDocumentReaderRequestSchema.safeParse({ slotId: SLOT_ID, did: 'alice' }).success).toBe(false);
    expect(IssueDocumentReaderRequestSchema.safeParse({ slotId: SLOT_ID, did: '' }).success).toBe(false);
  });

  it('rejects did:key, which no wallet can present against the minted credential', () => {
    // The reference OID4VCI flow binds the holder through `cnf.kid = <did:jwk>#0`;
    // a did:key holder would mint a credential nothing can satisfy.
    expect(
      IssueDocumentReaderRequestSchema.safeParse({
        slotId: SLOT_ID,
        did: 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK',
      }).success,
    ).toBe(false);
    expect(IssueDocumentReaderRequestSchema.safeParse({ slotId: SLOT_ID, did: 'did:web:example.com' }).success).toBe(
      false,
    );
  });

  it('rejects a did:jwk whose suffix is not a base64url-encoded JSON object', () => {
    // `bm90LWpzb24` is "not-json"; `InN0cmluZyI` is the JSON string "string".
    expect(IssueDocumentReaderRequestSchema.safeParse({ slotId: SLOT_ID, did: 'did:jwk:bm90LWpzb24' }).success).toBe(
      false,
    );
    expect(IssueDocumentReaderRequestSchema.safeParse({ slotId: SLOT_ID, did: 'did:jwk:InN0cmluZyI' }).success).toBe(
      false,
    );
    // Decodes to `{}`, which names no key type.
    expect(IssueDocumentReaderRequestSchema.safeParse({ slotId: SLOT_ID, did: 'did:jwk:e30' }).success).toBe(false);
  });

  it('rejects a did:jwk whose kty is present but not a key type name', () => {
    // `eyJrdHkiOm51bGx9` is `{"kty":null}`; `eyJrdHkiOnsiYSI6MX19` is
    // `{"kty":{"a":1}}`. Both carry a `kty` member and neither names a key type,
    // so testing for the member alone would have accepted them.
    expect(
      IssueDocumentReaderRequestSchema.safeParse({ slotId: SLOT_ID, did: 'did:jwk:eyJrdHkiOm51bGx9' }).success,
    ).toBe(false);
    expect(
      IssueDocumentReaderRequestSchema.safeParse({ slotId: SLOT_ID, did: 'did:jwk:eyJrdHkiOnsiYSI6MX19' }).success,
    ).toBe(false);
  });
});

describe('document reader issuance response schema', () => {
  const response = {
    credential: 'eyJhbGciOiJFZERTQSJ9.eyJpc3MiOiJkaWQ6andrOiJ9~WyJzYWx0Iiwia2V5IiwiMHhhYiJd~',
    issuer: HOLDER_DID,
    vct: 'DocumentReader',
    expiresAt: '2027-11-02T10:00:00.000Z',
  };

  it('accepts the body the gateway answers with', () => {
    expect(IssueDocumentReaderResponseSchema.parse(response)).toEqual(response);
  });

  it('rejects a credential of another type, which a slot policy would not match', () => {
    expect(IssueDocumentReaderResponseSchema.safeParse({ ...response, vct: 'IdentityCredential' }).success).toBe(false);
  });

  it('rejects an expiresAt that is not an ISO-8601 instant', () => {
    expect(IssueDocumentReaderResponseSchema.safeParse({ ...response, expiresAt: 'next November' }).success).toBe(
      false,
    );
    // A bare date carries no time, so a client cannot say when it expired.
    expect(IssueDocumentReaderResponseSchema.safeParse({ ...response, expiresAt: '2027-11-02' }).success).toBe(false);
  });
});

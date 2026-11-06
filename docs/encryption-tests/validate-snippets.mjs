#!/usr/bin/env node
/**
 * Validates the executable code snippets in `docs/tasra-encrypted-channels.md`.
 *
 * The snippets are extracted from the document rather than copied here, so this
 * fails when the prose and the code drift apart — which is the whole point of
 * testing documentation. Three things happen to each TypeScript block:
 *
 * 1. **It is typechecked** against the installed `@t3foundry/tasra-sdk`, the same
 *    declarations the gateway compiles against. A renamed option, a widened type
 *    or a removed export fails here rather than in a client six months later.
 * 2. **It is executed.** `sealMessage` and `openMessage` are transcribed by the
 *    TypeScript compiler and run for real, sealing a message to a BLS12-381 key
 *    this harness holds and opening it through a stubbed keeper committee.
 * 3. **Its output is validated** against `apps/gateway/kem-wrapped.json`, the
 *    normative schema, using the patterns and required lists from that file.
 *
 * Not covered: the `http` blocks are illustrative (they contain `…` elisions and
 * need a live gateway), and `credentialAuthorization` needs a verifier agent and a
 * wallet. That block is typechecked but not executed.
 *
 * Run with: node docs/encryption-tests/validate-snippets.mjs
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import ts from 'typescript';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const DOCUMENT = join(root, 'docs/tasra-encrypted-channels.md');
const SCHEMA = join(root, 'apps/gateway/kem-wrapped.json');

// ─── Dependencies, borrowed from the gateway ────────────────────────────────
//
// The SDK is a gateway dependency, not a root one, and this directory is not a
// workspace project. Resolving through `apps/gateway/package.json` keeps the
// documentation tests on exactly the version the gateway ships, without adding a
// second declaration of it (and a lockfile churn) to the repository root.

const gatewayRequire = createRequire(join(root, 'apps/gateway/package.json'));
const sdkEntry = gatewayRequire.resolve('@t3foundry/tasra-sdk');
const sdkAppEntry = gatewayRequire.resolve('@t3foundry/tasra-sdk/app');

// `@noble/curves` belongs to the SDK, so it is resolved from the SDK's own root.
// It is needed here for one thing: deriving a group public key from a known
// master secret, so the round trip below can actually open what it sealed.
const nobleEntry = createRequire(sdkEntry).resolve('@noble/curves/bls12-381');

const loadModule = (entry) => import(pathToFileURL(entry).href);
const [sdk, sdkApp, { bls12_381 }] = await Promise.all([
  loadModule(sdkEntry),
  loadModule(sdkAppEntry),
  loadModule(nobleEntry),
]);

// ─── A deterministic slot key ───────────────────────────────────────────────
//
// Any non-zero scalar below the Fr order is a valid master secret. This one is
// fixed so a failure reproduces exactly; the secret never leaves the process.

const MASTER_SCALAR = 0x0123456789abcdefn;

const toHex = (bytes) => Buffer.from(bytes).toString('hex');

const mpkBytes = bls12_381.G2.ProjectivePoint.BASE.multiply(MASTER_SCALAR).toRawBytes(true);
const mpkHex = `0x${toHex(mpkBytes)}`;

/** The master secret as the 32-byte little-endian form `decryptWithMasterKey` takes. */
const mskBytes = (() => {
  const bytes = new Uint8Array(32);
  let remaining = MASTER_SCALAR;
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return bytes;
})();

const SLOT_ID = `0x${'3a'.repeat(32)}`;
const RECORD_ID = '0b6f8e0e-7f3f-4a4b-9c2f-2f6f6a1b4c77';
const DEPLOYMENT = { chainId: 43113, keyRegistry: '0x45f432ab5709e9920b5ec349d29663d7200a8c39' };

// ─── 1. Extract the document's fences ───────────────────────────────────────

const markdown = await readFile(DOCUMENT, 'utf8');

const fences = [...markdown.matchAll(/```([\w-]*)\n([\s\S]*?)```/g)].map(([, language, body]) => ({
  language: language || 'text',
  body,
}));

const typescriptBlocks = fences.filter(({ language }) => language === 'ts' || language === 'typescript');

/**
 * Each snippet is claimed by a marker unique to it. A TypeScript block nobody
 * claims fails the run, so adding an example to the document means deciding
 * whether it is testable — silence is not an option.
 */
const SNIPPETS = [
  { name: 'public key decode (§4)', marker: /const mpkBytes = hexToBytes\(publicKey\)/ },
  { name: 'sealMessage (§7)', marker: /async function sealMessage\(/ },
  { name: 'looksEncrypted (§8)', marker: /const looksEncrypted = \(text: string\)/ },
  { name: 'openMessage (§9)', marker: /async function openMessage\(/ },
  { name: 'credentialAuthorization (§9)', marker: /const authorize = credentialAuthorization\(\{/ },
];

const claimed = new Map();
for (const snippet of SNIPPETS) {
  const matches = typescriptBlocks.filter(({ body }) => snippet.marker.test(body));
  assert.equal(
    matches.length,
    1,
    `expected exactly one TypeScript block for "${snippet.name}", found ${matches.length}. ` +
      'If the snippet was rewritten, update its marker in this file.',
  );
  claimed.set(snippet.name, matches[0].body);
}

const unclaimed = typescriptBlocks.filter(({ body }) => !SNIPPETS.some(({ marker }) => marker.test(body)));
assert.deepEqual(
  unclaimed.map(({ body }) => body.split('\n')[0]),
  [],
  'these TypeScript snippets are not covered by the validation suite — add a marker and decide how to test them',
);

const block = (name) => claimed.get(name).trimEnd();

// ─── 2. The preamble the document leaves implicit ───────────────────────────
//
// §4 reads `publicKey` from the response it just printed, and §9's authorizer
// block names four values the surrounding prose says the client holds. Typing
// them here is what turns the snippets into a compilable module.

const PREAMBLE = [
  `import type { CredentialAuthorizationOptions, TasraIdentity } from '@t3foundry/tasra-sdk/app';`,
  `declare const publicKey: \`0x\${string}\`;`,
  'declare const verifierAgentUrl: string;',
  'declare const signer: CredentialAuthorizationOptions["signer"];',
  'declare const identity: TasraIdentity;',
  'declare const readerCredential: string;',
].join('\n');

// §4 is its own snippet with its own imports, so it is compiled separately —
// otherwise its `hexToBytes` import collides with the one in §7. §9 says it uses
// §7's helpers, so those two blocks (and the detector) are compiled as one module.
const TYPECHECK_UNITS = [
  {
    name: 'public key decode (§4)',
    source: [PREAMBLE, block('public key decode (§4)')].join('\n\n'),
  },
  {
    name: 'encrypt, detect and decrypt (§7–§9)',
    source: [
      PREAMBLE,
      block('sealMessage (§7)'),
      block('looksEncrypted (§8)'),
      block('openMessage (§9)'),
      block('credentialAuthorization (§9)'),
    ].join('\n\n'),
  },
];

/**
 * Compile a source string in memory and return its diagnostics.
 *
 * The snippets are browser code — `crypto.subtle`, `btoa` — so `lib.dom` is what
 * they have to satisfy, not `@types/node`. Module resolution is pinned by `paths`
 * because the SDK lives under `apps/gateway/node_modules`, which is not on this
 * directory's resolution path.
 */
const typecheck = (source) => {
  const options = {
    target: ts.ScriptTarget.ES2022,
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    types: [],
    baseUrl: here,
    paths: {
      '@t3foundry/tasra-sdk': [join(dirname(sdkEntry), 'index.d.ts')],
      '@t3foundry/tasra-sdk/app': [join(dirname(sdkAppEntry), 'index.d.ts')],
    },
  };

  // A path that resolves for diagnostics but is never written: the host below
  // hands the compiler the string instead of a file.
  const virtual = join(here, 'snippets.ts');
  const host = ts.createCompilerHost(options);
  const readSourceFile = host.getSourceFile.bind(host);

  host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) =>
    fileName === virtual
      ? ts.createSourceFile(fileName, source, languageVersion, true, ts.ScriptKind.TS)
      : readSourceFile(fileName, languageVersion, onError, shouldCreate);
  host.fileExists = (fileName) => fileName === virtual || ts.sys.fileExists(fileName);
  host.readFile = (fileName) => (fileName === virtual ? source : ts.sys.readFile(fileName));

  return ts.getPreEmitDiagnostics(ts.createProgram([virtual], options, host)).map((diagnostic) => {
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ');
    if (!diagnostic.file || diagnostic.start === undefined) return message;
    const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
    return `snippets.ts:${line + 1}:${character + 1} ${message}`;
  });
};

// ─── 3. Execute the snippets ────────────────────────────────────────────────
//
// Transpiled to CommonJS so `require` can be supplied from here: a snippet that
// imports anything beyond the SDK fails immediately rather than silently working
// against a different module.

const RUNTIME_SOURCE = [
  block('public key decode (§4)'),
  block('sealMessage (§7)'),
  block('looksEncrypted (§8)'),
  block('openMessage (§9)'),
].join('\n\n');

const requireShim = (specifier) => {
  if (specifier === '@t3foundry/tasra-sdk') return sdk;
  if (specifier === '@t3foundry/tasra-sdk/app') return sdkApp;
  throw new Error(`the snippets imported "${specifier}", which this harness does not provide`);
};

// The CommonJS emitter prefixes its output with `Object.defineProperty(exports, …)`
// even for a module with no exports, so the wrapper hands it an object to write to
// and appends the names the tests below need.
const runtime = ts.transpileModule(RUNTIME_SOURCE, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

const snippets = new Function(
  'require',
  'publicKey',
  `"use strict";\nconst exports = {};\n${runtime}\nreturn { mpkBytes, sealMessage, openMessage, looksEncrypted };`,
)(requireShim, mpkHex);

// ─── 4. A minimal JSON Schema validator ─────────────────────────────────────
//
// Enough of draft 2020-12 for `kem-wrapped.json`: $ref into $defs, type,
// required, additionalProperties, pattern, const and the length bounds. Pulling
// the vocabulary from the schema file means the test follows it when it changes,
// instead of restating it in a second place that can rot.

const schema = JSON.parse(await readFile(SCHEMA, 'utf8'));

const dereference = (node) => {
  if (!node.$ref) return node;
  const { $ref, ...rest } = node;
  const target = $ref
    .replace(/^#\//, '')
    .split('/')
    .reduce((value, key) => value?.[key], schema);
  if (!target) throw new Error(`the schema's $ref ${$ref} does not resolve`);
  // Siblings of $ref still apply in 2020-12, which is how `minLength`/`maxLength`
  // reach the envelope fields that also reference the base64 definition.
  return { ...target, ...rest };
};

const typeName = (value) => (value === null ? 'null' : Array.isArray(value) ? 'an array' : `a ${typeof value}`);

const validate = (value, node, path = '$') => {
  const subject = dereference(node);
  const problems = [];
  const complain = (message) => problems.push(`${path} ${message}`);

  if (subject.const !== undefined) {
    if (value !== subject.const) complain(`must be ${JSON.stringify(subject.const)}, got ${JSON.stringify(value)}`);
    return problems;
  }

  if (subject.type === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      complain(`must be an object, got ${typeName(value)}`);
      return problems;
    }
    for (const key of subject.required ?? []) {
      if (!(key in value)) complain(`is missing required property "${key}"`);
    }
    for (const [key, child] of Object.entries(value)) {
      const property = subject.properties?.[key];
      if (property) problems.push(...validate(child, property, `${path}.${key}`));
      else if (subject.additionalProperties === false) complain(`has unexpected property "${key}"`);
    }
    return problems;
  }

  if (subject.type === 'string') {
    if (typeof value !== 'string') {
      complain(`must be a string, got ${typeName(value)}`);
      return problems;
    }
    if (subject.pattern && !new RegExp(subject.pattern).test(value)) {
      complain(`(${JSON.stringify(value)}) does not match ${subject.pattern}`);
    }
    if (subject.minLength !== undefined && value.length < subject.minLength) {
      complain(`is shorter than ${subject.minLength} characters`);
    }
    if (subject.maxLength !== undefined && value.length > subject.maxLength) {
      complain(`is longer than ${subject.maxLength} characters`);
    }
    return problems;
  }

  if (subject.type === 'integer') {
    if (!Number.isInteger(value)) {
      complain(`must be an integer, got ${typeName(value)}`);
      return problems;
    }
    if (subject.minimum !== undefined && value < subject.minimum) complain(`must be at least ${subject.minimum}`);
    return problems;
  }

  throw new Error(`the validator does not implement "${subject.type ?? subject.const}" at ${path}`);
};

// ─── 5. Fixtures ────────────────────────────────────────────────────────────

/** A committee that really unwraps the key, so the two snippets have to interlock. */
const committee = () => {
  const calls = { bls: 0, decrypt: 0 };
  return {
    calls,
    client: {
      slots: {
        bls: async (slotId) => {
          calls.bls += 1;
          return {
            slotId,
            decrypt: async (identity, ciphertext) => {
              calls.decrypt += 1;
              return { plaintext: sdk.decryptWithMasterKey(mskBytes, ciphertext, identity) };
            },
          };
        },
      },
    },
  };
};

const channelSlotId = SLOT_ID;
const authorize = () => {
  throw new Error('the committee stub must not need an authorization in this harness');
};

const seal = async (text, overrides = {}) =>
  snippets.sealMessage(text, { slotId: SLOT_ID, publicKey: mpkHex, epoch: 0, ...overrides }, RECORD_ID, 0, DEPLOYMENT);

// ─── 6. Tests ───────────────────────────────────────────────────────────────

/**
 * GitHub's heading-anchor rule, close enough for this document's headings:
 * lowercase, drop punctuation and markup, collapse whitespace to hyphens.
 */
const slug = (heading) =>
  heading
    .trim()
    .toLowerCase()
    .replace(/[`*]/g, '')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s+/g, '-');

test('every internal link points at a heading that exists', () => {
  // Steps are renumbered by hand, so a link can outlive the heading it named.
  const headings = [...markdown.matchAll(/^#{1,6}\s+(.+)$/gm)].map(([, text]) => slug(text));
  const anchors = [...markdown.matchAll(/\]\(#([^)]+)\)/g)].map(([, anchor]) => anchor);

  assert.ok(anchors.length > 0, 'the document has no internal links, so this test proves nothing');
  assert.deepEqual(
    anchors.filter((anchor) => !headings.includes(anchor)),
    [],
    'these internal links do not resolve to a heading',
  );
});

test('the steps are numbered without a gap', () => {
  // A missing step means a section was lost rather than reordered — which is how
  // this check earned its place: §2 had been dropped from the file.
  const steps = [...markdown.matchAll(/^## (\d+)\. /gm)].map(([, number]) => Number(number));
  assert.deepEqual(
    steps,
    steps.map((_, index) => index + 1),
  );
});

test('every TypeScript snippet in the document compiles against the installed SDK', () => {
  for (const unit of TYPECHECK_UNITS) {
    assert.deepEqual(typecheck(unit.source), [], `${unit.name} does not compile`);
  }
});

test('the §4 snippet decodes the public key to the 96 bytes the prose promises', () => {
  assert.equal(mpkBytes.length, 96);
  assert.equal(snippets.mpkBytes.length, 96);
  assert.deepEqual(Buffer.from(snippets.mpkBytes), Buffer.from(mpkBytes));
});

test('the §1 channel rule accepts exactly the documented shapes', () => {
  const fence = fences.find(({ language, body }) => language === 'text' && body.trimStart().startsWith('^tasra:'));
  assert.ok(fence, 'the channel-description pattern is missing from the document');

  const rule = new RegExp(fence.body.trim());
  const slot = `0x${'a1'.repeat(32)}`;

  const accepted = [`tasra:${slot}`, `tasra:${slot} Incident room`, `tasra:${slot}\nroom`];
  for (const description of accepted) {
    const match = rule.exec(description);
    assert.ok(match, `expected ${JSON.stringify(description)} to be recognised`);
    assert.equal(match.groups.slotId, slot);
  }

  const rejected = [
    `Encrypted: tasra:${slot}`, // not anchored
    ` tasra:${slot}`, // leading space
    `tasra:${slot.slice(0, -2)}`, // truncated, so a different identifier
    `tasra:${slot}0`, // 33 bytes, not 32
    `tasra:${slot}.`, // the id must be followed by whitespace or the end
    `tasra:0x${'g1'.repeat(32)}`, // not hex
    slot,
  ];
  for (const description of rejected) {
    assert.equal(rule.exec(description), null, `expected ${JSON.stringify(description)} to be ignored`);
  }
});

test('the §8 detector recognises records and refuses to fall back to plaintext', async () => {
  const record = await seal('a message that should never be shown as text');

  assert.equal(snippets.looksEncrypted(JSON.stringify(record)), true);
  assert.equal(snippets.looksEncrypted(`\n  ${JSON.stringify(record)}`), true);

  assert.equal(snippets.looksEncrypted('just a normal message'), false);
  assert.equal(snippets.looksEncrypted('{ "manifest": { "schema": "something-else" } }'), false);
  assert.equal(snippets.looksEncrypted('{ not json'), false);
  assert.equal(snippets.looksEncrypted('{"manifest":null}'), false);
});

test('§7 produces a record that satisfies kem-wrapped.json', async () => {
  const record = await seal('the quick brown fox');

  assert.deepEqual(validate(record, schema), []);
  assert.equal(record.manifest.schema, 'tasra-encrypt/v2');
  assert.equal(record.manifest.recordId, RECORD_ID);
  assert.equal(record.manifest.slotId, SLOT_ID);
  assert.equal(record.manifest.chainId, DEPLOYMENT.chainId);
  assert.equal(record.manifest.keyRegistry, DEPLOYMENT.keyRegistry);
  assert.equal(record.manifest.version, 0);
});

test('§7 leaks no plaintext into the record it writes', async () => {
  const plaintext = 'the quick brown fox';
  const record = await seal(plaintext);

  // `title` is the one manifest field a careless client fills with the message,
  // so it is pinned to the constant the document uses.
  assert.equal(record.manifest.title, 'message');
  assert.ok(!JSON.stringify(record).includes(plaintext), 'the plaintext appears in the serialized record');
});

test('§7 writes the six invariants §3 says a reader must check', async () => {
  const record = await seal('check the envelope');
  const envelope = sdk.fromBytes(Uint8Array.from(atob(record.envelope.encryptedAesKey), (c) => c.charCodeAt(0)));

  // 1. A v0x02 group envelope, so slot and epoch travel with the ciphertext.
  assert.equal(Buffer.from(record.envelope.encryptedAesKey, 'base64')[0], 0x02);

  // 2-3. The envelope names the same slot and epoch as the manifest.
  assert.equal(toHex(envelope.slotId), record.manifest.slotId.slice(2));
  assert.equal(envelope.epoch, BigInt(record.envelope.epoch));

  // 4. The KEM identity is the digest, as ASCII — the binding §3 calls load-bearing.
  assert.equal(new TextDecoder().decode(envelope.identity), record.manifest.documentSha256);
  assert.equal(envelope.identity.length, 64);

  // 5. An IV, then at least a tag.
  const aesCiphertext = Buffer.from(record.envelope.aesCiphertext, 'base64');
  assert.ok(aesCiphertext.length >= 12 + 16);

  // 6. The manifest names the channel's slot.
  assert.equal(record.manifest.slotId.toLowerCase(), channelSlotId.toLowerCase());
});

test('§9 opens what §7 sealed, through a committee that unwraps the real key', async () => {
  const plaintext = 'a message that only the committee can open';
  const record = await seal(plaintext);
  const { calls, client } = committee();

  const opened = await snippets.openMessage(record, channelSlotId, client, authorize);

  assert.equal(opened, plaintext);
  assert.equal(calls.bls, 1);
  assert.equal(calls.decrypt, 1);
});

test('§9 refuses a manifest whose digest was altered, before spending a decryption', async () => {
  const record = await seal('tamper with the digest');
  const tampered = { ...record, manifest: { ...record.manifest, documentSha256: 'f'.repeat(64) } };
  const { calls, client } = committee();

  await assert.rejects(
    () => snippets.openMessage(tampered, channelSlotId, client, authorize),
    // The identity invariant, not the KEM: the check runs first on purpose.
    /Envelope identity is not this record digest/,
  );
  assert.equal(calls.bls, 0, 'the committee was contacted before the envelope was validated');
  assert.equal(calls.decrypt, 0);
});

test('§9 refuses a record that names another channel’s slot', async () => {
  const record = await seal('belongs somewhere else');
  const { calls, client } = committee();

  await assert.rejects(
    () => snippets.openMessage(record, `0x${'ff'.repeat(32)}`, client, authorize),
    /Record names a slot this channel does not use/,
  );
  assert.equal(calls.bls, 0);
});

test('§9 refuses a record whose schema it does not implement', async () => {
  const record = await seal('wrong schema');
  const tampered = { ...record, manifest: { ...record.manifest, schema: 'tasra-encrypt/v1' } };

  await assert.rejects(
    () => snippets.openMessage(tampered, channelSlotId, committee().client, authorize),
    /Unsupported record schema/,
  );
});

test('§9 refuses a record whose epoch disagrees with its envelope', async () => {
  const record = await seal('epoch drift');
  const tampered = { ...record, envelope: { ...record.envelope, epoch: record.envelope.epoch + 1 } };

  await assert.rejects(
    () => snippets.openMessage(tampered, channelSlotId, committee().client, authorize),
    /Envelope epoch mismatch/,
  );
});

test('a tampered AES payload fails authentication after the key is recovered', async () => {
  const record = await seal('tamper with the payload');
  const raw = Buffer.from(record.envelope.aesCiphertext, 'base64');
  raw[raw.length - 1] ^= 0x01; // flip a tag byte
  const tampered = { ...record, envelope: { ...record.envelope, aesCiphertext: raw.toString('base64') } };
  const { calls, client } = committee();

  // The committee still unwraps the key — that depends only on the KEM
  // ciphertext, which was untouched — and GCM then refuses the payload. The
  // message is browser-specific ("invalid tag" on Chrome, an opaque
  // `OperationError` elsewhere), so the error name is what is asserted.
  await assert.rejects(
    () => snippets.openMessage(tampered, channelSlotId, client, authorize),
    (error) =>
      error?.name === 'OperationError' || /invalid tag|BAD_DECRYPT|authentication/i.test(String(error?.message)),
  );
  assert.equal(calls.decrypt, 1);
});

test('the KEM itself refuses the wrong identity, as §3 says it must', async () => {
  const record = await seal('identity binding');
  const envelope = sdk.fromBytes(Uint8Array.from(atob(record.envelope.encryptedAesKey), (c) => c.charCodeAt(0)));
  const wrongIdentity = new TextEncoder().encode('0'.repeat(64));

  // Without this property, an altered `documentSha256` would be a failed
  // comparison rather than a failed unwrap, and the doc's claim would be wrong.
  assert.throws(() => sdk.decryptWithMasterKey(mskBytes, envelope.ciphertext, wrongIdentity), /authentication/);

  // The control: the identity the producer bound still opens, and yields a key.
  const dataKey = sdk.decryptWithMasterKey(mskBytes, envelope.ciphertext, envelope.identity);
  assert.equal(dataKey.length, 32);
});

test('the record survives a JSON round trip unchanged', async () => {
  // Chat transports the record as a string, so it has to survive serialisation
  // and reparse without losing anything the reader validates.
  const record = await seal('off and back');
  const reparsed = JSON.parse(JSON.stringify(record));

  assert.deepEqual(reparsed, record);
  assert.deepEqual(validate(reparsed, schema), []);
});

# Documentation tests

Validation for the executable snippets in
[`../tasra-encrypted-channels.md`](../tasra-encrypted-channels.md).

```sh
pnpm test:docs
# or, without the root script:
node docs/encryption-tests/validate-snippets.mjs
```

Exits non-zero on the first failure and prints the failing assertion. `node:test`
reports every case, not just the first, so one run shows everything that drifted.

## What it checks

The snippets are **extracted from the markdown**, never copied here. That is the
point: a documentation test that restates the code tests the copy, not the
document.

| Check                | What it proves                                                                                                       |
| -------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Internal links       | Every `](#anchor)` resolves to a heading — the steps below are renumbered by hand, so a link can outlive its target. |
| Step numbering       | The numbered steps run 1…n with no gap, so a lost section is not mistaken for a reorder.                             |
| Coverage             | Every `ts` block is claimed by a named snippet. A new example cannot slip in untested.                               |
| Compilation          | The blocks typecheck under `strict`, with `lib.dom`, against the installed SDK.                                      |
| §1 channel rule      | The description regex accepts and rejects the shapes the prose claims.                                               |
| §4 public key decode | `hexToBytes(publicKey)` really is the 96 bytes the prose promises.                                                   |
| §7 sealMessage       | The record validates against `apps/gateway/kem-wrapped.json`, leaks no plaintext, and carries all six invariants.    |
| §8 looksEncrypted    | Records are recognised; plain text, other schemas and malformed JSON are not.                                        |
| §9 openMessage       | It opens what §7 sealed, through a committee that unwraps the real data key.                                         |
| §9 refusal paths     | Altered digest, foreign slot, wrong schema and epoch drift all fail _before_ a committee call.                       |
| Tamper detection     | A flipped ciphertext byte fails AES-GCM authentication; a wrong KEM identity fails the unwrap.                       |

## How it works, and why

**It borrows the gateway's dependencies.** This directory is not a workspace
project. The SDK and `@noble/curves` are resolved through
`apps/gateway/package.json` and the SDK's own module root, so the documentation is
tested against exactly the version the gateway ships. Adding a second declaration
of either package here would let the two drift, which is the failure this suite
exists to prevent.

**It holds a real key.** A BLS12-381 group public key is derived from a fixed
master scalar below the Fr order, so the harness can both seal and open. Nothing
here is a secret: the scalar is in the file precisely so a failure reproduces.

**The committee is a stub, but not a mock.** It runs `decryptWithMasterKey` — the
same primitive a keeper would apply — so `openMessage` consumes a genuinely
unwrapped data key and the two snippets have to interlock. What it does not
simulate is the verifier agent, the receipts, or the network.

**The schema is read, not restated.** `kem-wrapped.json` supplies the patterns,
required lists and `additionalProperties` the validator applies, so the test
follows the schema file when it changes. The validator implements only the
keywords that file uses; an unsupported keyword throws rather than passing
silently.

## What it does not check

- **The `http` blocks.** They contain `…` elisions and require a live gateway.
  Their shapes are covered by `packages/api-contract` and the gateway's own tests.
- **`credentialAuthorization`.** It needs a verifier agent and a wallet, so the
  block is typechecked but not executed.
- **Zeroization.** `dataKey.fill(0)` is a side effect on a buffer the harness never
  sees; there is nothing to assert without monkey-patching `crypto`, which would
  weaken every other test here.

## When it fails

A failure is one of two things, and they need opposite fixes:

1. **The document is wrong** — a snippet no longer compiles, or its record breaks
   an invariant. Fix the document. The first run of this suite found three: a
   `Uint8Array` where WebCrypto demands an `ArrayBuffer`-backed view, the same
   problem on the unwrapped key, and an error string that only one browser emits.
2. **The harness is out of date** — a snippet was rewritten, so its marker in
   `validate-snippets.mjs` no longer matches. Update the marker, and check whether
   the snippet is still exercised at runtime; the coverage check fails loudly on
   any `ts` block it cannot claim.

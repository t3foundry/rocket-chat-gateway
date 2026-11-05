#!/usr/bin/env node
// Read the DCQL rule a key-slot commits, by opening an OID4VP session against
// the verifier agent and decoding the `dcql_query` out of the request object.
//
// Usage:
//   node scripts/read-slot-dcql.mjs <slotId>
//   node scripts/read-slot-dcql.mjs 0x05eea2ad0e0ba9a794be552b563269377bd5a17bca4e0c56246a4305ba461a3f
//
// A fresh random signing key is generated for every run — the verifier no
// longer checks the creator identity for DCQL reads, so any valid signer is
// accepted. The slot is opened with a `decrypt` action and a placeholder
// 32-byte digest — the verifier cannot derive a decrypt digest itself (it
// lives in the keeper), so any well-formed digest yields the same JAR and its
// DCQL query.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(__dirname, '..');

const slotId = process.argv[2];
if (!slotId) {
  console.error('usage: node scripts/read-slot-dcql.mjs <slotId>');
  process.exit(1);
}

// The SDK is a dependency of apps/web, not of the workspace root, so resolve it
// from there rather than relying on hoisting.
const requireFromWeb = createRequire(join(webRoot, 'package.json'));
const { resolveApplicationManifest, createLocalWallet } = await import(
  requireFromWeb.resolve('@t3foundry/tasra-sdk/app')
);
const { openVerifierAgentSession, fetchRequestObject } = await import(
  requireFromWeb.resolve('@t3foundry/tasra-sdk/oid4vp')
);

const manifest = JSON.parse(readFileSync(join(webRoot, 'src/tasra/network.json'), 'utf8'));
const { deployment, verifierAgentUrl } = resolveApplicationManifest(manifest, {
  coordinator: 'lowest-operator-id',
});

// A fresh key is generated each run — no CREATOR_KEY env var needed.
const wallet = createLocalWallet(deployment);

console.log('signer:', wallet.address);
console.log('keyRegistry:', deployment.addresses.KeyRegistry);
console.log('opening decrypt session for slot', slotId, '…');

try {
  const session = await openVerifierAgentSession({
    chainId: deployment.chainId,
    keyRegistry: deployment.addresses.KeyRegistry,
    slotId,
    action: 'decrypt',
    payloadDigest: new Uint8Array(32),
    description: 'read slot DCQL rule',
    verifierAgentUrl,
    signer: wallet.signer,
  });

  const ro = await fetchRequestObject(session.requestUri);
  console.log('\n=== dcql_query ===');
  console.log(JSON.stringify(ro.claims.dcql_query, null, 2));
} catch (error) {
  console.error('failed:', error instanceof Error ? error.message : error);
  process.exit(1);
}

'use strict';
/**
 * END-TO-END: a REAL signed cr.exec.v1 grant → the gate's verdict.
 *
 * Nothing is injected. The grant is minted with a real Ed25519 key, signed over the real signing
 * input, resolved through the real pinned-keyring loader (verify.js loadKeyring), verified by the
 * real offline verifier, and matched against a scope hash recomputed from the real head bytes.
 *
 * SUBSTITUTE, NAMED: the app's issuer (issueExecutionGrant) is not importable here without taking
 * a dependency on coderifts-app, so the test mints with the gate's own MIRRORED signingInput. That
 * is honest only because test/grant-coverage.test.js already asserts the mirror is byte-identical
 * to the app's implementation; if the mirror drifts, that test fails first.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const { evaluateGate } = require('../src/gate');
const { loadKeyring } = require('../src/verify');
const { verifyExecutionGrant, signingInput } = require('../src/execution-grant-verify');
const { deriveGovernedArtifacts } = require('../src/governed-paths');
const { afterPayloadCanonical, computeScopeHash } = require('../src/grant-coverage');
const { newSigner, mintV4, writeKeyringFile, envelope } = require('./mint');

const CTX = { operation: 'merge', repository: 'acme/api', base: 'base-aaa', head: 'head-bbb' };
const HEAD_BYTES = 'openapi: 3.0.0\ninfo:\n  title: t\n  version: 1.0.0\npaths: {}\n';
const GOVERNED_PATH = 'api/openapi.yaml';

const signer = newSigner('test-k1');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-e2e-'));
const keyringFile = writeKeyringFile(tmp, signer);

/** Mint a real grant: same field list, same signing input, real Ed25519 signature. */
function mintGrant({ after, audience = CTX.repository, operation = 'merge', target_id = GOVERNED_PATH, now = Date.now() }) {
  const arts = deriveGovernedArtifacts({ changed: [{ path: target_id, after }] });
  const body = {
    v: 'cr.exec.v1',
    kid: signer.kid,
    receipt_digest: `sha256:${crypto.createHash('sha256').update('receipt').digest('hex')}`,
    scope_hash: computeScopeHash({ operation, target_id, after_payload: afterPayloadCanonical(arts) }),
    audience, operation, target_id,
    jti: 'jti-1',
    iat: new Date(now - 1000).toISOString(),
    exp: new Date(now + 300_000).toISOString(),
  };
  const sig = crypto.sign(null, Buffer.from(signingInput(body), 'utf8'), signer.privateKey);
  return `${Buffer.from(JSON.stringify(body), 'utf8').toString('base64url')}.${Buffer.from(sig).toString('base64url')}`;
}

async function runE2E({ headContent, token }) {
  const keyring = await loadKeyring(keyringFile);
  const env = envelope({ execution_action: 'CONTINUE', decision: 'ALLOW', extra: { preflight_mode: 'authorize', ...CTX } });
  const governed = deriveGovernedArtifacts({ changed: [{ path: GOVERNED_PATH, after: headContent }] });
  const grantResult = token ? verifyExecutionGrant(token, { keyring }) : null;
  return {
    grantResult,
    gate: evaluateGate({
      preflightResponse: { chain_receipt: mintV4(signer, env), decision_result: env },
      keyring, headSha: CTX.head, expectedContext: CTX,
      require_grant: true, grant_result: grantResult,
      governed_artifacts: governed, grant_operation: 'merge', repository: CTX.repository,
    }),
  };
}

test('E2E 1/3: a real signed grant over the exact head bytes → PASS', async () => {
  const token = mintGrant({ after: HEAD_BYTES });
  const { grantResult, gate } = await runE2E({ headContent: HEAD_BYTES, token });
  assert.equal(grantResult.valid, true, `grant did not verify: ${grantResult.status}/${grantResult.reason}`);
  assert.equal(grantResult.status, 'GRANT_CURRENT');
  assert.equal(gate.pass, true);
  assert.equal(gate.reason, 'signed_allow_for_diff');
});

test('E2E 2/3: flip ONE byte of the file → BLOCK grant_does_not_cover_path', async () => {
  const token = mintGrant({ after: HEAD_BYTES });
  const flipped = HEAD_BYTES.replace('version: 1.0.0', 'version: 1.0.1');
  assert.notEqual(flipped, HEAD_BYTES);
  const { grantResult, gate } = await runE2E({ headContent: flipped, token });
  assert.equal(grantResult.valid, true, 'the grant itself is still authentic — only its coverage fails');
  assert.equal(gate.pass, false);
  assert.equal(gate.reason, 'grant_does_not_cover_path');
});

test('E2E 3/3: the same grant with a different repo audience → BLOCK grant_bound_elsewhere', async () => {
  const token = mintGrant({ after: HEAD_BYTES, audience: 'other/repo' });
  const { grantResult, gate } = await runE2E({ headContent: HEAD_BYTES, token });
  assert.equal(grantResult.valid, true);
  assert.equal(gate.pass, false);
  assert.equal(gate.reason, 'grant_bound_elsewhere');
});

test('E2E 4: a tampered grant payload → BLOCK grant_signature_invalid (not a coverage error)', async () => {
  const token = mintGrant({ after: HEAD_BYTES });
  const [p, s] = token.split('.');
  const body = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
  body.audience = 'attacker/repo';
  const forged = `${Buffer.from(JSON.stringify(body), 'utf8').toString('base64url')}.${s}`;
  const { grantResult, gate } = await runE2E({ headContent: HEAD_BYTES, token: forged });
  assert.equal(grantResult.valid, false);
  assert.equal(grantResult.status, 'INVALID_SIGNATURE');
  assert.equal(gate.reason, 'grant_signature_invalid');
});

test('E2E 5: an expired grant → BLOCK grant_expired', async () => {
  const token = mintGrant({ after: HEAD_BYTES, now: Date.now() - 3_600_000 });
  const { grantResult, gate } = await runE2E({ headContent: HEAD_BYTES, token });
  assert.equal(grantResult.status, 'GRANT_EXPIRED');
  assert.equal(gate.reason, 'grant_expired');
});

test('E2E 6: a grant signed by a RETIRED key is never live permission → grant_key_retired', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ret-'));
  const retiredFile = writeKeyringFile(dir, signer, 'retired');
  const token = mintGrant({ after: HEAD_BYTES });
  const grantResult = verifyExecutionGrant(token, { keyring: await loadKeyring(retiredFile) });
  assert.equal(grantResult.valid, false);
  assert.equal(grantResult.status, 'UNKNOWN_KEY');
  assert.equal(grantResult.reason, 'retired_kid');

  const env = envelope({ execution_action: 'CONTINUE', decision: 'ALLOW', extra: { preflight_mode: 'authorize', ...CTX } });
  const gate = evaluateGate({
    preflightResponse: { chain_receipt: mintV4(signer, env), decision_result: env },
    keyring: await loadKeyring(keyringFile), headSha: CTX.head, expectedContext: CTX,
    require_grant: true, grant_result: grantResult,
    governed_artifacts: deriveGovernedArtifacts({ changed: [{ path: GOVERNED_PATH, after: HEAD_BYTES }] }),
    grant_operation: 'merge', repository: CTX.repository,
  });
  assert.equal(gate.reason, 'grant_key_retired');
});

test('E2E 7: an unknown kid → BLOCK grant_unverified', async () => {
  const other = newSigner('other-kid');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-unk-'));
  const otherRing = writeKeyringFile(dir, other, 'active');
  const token = mintGrant({ after: HEAD_BYTES });
  const grantResult = verifyExecutionGrant(token, { keyring: await loadKeyring(otherRing) });
  assert.equal(grantResult.status, 'UNKNOWN_KEY');
  assert.equal(grantResult.reason, 'unknown_kid');
});

test('E2E 8: the governed set is DERIVED — a non-contract file changing needs no grant', async () => {
  const governed = deriveGovernedArtifacts({ changed: [
    { path: 'README.md', after: 'x' },
    { path: 'package.json', after: '{}' },
    { path: 'node_modules/pkg/openapi.yaml', after: 'y' },
  ] });
  assert.deepEqual(governed, [], 'none of these are contract artifacts');
});

test('E2E 9: an unreadable governed path outranks a valid grant', async () => {
  const token = mintGrant({ after: HEAD_BYTES });
  const keyring = await loadKeyring(keyringFile);
  const env = envelope({ execution_action: 'CONTINUE', decision: 'ALLOW', extra: { preflight_mode: 'authorize', ...CTX } });
  const gate = evaluateGate({
    preflightResponse: { chain_receipt: mintV4(signer, env), decision_result: env },
    keyring, headSha: CTX.head, expectedContext: CTX,
    require_grant: true,
    grant_result: verifyExecutionGrant(token, { keyring }),
    governed_artifacts: deriveGovernedArtifacts({ changed: [{ path: GOVERNED_PATH, unreadable: true }] }),
    grant_operation: 'merge', repository: CTX.repository,
  });
  assert.equal(gate.reason, 'path_unreadable');
});

'use strict';
/**
 * crbundle.v1 acceptance in the merge gate (1261).
 *
 * ── THE ONE THING THESE TESTS EXIST FOR ─────────────────────────────────────────────────────
 *
 * `SLOT.VERIFIED` is not the same as "proven". verify-bundle.js sets a slot VERIFIED whenever its
 * verifier returned `valid: true`, and `verifyProviderReadback` returns exactly that for an
 * UNSIGNED provider readback. So the interesting test is not "a good bundle passes" — it is that a
 * bundle whose merge_evidence is a self-asserted JSON blob does NOT thereby become proof, and that
 * the gate says which class each slot was in rather than printing a bare green.
 *
 * The bundles below carry REAL Ed25519 signatures over the real signing inputs, minted the same
 * way test/require-grant-e2e.test.js mints its grant. A fixture of hand-written JSON would test
 * the shape of this module and nothing about whether the vendored library agrees with it.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { evaluateGate } = require('../src/gate');
const { evaluateBundle, classOf, REQUIRED_PROVEN_SLOTS } = require('../src/bundle-gate');
const { loadKeyring } = require('../src/verify');
const { signingInput } = require('../src/execution-grant-verify');
const { receiptDigest } = require('../src/verify-grant.js');
const { deriveGovernedArtifacts } = require('../src/governed-paths');
const { afterPayloadCanonical, computeScopeHash } = require('../src/grant-coverage');
const { newSigner, mintV4, writeKeyringFile, envelope } = require('./mint');

const CTX = { operation: 'merge', repository: 'acme/api', base: 'base-aaa', head: 'head-bbb' };
const HEAD_BYTES = 'openapi: 3.0.0\ninfo:\n  title: t\n  version: 1.0.0\npaths: {}\n';
const GOVERNED_PATH = 'api/openapi.yaml';

const signer = newSigner('test-k1');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-bundle-'));
const keyringFile = writeKeyringFile(tmp, signer);

/**
 * MEASURED while writing these tests: verify-bundle.js:327-340 adds a `grant_binds_receipt`
 * linkage check — a bundle whose grant does not bind the bundle's own receipt is INVALID even
 * though both documents verify on their own. So the grant here binds the REAL receipt digest, not
 * a placeholder. A fixture that skipped this would have tested a bundle no holder can present.
 */
function mintGrant({ now = Date.now(), boundTo } = {}) {
  const arts = deriveGovernedArtifacts({ changed: [{ path: GOVERNED_PATH, after: HEAD_BYTES }] });
  const body = {
    v: 'cr.exec.v1',
    kid: signer.kid,
    receipt_digest: receiptDigest(boundTo),
    scope_hash: computeScopeHash({
      operation: 'merge', target_id: GOVERNED_PATH, after_payload: afterPayloadCanonical(arts),
    }),
    audience: CTX.repository, operation: 'merge', target_id: GOVERNED_PATH,
    jti: 'jti-bundle-1',
    iat: new Date(now - 1000).toISOString(),
    exp: new Date(now + 300_000).toISOString(),
  };
  const sig = crypto.sign(null, Buffer.from(signingInput(body), 'utf8'), signer.privateKey);
  return `${Buffer.from(JSON.stringify(body), 'utf8').toString('base64url')}.${Buffer.from(sig).toString('base64url')}`;
}

/** The per-slot material the library requires. Keys never come from the bundle. */
async function slotOpts() {
  const keyring = await loadKeyring(keyringFile);
  return {
    perSlot: {
      receipt: { ctx: { keyring, expectedKid: null } },
      execution_grant: { ctx: { keyring, expectedKid: null } },
    },
  };
}

function bundleWith(slots) {
  return { v: 'cr.bundle.v1', slots };
}

async function realBundle(extraSlots = {}) {
  const env = envelope({
    execution_action: 'CONTINUE', decision: 'ALLOW',
    extra: { preflight_mode: 'authorize', ...CTX },
  });
  const receipt = mintV4(signer, env);
  return {
    env,
    receipt,
    bundle: bundleWith({ receipt, execution_grant: mintGrant({ boundTo: receipt }), ...extraSlots }),
  };
}

// ── the library contract, as this gate reads it ────────────────────────────────────────────

test('classOf: a PROVIDER_READBACK slot is VERIFIED to the library and NOT proof to us', () => {
  // The exact shape verify-bundle.js produces for an unsigned readback that passed its checks.
  const readback = { slot: 'merge_evidence', state: 'VERIFIED', status: 'PROVIDER_READBACK' };
  assert.equal(classOf(readback), 'PROVIDER_READBACK');
  assert.notEqual(classOf(readback), 'PROVEN');
});

test('classOf: a VERIFIED slot under an unclassified status is not silently proof', () => {
  // The allow-list matters: a status added upstream must be classified on purpose here.
  assert.equal(classOf({ slot: 'receipt', state: 'VERIFIED', status: 'SOME_FUTURE_STATUS' }), 'UNCLASSIFIED');
});

test('classOf: a cryptographically verified receipt is PROVEN', () => {
  assert.equal(classOf({ slot: 'receipt', state: 'VERIFIED', status: 'VERIFIED_CURRENT' }), 'PROVEN');
});

// ── the graded paths ───────────────────────────────────────────────────────────────────────

test('a real bundle passes and NAMES the class of every slot it carries', async () => {
  const { bundle } = await realBundle();
  const graded = evaluateBundle(bundle, await slotOpts());
  assert.equal(graded.ok, true, graded.summary);
  assert.deepEqual(graded.proven.sort(), [...REQUIRED_PROVEN_SLOTS].sort());
  assert.equal(graded.classes.receipt, 'PROVEN');
  assert.equal(graded.classes.execution_grant, 'PROVEN');
  assert.match(graded.summary, /PROVEN: /);
});

test('a FORGED slot is refused — the signature is what decides, not the shape', async () => {
  const { bundle } = await realBundle();
  // Flip one byte of the grant's signature. Everything else about the bundle stays well-formed.
  const [body, sig] = bundle.slots.execution_grant.split('.');
  const raw = Buffer.from(sig, 'base64url');
  raw[0] ^= 0xff;
  const forged = bundleWith({ ...bundle.slots, execution_grant: `${body}.${raw.toString('base64url')}` });

  const graded = evaluateBundle(forged, await slotOpts());
  assert.equal(graded.ok, false, 'a forged grant slot was accepted');
  // MEASURED: one INVALID slot makes the WHOLE bundle INVALID (verify-bundle.js:348) — a stronger
  // refusal than "a required slot was not proven", and the reason says which.
  assert.match(graded.reason, /^bundle_invalid/);
  assert.equal(graded.classes.execution_grant, 'INVALID');
  assert.match(graded.summary, /invalid slots: execution_grant/);
  assert.match(graded.summary, /nothing in it was accepted/);
});

test('a forged RECEIPT slot is refused too', async () => {
  const { bundle } = await realBundle();
  const parts = bundle.slots.receipt.split('.');
  const raw = Buffer.from(parts[parts.length - 1], 'base64url');
  raw[0] ^= 0xff;
  parts[parts.length - 1] = raw.toString('base64url');
  const graded = evaluateBundle(bundleWith({ ...bundle.slots, receipt: parts.join('.') }), await slotOpts());
  assert.equal(graded.ok, false);
  assert.equal(graded.classes.receipt, 'INVALID');
});

test('an UNSIGNED merge_evidence readback is reported, never counted as proof', async () => {
  // The trap. This slot grades VERIFIED in the library and must not turn a missing grant green.
  const { bundle } = await realBundle();
  // MEASURED (receipt-verifier/test/verify-bundle.test.js:517): a readback slot carries the
  // evidence as a JSON STRING. Passing the object directly makes the slot read ABSENT, because
  // verify-bundle.js:249 takes `entry.token` for an object entry and a bare object has none.
  const readback = JSON.stringify({
    provider: 'github',
    required_check: 'CodeRifts / contract-gate',
    integration_id: 12345,
    rollup_state: 'success',
    observed_at: new Date().toISOString(),
    bound_to_source: true,
  });
  const withoutGrant = bundleWith({ receipt: bundle.slots.receipt, merge_evidence: readback });
  const graded = evaluateBundle(withoutGrant, await slotOpts());

  assert.equal(graded.classes.merge_evidence, 'PROVIDER_READBACK', 'the readback did not grade as its own class');
  assert.equal(graded.ok, false, 'an unsigned readback substituted for a missing grant');
  assert.equal(graded.reason, 'bundle_slot_not_proven', 'refused for the wrong reason');
  assert.match(graded.summary, /execution_grant/);
});

test('a readback ALONGSIDE the proven slots passes, and the output names it as not-proof', async () => {
  const { bundle } = await realBundle({
    merge_evidence: JSON.stringify({
      provider: 'github',
      required_check: 'CodeRifts / contract-gate',
      integration_id: 12345,
      rollup_state: 'success',
      observed_at: new Date().toISOString(),
      bound_to_source: true,
    }),
  });
  const graded = evaluateBundle(bundle, await slotOpts());
  assert.equal(graded.ok, true, graded.summary);
  assert.ok(graded.reported.includes('merge_evidence=PROVIDER_READBACK'));
  assert.match(graded.summary, /NOT proof/);
  assert.match(graded.summary, /unsigned provider statement/);
});

test('a name-only readback INVALIDATES the whole bundle, even beside proven slots', async () => {
  // MEASURED, and worth knowing before attaching evidence: READBACK_NOT_SOURCE_BOUND is
  // `valid: false`, so the slot is INVALID, and one invalid slot makes the whole bundle INVALID
  // (verify-bundle.js:348). Attaching a weak readback to an otherwise-proven bundle therefore
  // makes it worse, not neutral. The gate says which slot did it rather than reporting an
  // unexplained refusal.
  const { bundle } = await realBundle({
    merge_evidence: JSON.stringify({
      provider: 'github',
      required_check: 'CodeRifts / contract-gate',
      integration_id: 12345,
      rollup_state: 'success',
      observed_at: new Date().toISOString(),
      bound_to_source: false,   // the case the readback class exists to distinguish
    }),
  });
  const graded = evaluateBundle(bundle, await slotOpts());
  assert.equal(graded.classes.merge_evidence, 'INVALID');
  assert.equal(graded.ok, false, 'a not-source-bound readback was tolerated');
  assert.match(graded.summary, /READBACK_NOT_SOURCE_BOUND/);
  assert.equal(graded.classes.receipt, 'PROVEN', 'the proven slots are still reported as proven');
});

test('an empty bundle is never green', async () => {
  const graded = evaluateBundle(bundleWith({}), await slotOpts());
  assert.equal(graded.ok, false);
  assert.equal(graded.reason, 'bundle_empty');
});

test('an unknown slot key makes the whole bundle INVALID', async () => {
  const { bundle } = await realBundle();
  const graded = evaluateBundle(bundleWith({ ...bundle.slots, made_up_slot: 'x' }), await slotOpts());
  assert.equal(graded.ok, false);
  assert.match(graded.reason, /^bundle_invalid/);
});

test('an unsupported bundle version is INVALID, not forged', async () => {
  const graded = evaluateBundle({ v: 'cr.bundle.v2', slots: {} }, await slotOpts());
  assert.equal(graded.ok, false);
  assert.match(graded.reason, /unsupported_version/);
});

// ── the gate itself ────────────────────────────────────────────────────────────────────────

async function runGateWith(bundle, opts) {
  const keyring = await loadKeyring(keyringFile);
  const env = envelope({
    execution_action: 'CONTINUE', decision: 'ALLOW',
    extra: { preflight_mode: 'authorize', ...CTX },
  });
  return evaluateGate({
    preflightResponse: { chain_receipt: mintV4(signer, env), decision_result: env },
    keyring, headSha: CTX.head, expectedContext: CTX,
    repository: CTX.repository,
    ...(bundle === undefined ? {} : { proof_bundle: bundle, bundle_opts: opts }),
  });
}

test('ADDITIVE: with no bundle the verdict is byte-identical to before', async () => {
  const withoutInput = await runGateWith(undefined);
  const withExplicitNull = await runGateWith(null, null);
  assert.equal(withoutInput.pass, true);
  assert.equal(withoutInput.reason, 'signed_allow_for_diff');
  assert.equal(withoutInput.bundle, undefined, 'a run with no bundle grew a bundle field');
  assert.deepEqual(withExplicitNull, withoutInput, 'passing null changed the verdict');
});

test('the gate passes on a real bundle and reports the classes', async () => {
  const { bundle } = await realBundle();
  const gate = await runGateWith(bundle, await slotOpts());
  assert.equal(gate.pass, true, gate.summary);
  assert.equal(gate.bundle.classes.receipt, 'PROVEN');
  assert.match(gate.summary, /Proof bundle: PROVEN/);
});

test('the gate FAILS on a bundle with a forged slot', async () => {
  const { bundle } = await realBundle();
  const [body, sig] = bundle.slots.execution_grant.split('.');
  const raw = Buffer.from(sig, 'base64url');
  raw[0] ^= 0xff;
  const gate = await runGateWith(
    bundleWith({ ...bundle.slots, execution_grant: `${body}.${raw.toString('base64url')}` }),
    await slotOpts(),
  );
  assert.equal(gate.pass, false, 'a forged bundle slot passed the gate');
  assert.equal(gate.conclusion, 'failure');
  assert.match(gate.reason, /^bundle_invalid/);
  assert.equal(gate.bundle.classes.execution_grant, 'INVALID');
});

test('the bundle check runs AFTER the receipt check, never instead of it', async () => {
  // A bundle must be additional evidence, not a second door. A run whose receipt does not verify
  // fails on the receipt regardless of how good its bundle is.
  const keyring = await loadKeyring(keyringFile);
  const env = envelope({
    execution_action: 'CONTINUE', decision: 'ALLOW',
    extra: { preflight_mode: 'authorize', ...CTX },
  });
  const good = mintV4(signer, env);
  const parts = good.split('.');
  const raw = Buffer.from(parts[parts.length - 1], 'base64url');
  raw[0] ^= 0xff;
  parts[parts.length - 1] = raw.toString('base64url');

  const { bundle } = await realBundle();
  const gate = evaluateGate({
    preflightResponse: { chain_receipt: parts.join('.'), decision_result: env },
    keyring, headSha: CTX.head, expectedContext: CTX, repository: CTX.repository,
    proof_bundle: bundle, bundle_opts: await slotOpts(),
  });
  assert.equal(gate.pass, false);
  assert.equal(gate.reason, 'receipt_unverified', 'the bundle path masked a failing receipt');
});

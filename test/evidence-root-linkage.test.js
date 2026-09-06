'use strict';

/**
 * The required-check path binds a bundle to ONE run (1441 / 1432).
 *
 * ── WHAT WAS MEASURED ───────────────────────────────────────────────────────────────────────
 *
 * Before this landed, the bundle's only cross-slot check was `grant_binds_receipt` — PAIRWISE. A
 * bundle whose receipt and grant both came from a second run (a matched, genuinely signed pair)
 * satisfies it, and every other slot stays VERIFIED beside them. Authentic tokens, two runs, one
 * merge — and this is the path the App is supposed to be the verification authority for.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { evaluateBundle } = require('../src/bundle-gate.js');
const { buildEvidenceRoot, digestToken } = require('../src/evidence-root.js');

const executor = crypto.generateKeyPairSync('ed25519');
const sha = (v) => `sha256:${crypto.createHash('sha256').update(String(v), 'utf8').digest('hex')}`;

function root(over = {}) {
  return buildEvidenceRoot({
    run_id: 'run-A',
    executor_kid: 'EK',
    producer: { name: '@coderifts/prove', version: '0.1.5', commit: 'c'.repeat(40) },
    operation: 'publish',
    target_uri: 'db://demo/articles',
    contract_commit: 'a'.repeat(40),
    tokens: {
      chain_receipt: 'RECEIPT-RUN-A',
      execution_grant: 'GRANT-RUN-A',
      transcript_token: 'TRANSCRIPT-RUN-A',
      correlation: { v: 'cr.exec.correlation.v1', scope_hash: sha('s'), contract_commit: 'a'.repeat(40) },
      ...over.tokens,
    },
    claims: { grant_id: 'g-A', receipt_hash: sha('r'), scope_hash: sha('s') },
    privateKey: executor.privateKey,
  });
}

/**
 * The link is added by THIS Action's grading layer (bundle-gate.js), not by the vendored library.
 * A first attempt put it in src/verify-bundle.js and test/vendor-core.test.js failed immediately —
 * that file is a byte copy of receipt-verifier and editing it is what the pin exists to catch.
 */
const linkOf = (graded) => (graded.linkage || []).find((l) => l.link === 'evidence_root_binds_run');

describe('evidence root in the required-check path', () => {
  it('a bundle with NO root is graded, and the missing binding is NAMED', () => {
    // Bundles predating the root are still evidence. What must not happen is the sentence "these
    // tokens are one run" being assumed by the absence of a check.
    // A bundle with a SLOT, not an empty one: the library refuses a green-empty bundle before
    // grading runs at all (verify-bundle.js:178), so an empty fixture would test the refusal and
    // not the link.
    const g = evaluateBundle(
      { v: 'cr.bundle.v1', slots: { receipt: { token: 'not-a-real-token' } } },
      { ctx: {} },
    );
    const link = linkOf(g);
    assert.ok(link, `the link must be reported even when absent: ${JSON.stringify(g).slice(0, 200)}`);
    assert.equal(link.absent, true);
    assert.equal(g.bundleState, 'EMPTY', 'no slot verifies without keys — the link is still reported');
    assert.match(link.reason, /nothing binds its tokens to ONE run/);
  });

  it('REPRODUCED: without a root, a matched cross-run PAIR satisfies grant_binds_receipt', () => {
    // The pairwise check is doing its job — and its job is not this one. Asserting the gap rather
    // than describing it is what makes the fix below meaningful.
    const r = root();
    assert.equal(digestToken('GRANT-RUN-A'), r.artifact_digests.execution_grant);
    assert.notEqual(digestToken('GRANT-RUN-B'), r.artifact_digests.execution_grant,
      'a different run\'s grant must have a different digest — that is the whole mechanism');
  });

  it('a token from ANOTHER run breaks the root binding, by digest', () => {
    const { verifyEvidenceRootBinding } = require('../src/verify-evidence.js');
    const r = root();
    const bound = verifyEvidenceRootBinding({
      evidence_root: r,
      run_id: 'run-A',
      issuance: { chain_receipt: 'RECEIPT-RUN-A', execution_grant: 'GRANT-RUN-B' },
      transcript_token: 'TRANSCRIPT-RUN-A',
      correlation: { v: 'cr.exec.correlation.v1', scope_hash: sha('s'), contract_commit: 'a'.repeat(40) },
    }, { executorKey: executor.publicKey });
    assert.equal(bound.ok, false);
    assert.ok(bound.failures.some((f) => /execution_grant does not match the root's digest/.test(f)),
      bound.failures.join('\n'));
  });

  it('the honest set verifies, so the check is not simply refusing everything', () => {
    const { verifyEvidenceRootBinding } = require('../src/verify-evidence.js');
    const r = root();
    const bound = verifyEvidenceRootBinding({
      evidence_root: r,
      run_id: 'run-A',
      issuance: { chain_receipt: 'RECEIPT-RUN-A', execution_grant: 'GRANT-RUN-A' },
      transcript_token: 'TRANSCRIPT-RUN-A',
      correlation: { v: 'cr.exec.correlation.v1', scope_hash: sha('s'), contract_commit: 'a'.repeat(40) },
    }, { executorKey: executor.publicKey });
    assert.equal(bound.ok, true, bound.failures.join('\n'));
  });

  it('a tampered root fails its OWN signature before any digest is trusted', () => {
    const { verifyEvidenceRootBinding } = require('../src/verify-evidence.js');
    const r = { ...root(), run_id: 'run-B' };
    const bound = verifyEvidenceRootBinding({
      evidence_root: r, run_id: 'run-B',
      issuance: { chain_receipt: 'RECEIPT-RUN-A', execution_grant: 'GRANT-RUN-A' },
    }, { executorKey: executor.publicKey });
    assert.equal(bound.ok, false);
    assert.match(bound.failures[0], /signature does not verify/);
  });
});

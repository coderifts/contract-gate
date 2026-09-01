'use strict';

/**
 * A blocked merge names the next step.
 *
 * The load-bearing assertion is that the gate VERDICT is unchanged: `pass`,
 * `conclusion`, `reason`, `decision`, `executionAction` and `receiptStatus` are
 * compared against the values this gate produced before the remedy existed.
 * The remedy is attached after the verdict and never reaches verify.js.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const { evaluateGate, buildSummary, remedyBlock } = require('../src/gate');
const { loadKeyring } = require('../src/verify');
const { denyErrorForReason, DENY_ERROR } = require('../src/deny-remedy.js');
const { assertValidRemedy } = require('./remedy-shape.js');
const { newSigner, mintV4, tamperSignature, writeKeyringFile, envelope } = require('./mint');

const signer = newSigner('remedy-k1');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-remedy-'));
const keyringFile = writeKeyringFile(tmp, signer);
const keyring = () => loadKeyring(keyringFile);

const CTX = { operation: 'merge', repository: 'acme/api', base: 'base-aaa', head: 'head-bbb' };
const preflight = (envObj, token) => ({ chain_receipt: token, decision_result: envObj });

const boundEnvelope = (extra = {}, execution_action = 'CONTINUE') => envelope({
  execution_action,
  decision: 'ALLOW',
  extra: {
    preflight_mode: 'authorize',
    operation: CTX.operation, repository: CTX.repository, base: CTX.base, head: CTX.head,
    ...extra,
  },
});

async function evalGate(preflightResponse, over = {}) {
  return evaluateGate({
    preflightResponse,
    keyring: await keyring(),
    headSha: CTX.head,
    expectedContext: CTX,
    repository: CTX.repository,
    ...over,
  });
}

describe('deny-remedy — a blocked merge names the next step', () => {
  it('GRANT_REQUIRED: no receipt in the preflight response', async () => {
    const g = await evalGate({ decision_result: boundEnvelope() });
    assert.equal(g.reason, 'missing_receipt');
    assertValidRemedy(g.remedy, 'missing_receipt');
    assert.equal(g.remedy.error, DENY_ERROR.GRANT_REQUIRED);
    assert.equal(g.remedy.target, 'acme/api');
    // A git commit id is not a sha256 content fingerprint, so it rides in
    // `observed` and the fingerprint slot stays honestly empty.
    assert.equal(g.remedy.fingerprint, null);
    assert.equal(g.remedy.observed.head_sha, CTX.head);
  });

  it('GRANT_INVALID: a receipt whose signature does not verify', async () => {
    const env = boundEnvelope();
    const g = await evalGate(preflight(env, tamperSignature(mintV4(signer, env))));
    assert.equal(g.reason, 'receipt_unverified');
    assertValidRemedy(g.remedy, 'receipt_unverified');
    assert.equal(g.remedy.error, DENY_ERROR.GRANT_INVALID);
    assert.equal(g.remedy.observed.receipt_status, g.receiptStatus);
  });

  it('GRANT_MISMATCH: a verified receipt bound to another head', async () => {
    const env = boundEnvelope({ head: 'head-other' });
    const g = await evalGate(preflight(env, mintV4(signer, env)));
    assert.equal(g.reason, 'head_mismatch');
    assertValidRemedy(g.remedy, 'head_mismatch');
    assert.equal(g.remedy.error, DENY_ERROR.GRANT_MISMATCH);
  });

  it('an unmapped refusal carries NO remedy rather than a guessed one', async () => {
    // CONTINUE_WITH_MONITORING is the branch that requires a monitoring attestation.
    const env = boundEnvelope({}, 'CONTINUE_WITH_MONITORING');
    const g = await evaluateGate({
      preflightResponse: preflight(env, mintV4(signer, env)),
      keyring: await keyring(),
      headSha: CTX.head,
      expectedContext: CTX,
      repository: CTX.repository,
      require_verified_monitoring: true,
      monitoring_attestation: null,
    });
    assert.equal(g.reason, 'monitoring_attestation_missing');
    assert.equal(denyErrorForReason(g.reason), null);
    assert.ok(!('remedy' in g), 'a refusal outside the three classes must not carry a remedy');
    assert.ok(!g.summary.includes('```json'), 'and its summary must not carry a remedy block');
  });

  it('target is null — never a wildcard — when the repository is unknown', async () => {
    const g = await evaluateGate({ preflightResponse: null, headSha: CTX.head });
    assert.equal(g.reason, 'no_preflight_response');
    assertValidRemedy(g.remedy, 'no_preflight_response');
    assert.equal(g.remedy.target, null);
  });
});

describe('deny-remedy — the gate verdict is unchanged', () => {
  const verdictOf = (g) => ({
    pass: g.pass, conclusion: g.conclusion, reason: g.reason,
    decision: g.decision, executionAction: g.executionAction, receiptStatus: g.receiptStatus,
    headSha: g.headSha,
  });

  it('every field the gate decided with matches the pre-remedy values', async () => {
    assert.deepEqual(verdictOf(await evalGate({ decision_result: boundEnvelope() })), {
      pass: false, conclusion: 'failure', reason: 'missing_receipt',
      decision: null, executionAction: null, receiptStatus: null, headSha: CTX.head,
    });

    const env = boundEnvelope();
    assert.deepEqual(
      verdictOf(await evalGate(preflight(env, tamperSignature(mintV4(signer, env))))),
      {
        pass: false, conclusion: 'failure', reason: 'receipt_unverified',
        decision: 'ALLOW', executionAction: 'CONTINUE', receiptStatus: 'INVALID_SIGNATURE',
        headSha: CTX.head,
      },
    );
  });

  it('a PASS carries no remedy and no remedy block', async () => {
    const env = boundEnvelope();
    const g = await evalGate(preflight(env, mintV4(signer, env)));
    assert.equal(g.pass, true, g.reason);
    assert.equal(g.conclusion, 'success');
    assert.ok(!('remedy' in g), 'a passing gate must not carry a refusal remedy');
    assert.ok(!g.summary.includes('```json'));
  });
});

describe('deny-remedy — the check-run carries it in both slots', () => {
  it('summary and text carry byte-identical remedy bytes', async () => {
    const g = await evalGate({ decision_result: boundEnvelope() });
    const block = remedyBlock(g.remedy);
    assert.ok(g.summary.endsWith(block), 'the summary ends with the fenced remedy block');
    // What index.js hands to output.text — the same renderer, so a consumer
    // parsing either slot reads the same object.
    assert.deepEqual(JSON.parse(block.replace(/^```json\n/, '').replace(/\n```$/, '')), g.remedy);
  });

  it('the FAIL headline still leads the summary — the remedy is appended, not substituted', async () => {
    const g = await evalGate({ decision_result: boundEnvelope() });
    assert.ok(g.summary.startsWith('❌ **CodeRifts contract-gate: FAIL** (merge blocked)'));
    assert.ok(g.summary.includes('- reason: `missing_receipt`'));
  });

  it('remedyBlock(null) is null, so no remedy means no output.text', () => {
    assert.equal(remedyBlock(null), null);
    assert.equal(remedyBlock(undefined), null);
    assert.ok(!buildSummary({ pass: false, reason: 'verify_threw', headSha: 'x' }).includes('```json'));
  });
});

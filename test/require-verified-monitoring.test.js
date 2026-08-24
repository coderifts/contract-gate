'use strict';

/**
 * require_verified_monitoring — default false unchanged; when true, CWM requires a
 * cr.monitor.attest.v1 token verified offline. Unsigned JSON is not accepted.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { evaluateGate } = require('../src/gate');
const { loadKeyring, sha256hex } = require('../src/verify');
const {
  issueMonitoringAttestation,
  receiptDigest,
  SIGNING_PREFIX,
} = require('../src/monitoring-attestation');
const { newSigner, mintV4, writeKeyringFile, envelope } = require('./mint');

const signer = newSigner('test-k1');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-rvm-'));
const keyringFile = writeKeyringFile(tmp, signer);

const monKeys = crypto.generateKeyPairSync('ed25519');
const MON_KID = 'mon-gate-k1';
const MON_PEM = monKeys.publicKey.export({ type: 'spki', format: 'pem' });
const MON_REG = {
  keys: [{
    kid: MON_KID,
    public_key_pem: MON_PEM,
    status: 'active',
    valid_from: '2026-01-01T00:00:00Z',
    retired_at: null,
  }],
};

async function keyring() { return loadKeyring(keyringFile); }
const preflight = (envObj, token) => ({ chain_receipt: token, decision_result: envObj });

const CTX = {
  operation: 'merge',
  repository: 'acme/api',
  base: 'base-aaa',
  head: 'head-bbb',
};

function boundEnvelope({ execution_action = 'CONTINUE', decision = 'ALLOW', extra = {} } = {}) {
  return envelope({
    execution_action,
    decision,
    extra: {
      preflight_mode: 'authorize',
      operation: CTX.operation,
      repository: CTX.repository,
      base: CTX.base,
      head: CTX.head,
      ...extra,
    },
  });
}

async function evalGate(env, extra = {}) {
  const chain = extra.chain_receipt || mintV4(signer, env);
  return evaluateGate({
    preflightResponse: preflight(env, chain),
    keyring: await keyring(),
    headSha: CTX.head,
    expectedContext: CTX,
    ...extra,
    chain_receipt: undefined,
  });
}

function issueFor(env, chain, over = {}) {
  return issueMonitoringAttestation({
    privateKey: monKeys.privateKey,
    kid: over.kid || MON_KID,
    decision_id: over.decision_id || env.decision_id,
    receipt_digest: over.receipt_digest || receiptDigest(chain),
    delivery_status: over.delivery_status || 'delivered_acked',
    sink_kind: over.sink_kind || 'callback',
    observed_at: over.observed_at || '2026-06-15T12:00:00Z',
    ack_digest: over.ack_digest,
  });
}

test('digest convention is BYTE-EXACT with verify.js sha256hex (guard receiptDigestOfToken)', () => {
  const sample = 'crchain.v1-sample-token';
  const expected = 'sha256:' + sha256hex(sample);
  assert.equal(receiptDigest(sample), expected);
  assert.equal(receiptDigest(sample), 'sha256:' + crypto.createHash('sha256').update(sample, 'utf8').digest('hex'));
  assert.equal(SIGNING_PREFIX, 'crmonattest.v1');
});

test('default off: CWM still PASSES with no delivery evidence (0.3.0 behaviour)', async () => {
  const env = boundEnvelope({ execution_action: 'CONTINUE_WITH_MONITORING', decision: 'WARN' });
  const g = await evalGate(env);
  assert.equal(g.pass, true);
  assert.equal(g.reason, 'signed_allow_for_diff');
});

test('default off: omitted require_verified_monitoring is false, not a new fail path', async () => {
  const env = boundEnvelope();
  const g = await evalGate(env);
  assert.equal(g.pass, true);
});

test('flag false ignores a garbage monitoring-attestation token', async () => {
  const env = boundEnvelope({ execution_action: 'CONTINUE_WITH_MONITORING', decision: 'WARN' });
  const g = await evalGate(env, {
    require_verified_monitoring: false,
    monitoring_attestation: 'not-a-token',
  });
  assert.equal(g.pass, true);
});

test('CONTINUE unaffected when require_verified_monitoring is true (no token needed)', async () => {
  const env = boundEnvelope({ execution_action: 'CONTINUE', decision: 'ALLOW' });
  const g = await evalGate(env, { require_verified_monitoring: true });
  assert.equal(g.pass, true);
  assert.equal(g.reason, 'signed_allow_for_diff');
});

test('true + no token → BLOCK monitoring_attestation_missing (no JSON fallback)', async () => {
  const env = boundEnvelope({ execution_action: 'CONTINUE_WITH_MONITORING', decision: 'WARN' });
  const g = await evalGate(env, { require_verified_monitoring: true });
  assert.equal(g.pass, false);
  assert.equal(g.reason, 'monitoring_attestation_missing');
  assert.match(g.summary, /Unsigned JSON is not accepted/);
});

test('true + token without keyring → BLOCK monitoring_keyring_missing', async () => {
  const env = boundEnvelope({ execution_action: 'CONTINUE_WITH_MONITORING', decision: 'WARN' });
  const chain = mintV4(signer, env);
  const tok = issueFor(env, chain);
  const g = await evalGate(env, {
    require_verified_monitoring: true,
    monitoring_attestation: tok,
    chain_receipt: chain,
  });
  assert.equal(g.pass, false);
  assert.equal(g.reason, 'monitoring_keyring_missing');
});

test('true + valid token + delivered_acked → CWM PASSES', async () => {
  const env = boundEnvelope({ execution_action: 'CONTINUE_WITH_MONITORING', decision: 'WARN' });
  const chain = mintV4(signer, env);
  const tok = issueFor(env, chain);
  const g = await evalGate(env, {
    require_verified_monitoring: true,
    monitoring_attestation: tok,
    monitoring_keyring: MON_REG,
    chain_receipt: chain,
  });
  assert.equal(g.pass, true, g.summary);
  assert.equal(g.reason, 'signed_allow_for_diff');
});

test('true + valid token + sent_unacked → BLOCK monitoring_not_verified', async () => {
  const env = boundEnvelope({ execution_action: 'CONTINUE_WITH_MONITORING', decision: 'WARN' });
  const chain = mintV4(signer, env);
  const tok = issueFor(env, chain, { delivery_status: 'sent_unacked' });
  const g = await evalGate(env, {
    require_verified_monitoring: true,
    monitoring_attestation: tok,
    monitoring_keyring: MON_REG,
    chain_receipt: chain,
  });
  assert.equal(g.pass, false);
  assert.equal(g.reason, 'monitoring_not_verified');
  assert.match(g.summary, /sent_unacked/);
});

test('true + valid token + not_delivered → BLOCK monitoring_not_verified', async () => {
  const env = boundEnvelope({ execution_action: 'CONTINUE_WITH_MONITORING', decision: 'WARN' });
  const chain = mintV4(signer, env);
  const tok = issueFor(env, chain, { delivery_status: 'not_delivered' });
  const g = await evalGate(env, {
    require_verified_monitoring: true,
    monitoring_attestation: tok,
    monitoring_keyring: MON_REG,
    chain_receipt: chain,
  });
  assert.equal(g.pass, false);
  assert.equal(g.reason, 'monitoring_not_verified');
  assert.match(g.summary, /not_delivered/);
});

test('true + bad signature → BLOCK monitoring_attest_invalid_signature', async () => {
  const env = boundEnvelope({ execution_action: 'CONTINUE_WITH_MONITORING', decision: 'WARN' });
  const chain = mintV4(signer, env);
  const tok = issueFor(env, chain);
  const parts = tok.split('|');
  const sig = Buffer.from(parts[3], 'base64url');
  sig[0] ^= 0xff;
  const bad = [...parts.slice(0, 3), sig.toString('base64url')].join('|');
  const g = await evalGate(env, {
    require_verified_monitoring: true,
    monitoring_attestation: bad,
    monitoring_keyring: MON_REG,
    chain_receipt: chain,
  });
  assert.equal(g.pass, false);
  assert.equal(g.reason, 'monitoring_attest_invalid_signature');
});

test('true + unknown kid → BLOCK monitoring_attest_unknown_key', async () => {
  const env = boundEnvelope({ execution_action: 'CONTINUE_WITH_MONITORING', decision: 'WARN' });
  const chain = mintV4(signer, env);
  const tok = issueFor(env, chain);
  const g = await evalGate(env, {
    require_verified_monitoring: true,
    monitoring_attestation: tok,
    monitoring_keyring: { keys: [] },
    chain_receipt: chain,
  });
  assert.equal(g.pass, false);
  assert.equal(g.reason, 'monitoring_attest_unknown_key');
});

test('true + malformed token → BLOCK monitoring_attest_malformed', async () => {
  const env = boundEnvelope({ execution_action: 'CONTINUE_WITH_MONITORING', decision: 'WARN' });
  const g = await evalGate(env, {
    require_verified_monitoring: true,
    monitoring_attestation: 'not-an-attest',
    monitoring_keyring: MON_REG,
  });
  assert.equal(g.pass, false);
  assert.equal(g.reason, 'monitoring_attest_malformed');
});

test('true + retired-in-window → PASS', async () => {
  const env = boundEnvelope({ execution_action: 'CONTINUE_WITH_MONITORING', decision: 'WARN' });
  const chain = mintV4(signer, env);
  const tok = issueFor(env, chain, { observed_at: '2026-06-15T12:00:00Z' });
  const retired = {
    keys: [{
      kid: MON_KID,
      public_key_pem: MON_PEM,
      status: 'retired',
      valid_from: '2026-01-01T00:00:00Z',
      retired_at: '2026-12-01T00:00:00Z',
    }],
  };
  const g = await evalGate(env, {
    require_verified_monitoring: true,
    monitoring_attestation: tok,
    monitoring_keyring: retired,
    chain_receipt: chain,
    now: Date.parse('2026-07-01T00:00:00Z'),
  });
  assert.equal(g.pass, true, g.summary);
});

test('true + wrong decision_id → BLOCK monitoring_attest_unbound', async () => {
  const env = boundEnvelope({ execution_action: 'CONTINUE_WITH_MONITORING', decision: 'WARN' });
  const chain = mintV4(signer, env);
  const tok = issueFor(env, chain, { decision_id: 'other-dec' });
  const g = await evalGate(env, {
    require_verified_monitoring: true,
    monitoring_attestation: tok,
    monitoring_keyring: MON_REG,
    chain_receipt: chain,
  });
  assert.equal(g.pass, false);
  assert.equal(g.reason, 'monitoring_attest_unbound');
  assert.match(g.summary, /decision_id_mismatch/);
});

test('true + wrong receipt_digest → BLOCK monitoring_attest_unbound', async () => {
  const env = boundEnvelope({ execution_action: 'CONTINUE_WITH_MONITORING', decision: 'WARN' });
  const chain = mintV4(signer, env);
  const tok = issueFor(env, chain, { receipt_digest: receiptDigest('some-other-token') });
  const g = await evalGate(env, {
    require_verified_monitoring: true,
    monitoring_attestation: tok,
    monitoring_keyring: MON_REG,
    chain_receipt: chain,
  });
  assert.equal(g.pass, false);
  assert.equal(g.reason, 'monitoring_attest_unbound');
  assert.match(g.summary, /receipt_digest_mismatch/);
});

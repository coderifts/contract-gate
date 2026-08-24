'use strict';

/**
 * P0-4 — require_verified_monitoring (default false). CWM passes by default on the
 * host claim; when true, CWM needs delivery evidence the gate can actually check.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const { evaluateGate } = require('../src/gate');
const { loadKeyring } = require('../src/verify');
const { newSigner, mintV4, writeKeyringFile, envelope } = require('./mint');

const signer = newSigner('test-k1');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-rvm-'));
const keyringFile = writeKeyringFile(tmp, signer);

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
  return evaluateGate({
    preflightResponse: preflight(env, mintV4(signer, env)),
    keyring: await keyring(),
    headSha: CTX.head,
    expectedContext: CTX,
    ...extra,
  });
}

test('default off: CWM still PASSES with no delivery evidence (51/51 behaviour)', async () => {
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

test('true + delivered_acked evidence → CWM PASSES', async () => {
  const env = boundEnvelope({ execution_action: 'CONTINUE_WITH_MONITORING', decision: 'WARN' });
  const g = await evalGate(env, {
    require_verified_monitoring: true,
    monitoring_delivery: { status: 'delivered_acked' },
  });
  assert.equal(g.pass, true);
  assert.equal(g.reason, 'signed_allow_for_diff');
});

test('true + sent_unacked → BLOCK monitoring_not_verified', async () => {
  const env = boundEnvelope({ execution_action: 'CONTINUE_WITH_MONITORING', decision: 'WARN' });
  const g = await evalGate(env, {
    require_verified_monitoring: true,
    monitoring_delivery: { status: 'sent_unacked' },
  });
  assert.equal(g.pass, false);
  assert.equal(g.reason, 'monitoring_not_verified');
  assert.match(g.summary, /monitoring_not_verified/);
  assert.match(g.summary, /delivered_acked/);
});

test('true + not_delivered → BLOCK monitoring_not_verified', async () => {
  const env = boundEnvelope({ execution_action: 'CONTINUE_WITH_MONITORING', decision: 'WARN' });
  const g = await evalGate(env, {
    require_verified_monitoring: true,
    monitoring_delivery: { status: 'not_delivered' },
  });
  assert.equal(g.pass, false);
  assert.equal(g.reason, 'monitoring_not_verified');
});

test('true + no evidence → BLOCK monitoring_not_verified', async () => {
  const env = boundEnvelope({ execution_action: 'CONTINUE_WITH_MONITORING', decision: 'WARN' });
  const g = await evalGate(env, { require_verified_monitoring: true });
  assert.equal(g.pass, false);
  assert.equal(g.reason, 'monitoring_not_verified');
  assert.match(g.summary, /no delivery evidence/);
});

test('CONTINUE unaffected when require_verified_monitoring is true (no evidence needed)', async () => {
  const env = boundEnvelope({ execution_action: 'CONTINUE', decision: 'ALLOW' });
  const g = await evalGate(env, { require_verified_monitoring: true });
  assert.equal(g.pass, true);
  assert.equal(g.reason, 'signed_allow_for_diff');
});

test('CONTINUE unaffected when require_verified_monitoring is false', async () => {
  const env = boundEnvelope({ execution_action: 'CONTINUE', decision: 'ALLOW' });
  const g = await evalGate(env, { require_verified_monitoring: false });
  assert.equal(g.pass, true);
});

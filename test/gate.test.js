'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const { evaluateGate } = require('../src/gate');
const { loadKeyring } = require('../src/verify');
const { newSigner, mintV4, tamperSignature, writeKeyringFile, envelope } = require('./mint');

// One test signer + its loadKeyring-built keyring — the REAL verify path against a test key.
const signer = newSigner('test-k1');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-gate-'));
const keyringFile = writeKeyringFile(tmp, signer);

async function keyring() { return loadKeyring(keyringFile); }
const preflight = (envObj, token) => ({ chain_receipt: token, decision_result: envObj });

test('PASS: CONTINUE (ALLOW) + valid signed receipt bound to this envelope', async () => {
  const env = envelope({ execution_action: 'CONTINUE', decision: 'ALLOW' });
  const g = evaluateGate({ preflightResponse: preflight(env, mintV4(signer, env)), keyring: await keyring(), headSha: 'abc123' });
  assert.equal(g.pass, true);
  assert.equal(g.conclusion, 'success');
  assert.equal(g.receiptStatus, 'VERIFIED_CURRENT');
  assert.equal(g.executionAction, 'CONTINUE');
  assert.equal(g.headSha, 'abc123');
});

test('PASS: CONTINUE_WITH_MONITORING (WARN) also merges', async () => {
  const env = envelope({ execution_action: 'CONTINUE_WITH_MONITORING', decision: 'WARN' });
  const g = evaluateGate({ preflightResponse: preflight(env, mintV4(signer, env)), keyring: await keyring() });
  assert.equal(g.pass, true);
});

test('FAIL: STOP (BLOCK) even with a perfectly valid receipt', async () => {
  const env = envelope({ execution_action: 'STOP', decision: 'BLOCK' });
  const g = evaluateGate({ preflightResponse: preflight(env, mintV4(signer, env)), keyring: await keyring() });
  assert.equal(g.pass, false);
  assert.equal(g.reason, 'decision_not_allow');
  assert.equal(g.decision, 'BLOCK');
});

test('FAIL: REQUEST_APPROVAL (REQUIRE_APPROVAL) does not pass', async () => {
  const env = envelope({ execution_action: 'REQUEST_APPROVAL', decision: 'REQUIRE_APPROVAL' });
  const g = evaluateGate({ preflightResponse: preflight(env, mintV4(signer, env)), keyring: await keyring() });
  assert.equal(g.pass, false);
  assert.equal(g.reason, 'decision_not_allow');
});

test('FAIL-CLOSED: tampered signature', async () => {
  const env = envelope();
  const g = evaluateGate({ preflightResponse: preflight(env, tamperSignature(mintV4(signer, env))), keyring: await keyring() });
  assert.equal(g.pass, false);
  assert.equal(g.reason, 'receipt_unverified');
  assert.equal(g.receiptStatus, 'INVALID_SIGNATURE');
});

test('FAIL-CLOSED: unknown key-id (not in pinned keyring)', async () => {
  const env = envelope();
  // Sign with a kid the keyring does not contain -> resolveEntry returns null -> UNKNOWN_KEY.
  const g = evaluateGate({ preflightResponse: preflight(env, mintV4(signer, env, { kid: 'rogue-k9' })), keyring: await keyring() });
  assert.equal(g.pass, false);
  assert.equal(g.reason, 'receipt_unverified');
  assert.equal(g.receiptStatus, 'UNKNOWN_KEY');
});

test('FAIL-CLOSED: envelope body_hash mismatch (receipt bound to a DIFFERENT change set)', async () => {
  const env = envelope({ execution_action: 'CONTINUE', decision: 'ALLOW' });
  const token = mintV4(signer, env);           // bound to env
  const tampered = { ...env, decision: 'WARN', summary: 'swapped after signing' }; // different body
  const g = evaluateGate({ preflightResponse: preflight(tampered, token), keyring: await keyring() });
  assert.equal(g.pass, false);
  assert.equal(g.reason, 'receipt_unverified');
  assert.equal(g.receiptStatus, 'INVALID_SIGNATURE'); // body_hash_mismatch -> INVALID_SIGNATURE
});

test('FAIL-CLOSED: expired v4 receipt', async () => {
  const env = envelope({ execution_action: 'CONTINUE', decision: 'ALLOW' });
  const token = mintV4(signer, env, { expires_at: '2020-01-01T00:00:00.000Z' });
  const g = evaluateGate({ preflightResponse: preflight(env, token), keyring: await keyring() });
  assert.equal(g.pass, false);
  assert.equal(g.receiptStatus, 'VERIFIED_EXPIRED');
});

test('FAIL-CLOSED: missing receipt / missing decision_result', async () => {
  const env = envelope();
  assert.equal(evaluateGate({ preflightResponse: { decision_result: env }, keyring: await keyring() }).reason, 'missing_receipt');
  assert.equal(evaluateGate({ preflightResponse: { chain_receipt: mintV4(signer, env) }, keyring: await keyring() }).reason, 'missing_decision_result');
  assert.equal(evaluateGate({ preflightResponse: null, keyring: await keyring() }).reason, 'no_preflight_response');
});

test('the shipped PINNED keyring loads and contains kid 2026-07-k1', async () => {
  const pinned = await loadKeyring(path.join(__dirname, '..', 'keyring', 'pinned-keys.json'));
  assert.ok(pinned.has('2026-07-k1'));
});

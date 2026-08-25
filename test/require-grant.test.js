'use strict';
/**
 * require-grant at the GATE level (roadmap 1010 / panel C1).
 * The load-bearing test is the FIRST one: default-off must be byte-identical for every existing
 * consumer, because this flag lands in a published action other people already depend on.
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-grant-'));
const keyringFile = writeKeyringFile(tmp, signer);
const preflight = (envObj, token) => ({ chain_receipt: token, decision_result: envObj });

const ART = [{ id: 'openapi.yaml', type: 'openapi', after: 'paths: {}' }];

/** Same bound slots the existing gate tests use — the gate binds operation/repo/base/head. */
const CTX = { operation: 'merge', repository: 'acme/api', base: 'base-aaa', head: 'head-bbb' };

async function evalWith(extra = {}) {
  const env = envelope({
    execution_action: 'CONTINUE', decision: 'ALLOW',
    extra: { preflight_mode: 'authorize', ...CTX },
  });
  return evaluateGate({
    preflightResponse: preflight(env, mintV4(signer, env)),
    keyring: await loadKeyring(keyringFile),
    headSha: CTX.head,
    expectedContext: CTX,
    repository: CTX.repository,
    ...extra,
  });
}

test('DEFAULT OFF: omitting require-grant is byte-identical to passing false', async () => {
  const off = await evalWith();
  const explicitFalse = await evalWith({ require_grant: false });
  assert.deepEqual(explicitFalse, off);
  assert.equal(off.pass, true);
});

test('DEFAULT OFF: a governed path with no grant still passes — existing consumers unchanged', async () => {
  const r = await evalWith({ governed_artifacts: ART, grant_result: null });
  assert.equal(r.pass, true);
  assert.equal(r.reason, 'signed_allow_for_diff');
});

test('ON: governed path, no grant → BLOCK grant_not_supplied', async () => {
  const r = await evalWith({ require_grant: true, governed_artifacts: ART, grant_result: null });
  assert.equal(r.pass, false);
  assert.equal(r.reason, 'grant_not_supplied');
  assert.match(r.summary, /grant_not_supplied/);
});

test('ON: unreadable governed path is UNDECIDABLE — BLOCKS even with a valid grant', async () => {
  const r = await evalWith({
    require_grant: true,
    governed_artifacts: [{ id: 'openapi.yaml', type: 'openapi', unreadable: true }],
    grant_result: { valid: true, status: 'GRANT_CURRENT', payload: { operation: 'merge' } },
  });
  assert.equal(r.pass, false);
  assert.equal(r.reason, 'path_unreadable');
});

test('ON: grant bound to a different operation → BLOCK grant_bound_elsewhere', async () => {
  const r = await evalWith({
    require_grant: true, governed_artifacts: ART, grant_operation: 'merge',
    grant_result: { valid: true, status: 'GRANT_CURRENT', payload: { operation: 'deploy', target_id: 'openapi.yaml' } },
  });
  assert.equal(r.reason, 'grant_bound_elsewhere');
});

test('ON: expired grant → BLOCK grant_expired (distinct from not-covered)', async () => {
  const r = await evalWith({
    require_grant: true, governed_artifacts: ART,
    grant_result: { valid: false, status: 'GRANT_EXPIRED', reason: 'expired' },
  });
  assert.equal(r.reason, 'grant_expired');
});

test('ON: no governed path changed → passes, nothing to cover', async () => {
  const r = await evalWith({ require_grant: true, governed_artifacts: [], grant_result: null });
  assert.equal(r.pass, true);
});

test('ON: a matching grant passes and keeps the normal success reason', async () => {
  const { afterPayloadCanonical, computeScopeHash } = require('../src/grant-coverage.js');
  const scope_hash = computeScopeHash({ operation: 'merge', target_id: 'openapi.yaml', after_payload: afterPayloadCanonical(ART) });
  const r = await evalWith({
    require_grant: true, governed_artifacts: ART, grant_operation: 'merge',
    grant_result: { valid: true, status: 'GRANT_CURRENT', payload: { operation: 'merge', target_id: 'openapi.yaml', scope_hash } },
  });
  assert.equal(r.pass, true);
  assert.equal(r.reason, 'signed_allow_for_diff');
});

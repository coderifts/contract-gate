'use strict';

/*
 * T4 (2026-09-26) — require-receipt-trailer: the head commit carries its own receipt, verified
 * offline and bound to THIS diff. Real git repository, real diff derivation, real vendored verifier;
 * only the network preflight is stubbed (as in gate-e2e.test.js).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { runGate } = require('../src/index');
const { artifactDigestOf } = require('../src/receipt-trailer');
const { newSigner, mintV4, tamperSignature, writeKeyringFile, envelope } = require('./mint');

const SPEC_USERS = 'openapi: 3.0.0\ninfo: { title: t, version: "1" }\npaths:\n  /users:\n    get: { responses: { "200": { description: ok } } }\n';
const SPEC_USERS_HEALTH = SPEC_USERS + '  /health:\n    get: { responses: { "200": { description: ok } } }\n';

/*
 * GOLDEN, computed 2026-09-26 by coderifts-app's own buildChangeSet (decision_result.artifact_digest)
 * for exactly this artifact. The gate's recomputation must agree with the producer, not with itself.
 */
const APP_DIGEST = 'sha256:9b1eb82db4e143611cdb1d1bb391414f5f88d4c38081702947dfe736aef855d1';

const signer = newSigner('test-k1');
const keyringPath = writeKeyringFile(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-trailer-')), signer);

function allowEnvelope(digest, over = {}) {
  return envelope({ execution_action: 'CONTINUE', decision: 'ALLOW', extra: { artifact_digest: digest, ...over } });
}

/** base → head (additive spec). `trailer` goes in the head commit message; `sidecar` is written to the workspace. */
function makeRepo({ trailer = null, sidecar = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-trailer-git-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@t.t'); g('config', 'user.name', 't');
  fs.mkdirSync(path.join(dir, 'api'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'api/openapi.yaml'), SPEC_USERS);
  g('add', '-A'); g('commit', '-q', '-m', 'base');
  const baseSha = g('rev-parse', 'HEAD').trim();
  g('checkout', '-q', '-b', 'feature');
  fs.writeFileSync(path.join(dir, 'api/openapi.yaml'), SPEC_USERS_HEALTH);
  g('add', '-A');
  g('commit', '-q', '-m', trailer ? `head\n\nCodeRifts-Receipt: ${trailer}` : 'head');
  const headSha = g('rev-parse', 'HEAD').trim();
  if (sidecar) {
    // A sidecar keyed by the head SHA cannot live inside the head commit (the SHA would change);
    // a workflow step writes it into the workspace before the gate runs.
    fs.mkdirSync(path.join(dir, '.coderifts', 'receipts'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.coderifts', 'receipts', `${headSha}.json`), JSON.stringify(sidecar));
  }
  return { dir, baseSha, headSha };
}

const allowServer = (calls) => async () => {
  calls.n += 1;
  const env = allowEnvelope('sha256:' + 'e'.repeat(64), { preflight_mode: 'authorize' });
  return { chain_receipt: mintV4(signer, env), decision_result: env };
};

async function run(repo, { on = true, calls = { n: 0 } } = {}) {
  const check = {};
  const res = await runGate({
    apiKey: 'k', apiUrl: 'https://x', githubToken: 't', owner: 'o', repo: 'r',
    baseSha: repo.baseSha, headSha: repo.headSha, cwd: repo.dir, keyringPath,
    preflightImpl: allowServer(calls),
    postCheckRunImpl: async ({ conclusion }) => { check.conclusion = conclusion; return { ok: true, status: 201 }; },
    log: () => {},
    requireReceiptTrailer: on,
  });
  return { res, check, calls };
}

test('the gate recomputes the producer\'s artifact_digest (golden from coderifts-app)', () => {
  assert.equal(artifactDigestOf([{ id: 'api/openapi.yaml', type: 'openapi', before: SPEC_USERS, after: SPEC_USERS_HEALTH }]), APP_DIGEST);
});

test('⚠⚠ trailer + workspace envelope, ALLOW, same diff → the trailer check passes', async () => {
  const env = allowEnvelope(APP_DIGEST);
  const token = mintV4(signer, env);
  const repo = makeRepo({ trailer: token, sidecar: { receipt: token, envelope: env } });
  const { res } = await run(repo);
  assert.notEqual(res.gate.reason, 'receipt_trailer_missing');
  assert.ok(!String(res.gate.reason).startsWith('receipt_'), `trailer check refused: ${res.gate.reason}`);
});

test('⚠⚠ no receipt on the head commit → failure, and the preflight is not called', async () => {
  const calls = { n: 0 };
  const { res, check } = await run(makeRepo(), { calls });
  assert.equal(res.exitCode, 1);
  assert.equal(res.gate.reason, 'receipt_trailer_missing');
  assert.equal(check.conclusion, 'failure');
  assert.equal(calls.n, 0);
});

test('⚠ a trailer alone (no envelope) cannot show which diff it covers → failure', async () => {
  const token = mintV4(signer, allowEnvelope(APP_DIGEST));
  const { res } = await run(makeRepo({ trailer: token }));
  assert.equal(res.gate.reason, 'receipt_envelope_required');
});

test('⚠⚠ a tampered signature → failure (offline verify, pinned keyring)', async () => {
  const env = allowEnvelope(APP_DIGEST);
  const bad = tamperSignature(mintV4(signer, env));
  const { res } = await run(makeRepo({ trailer: bad, sidecar: { receipt: bad, envelope: env } }));
  assert.equal(res.gate.reason, 'receipt_trailer_invalid');
});

test('⚠⚠ a valid receipt for a DIFFERENT diff → failure (diff-hash mismatch)', async () => {
  const env = allowEnvelope('sha256:' + '0'.repeat(64));
  const token = mintV4(signer, env);
  const { res } = await run(makeRepo({ trailer: token, sidecar: { receipt: token, envelope: env } }));
  assert.equal(res.gate.reason, 'receipt_diff_mismatch');
});

test('a valid receipt for this diff that is not an ALLOW → failure', async () => {
  const env = envelope({ execution_action: 'STOP', decision: 'BLOCK', extra: { artifact_digest: APP_DIGEST } });
  const token = mintV4(signer, env);
  const { res } = await run(makeRepo({ trailer: token, sidecar: { receipt: token, envelope: env } }));
  assert.equal(res.gate.reason, 'receipt_not_allow');
});

test('trailer and sidecar disagreeing → failure, neither is used', async () => {
  const env = allowEnvelope(APP_DIGEST);
  const a = mintV4(signer, env);
  const b = mintV4(signer, env, { ts: '2026-07-27T00:00:00.000Z' });
  const { res } = await run(makeRepo({ trailer: a, sidecar: { receipt: b, envelope: env } }));
  assert.equal(res.gate.reason, 'receipt_trailer_conflict');
});

test('default OFF → a head commit with no receipt is judged exactly as before', async () => {
  const calls = { n: 0 };
  const { res } = await run(makeRepo(), { on: false, calls });
  assert.equal(calls.n, 1, 'the ordinary preflight path ran');
  assert.ok(!String(res.gate.reason).startsWith('receipt_trailer'));
});

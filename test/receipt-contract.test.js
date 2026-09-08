'use strict';

/**
 * THE RECEIPT THIS GATE HANDS THE CORE, AND THE LANE IT IS ENTITLED TO (1504).
 *
 * ── WHAT WAS MEASURED, PER SURFACE ──────────────────────────────────────────────────────────
 *
 * The three consumers of the shared predicate needed DIFFERENT fixes, and a blind re-vendor would
 * have given them the same one:
 *
 *   conformance    holds a prove artifact WITH a one-run evidence root → names the closed profile
 *                  TRUSTED_EXECUTOR_INTEGRITY_V1 and reaches AUTHORIZED_AND_COMMITTED.
 *   contract-gate  holds a BUNDLE. It verifies an evidence root — in its own linkage step, in the
 *                  bundle's shape, not the artifact shape the core reads. Handing the core a
 *                  synthesised artifact to satisfy a check would be building evidence to pass it.
 *                  So it asks a CUSTOM set and answers one-run itself. (this file)
 *   agent-guard    a runtime guard on a tool call. It holds NO evidence root at all, so no profile
 *                  requiring one could ever be satisfied there.
 *
 * `CUSTOM_REQUIREMENTS_SATISFIED` is therefore the CORRECT state here, not a silent drop — and
 * that distinction is the whole point of this file. A surface that quietly stopped reaching the
 * global claim and a surface that was never entitled to it look identical from outside.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const core = require('../src/verified-execution-binding.js');

const KID = 'GATE-RECEIPT-KEY';
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const RING = new Map([[KID, { publicKey, status: null }]]);
const NOW = Date.now();
const sha = (v) => `sha256:${crypto.createHash('sha256').update(String(v)).digest('hex')}`;
const canon = (v) => {
  if (v === null) return 'null';
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
};
const GRANT = (() => {
  const b = {
    v: 'cr.exec.v2', kid: KID, grant_id: 'g-gate', receipt_hash: sha('r'), tenant_id: 't',
    executor_id: 'e', adapter_id: 'a', operation: 'publish', target_uri: 'db://x/y',
    expected_state_token: 's', after_payload_hash: sha('p'), nonce_hash: sha('n'),
    policy_hash: sha('pol'), audience_hash: sha('aud'),
    not_before: new Date(NOW - 1000).toISOString(),
    expires_at: new Date(NOW + 600000).toISOString(), max_attempts: 1,
  };
  const sig = crypto.sign(null, Buffer.from(`crexec.v2|${canon(b)}`, 'utf8'), privateKey);
  return `${Buffer.from(JSON.stringify(b), 'utf8').toString('base64url')}.${sig.toString('base64url')}`;
})();

test('the gate hands the core the RECEIPT TOKEN, not a boolean it computed', () => {
  // The real caller-boolean this surface carried: `{ verified: <a slot state we graded ourselves> }`.
  // The bundle already holds the receipt, so the core can check a signature instead of trusting us.
  const src = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'src', 'bundle-gate.js'), 'utf8');
  const call = src.slice(src.indexOf('verifiedExecutionBinding({'));
  assert.match(call, /receipt:\s*\{\s*\n?\s*token: tokenOf\('receipt'\)/,
    'the gate still passes a boolean receipt');
});

test('NEGATIVE CONTROL: receipt {verified:true} with no token is not the global claim', () => {
  const r = core.verifiedExecutionBinding({
    receipt: { verified: true },
    grant: { token: GRANT, keyring: RING, expectedKid: null, now: NOW + 1 },
    committed: true,
    profile: 'TRUSTED_EXECUTOR_INTEGRITY_V1',
  });
  assert.equal(r.receipt_caller_asserted, true);
  assert.equal(r.authorized_and_committed, false);
});

test('a receipt token that does NOT verify is refused — the flag does not rescue it', () => {
  const r = core.verifiedExecutionBinding({
    receipt: { verified: true, token: 'not-a-receipt', keyring: RING },
    grant: { token: GRANT, keyring: RING, expectedKid: null, now: NOW + 1 },
    committed: true,
    required: ['issuer_grant'],
  });
  assert.equal(r.requirements_satisfied, false);
  assert.ok(r.shortfalls.some((s) => /receipt: the decision receipt did not verify \(/.test(s)),
    r.shortfalls.join('; '));
});

test('the CUSTOM lane is this surface\'s correct answer, and it is stated', () => {
  // Asserted rather than assumed. If a future change gave this gate an artifact-shaped root, the
  // right move is to name the profile — and this test failing is how that decision gets made
  // deliberately instead of by a re-vendor nobody measured.
  const src = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'src', 'bundle-gate.js'), 'utf8');
  assert.match(src, /required: \['issuer_grant', 'executor_attestation'\]/);
  assert.match(src, /one_run_root` is answered by the linkage/,
    'the reason this surface asks a narrower set is not written down');
  assert.match(src, /b\.requirements_satisfied === true/,
    'the gate reads the global claim rather than its own question');
});

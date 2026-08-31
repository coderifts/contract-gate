'use strict';

/**
 * DSSE / in-toto envelope as receipt input (roadmap 1224 Phase 3a).
 *
 * The Contract Gate now accepts EITHER a compact token or a DSSE envelope in
 * `chain_receipt`. The load-bearing property is that this changes NOTHING about
 * what is verified: `fromDSSE` unpacks, `verify.js verifyReceipt` decides.
 *
 * So the tests that matter are the negative ones — an envelope wrapping a bad
 * receipt must FAIL, and a tampered envelope must not forge a pass. A DSSE
 * envelope arriving at a gate is a container, not a verdict.
 *
 * The gate VENDORS its unpacking (src/from-dsse.js), mirroring
 * receipt-verifier/to-dsse.js, because this Action ships with zero
 * dependencies. The constants are pinned against the spec below.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
  fromDSSE, looksLikeDSSE, unwrapReceiptInput, DsseError, PAYLOAD_TYPE, PREDICATE_TYPE, FORM,
} = require('../src/from-dsse.js');
const { verifyReceipt } = require('../src/verify.js');
const { newSigner, mintV4, envelope } = require('./mint.js');

/**
 * Wrap a compact token the way receipt-verifier's toDSSE does. Written here
 * rather than imported: the gate must accept envelopes produced by an EXTERNAL
 * system, and importing the producer would test our two halves against each
 * other instead of against the format.
 */
function wrap(token, over = {}) {
  const dot = token.split('.');
  const pipe = token.split('|');
  const isAttest = pipe.length === 4;
  const compact = isAttest
    ? { form: FORM.ATTESTATION, tag: pipe[0], kid: pipe[1], encoded_payload: pipe[2] }
    : { form: FORM.RECEIPT, encoded_payload: dot[0] };
  const sig = isAttest ? pipe[3] : dot[1];
  const fields = JSON.parse(Buffer.from(compact.encoded_payload, 'base64url').toString('utf8'));
  const statement = {
    _type: 'https://in-toto.io/Statement/v1',
    subject: [{
      name: compact.form,
      digest: { sha256: crypto.createHash('sha256').update(token, 'utf8').digest('hex') },
    }],
    predicateType: PREDICATE_TYPE,
    predicate: { compact, fields, ...(over.predicate || {}) },
  };
  if (over.statement) Object.assign(statement, over.statement);
  return {
    payloadType: over.payloadType !== undefined ? over.payloadType : PAYLOAD_TYPE,
    payload: Buffer.from(JSON.stringify(statement), 'utf8').toString('base64'),
    signatures: over.signatures !== undefined ? over.signatures : [{ keyid: fields.kid || '', sig }],
  };
}

// MEASURED (src/verify.js resolveEntry): ctx.keyring is a MAP of kid -> entry,
// not the on-disk JSON shape writeKeyringFile produces.
const keyringFor = (signer) => ({
  keyring: new Map([[signer.kid, { publicKey: signer.publicKey, status: 'active', retired_at: null }]]),
  expectedKid: null,
});

const validToken = () => {
  const signer = newSigner('dsse-k1');
  return { signer, token: mintV4(signer, envelope({ execution_action: 'CONTINUE', decision: 'ALLOW' })) };
};

// ── THE FORMAT CONSTANTS ─────────────────────────────────────────────────────
describe('DSSE input — the vendored constants match the spec', () => {
  it('payloadType and predicateType are the published ones', () => {
    // RECEIPT_FORMAT.md §9.1. A drift here breaks interoperability silently:
    // an external emitter would produce envelopes this gate refuses.
    assert.equal(PAYLOAD_TYPE, 'application/vnd.in-toto+json');
    assert.equal(PREDICATE_TYPE, 'https://coderifts.com/attestations/agent-action-authorization/v1');
    assert.equal(FORM.RECEIPT, 'crchain.v1');
    assert.equal(FORM.ATTESTATION, 'cr.exec.attest.v1');
  });

  it('the gate still declares zero dependencies', () => {
    // The unpacking is VENDORED. An npm import of receipt-verifier would make
    // this Action depend on a package a customer would have to trust and fetch.
    const pkg = require('../package.json');
    assert.deepEqual(pkg.dependencies || {}, {},
      'the DSSE support added a dependency — it must stay vendored (C-route)');
  });
});

// ── UNPACKING ────────────────────────────────────────────────────────────────
describe('DSSE input — unpacking is byte-exact', () => {
  it('an envelope round-trips to the exact compact token', () => {
    const { token } = validToken();
    assert.equal(fromDSSE(wrap(token)), token);
  });

  it('the input boundary accepts an envelope as an object OR as its JSON text', () => {
    const { token } = validToken();
    const env = wrap(token);
    assert.deepEqual(unwrapReceiptInput(env), { ok: true, token, form: 'dsse' });
    assert.deepEqual(unwrapReceiptInput(JSON.stringify(env)), { ok: true, token, form: 'dsse' });
  });

  it('a compact token passes through untouched', () => {
    const { token } = validToken();
    assert.deepEqual(unwrapReceiptInput(token), { ok: true, token, form: 'compact' });
  });

  it('looksLikeDSSE keys on payloadType, not on "is it JSON"', () => {
    const { token } = validToken();
    assert.equal(looksLikeDSSE(token), false);
    assert.equal(looksLikeDSSE('{"payloadType":"application/json"}'), false);
    assert.equal(looksLikeDSSE({ payloadType: 'application/json' }), false);
    assert.equal(looksLikeDSSE(wrap(token)), true);
  });
});

// ── THE VERDICT IS UNCHANGED ─────────────────────────────────────────────────
describe('DSSE input — verification is unchanged', () => {
  it('a wrapped VALID receipt verifies exactly as the compact token does', () => {
    const { signer, token } = validToken();
    const direct = verifyReceipt(token, keyringFor(signer));
    const viaDsse = verifyReceipt(unwrapReceiptInput(wrap(token)).token, keyringFor(signer));
    assert.equal(direct.valid, true, JSON.stringify(direct));
    assert.deepEqual(viaDsse, direct, 'the DSSE trip changed the verdict');
  });

  it('A DSSE ENVELOPE IS NOT A PASS: a wrapped BAD-SIGNATURE receipt still fails', () => {
    // The property the whole slice rests on. The envelope unpacks cleanly —
    // nothing here checks a signature — and then the receipt is refused.
    const { signer, token } = validToken();
    const [payload] = token.split('.');
    const forged = `${payload}.${Buffer.from('not-a-signature').toString('base64url')}`;

    const unwrappedOk = unwrapReceiptInput(wrap(forged));
    assert.equal(unwrappedOk.ok, true, 'unpacking should succeed — it is not a verifier');
    assert.equal(unwrappedOk.token, forged);

    const r = verifyReceipt(unwrappedOk.token, keyringFor(signer));
    assert.equal(r.valid, false, 'a forged receipt passed because it arrived in a DSSE envelope');
  });

  it('an envelope signed by an unknown key fails like the compact token would', () => {
    const { token } = validToken();
    const stranger = newSigner('stranger-k1');
    const strangerCtx = keyringFor(stranger);
    const direct = verifyReceipt(token, strangerCtx);
    const viaDsse = verifyReceipt(unwrapReceiptInput(wrap(token)).token, strangerCtx);
    assert.equal(direct.valid, false);
    assert.deepEqual(viaDsse, direct);
  });
});

// ── TAMPERING ────────────────────────────────────────────────────────────────
describe('DSSE input — a tampered envelope cannot forge a pass', () => {
  it('a rewritten DECODED predicate field is refused at unpacking', () => {
    const { token } = validToken();
    const env = wrap(token);
    const st = JSON.parse(Buffer.from(env.payload, 'base64').toString('utf8'));
    st.predicate.fields.operation = 'merge-everything';
    env.payload = Buffer.from(JSON.stringify(st), 'utf8').toString('base64');

    const out = unwrapReceiptInput(env);
    assert.equal(out.ok, false);
    assert.equal(out.code, 'PREDICATE_MISMATCH');
    assert.equal(out.reason, 'dsse_predicate_mismatch');
  });

  it('a rewritten SIGNED payload field unpacks but fails verification', () => {
    // The honest split: unpacking is not verification, so the signature refuses.
    //
    // MEASURED, and it is why this rewrites `caller` rather than adding a new
    // key: the receipt's signed preimage is FIELD-SELECTED
    // (verify.js: `crchain.v1|kid|fp|prev|caller|ts`), not the whole payload
    // JSON. Adding an UNSIGNED field to the payload therefore does not break
    // the signature — of the compact token either, so this is a property of the
    // receipt format and not something the DSSE wrapper introduced. It is
    // pinned in its own test below so the distinction is on the record.
    const { signer, token } = validToken();
    const env = wrap(token);
    const st = JSON.parse(Buffer.from(env.payload, 'base64').toString('utf8'));
    const forgedFields = { ...st.predicate.fields, caller: 'attacker' };
    const encoded = Buffer.from(JSON.stringify(forgedFields), 'utf8').toString('base64url');
    st.predicate.compact.encoded_payload = encoded;
    st.predicate.fields = forgedFields;                 // keep the halves consistent
    env.payload = Buffer.from(JSON.stringify(st), 'utf8').toString('base64');

    const out = unwrapReceiptInput(env);
    assert.equal(out.ok, true);
    assert.notEqual(out.token, token);
    assert.equal(verifyReceipt(out.token, keyringFor(signer)).valid, false);
  });

  it('MEASURED LIMIT: an UNSIGNED payload field survives — in DSSE and compact alike', () => {
    // Not a DSSE weakness, and not hidden. The signed preimage covers
    // kid/fp/prev/caller/ts; a key outside that list is not signed, so editing
    // it changes nothing the signature commits to. The DSSE path behaves
    // IDENTICALLY to the compact path, which is the property this slice claims.
    const { signer, token } = validToken();
    const [enc, sig] = token.split('.');
    const fields = JSON.parse(Buffer.from(enc, 'base64url').toString('utf8'));
    const withExtra = { ...fields, unsigned_extra: 'anything' };
    const compact = `${Buffer.from(JSON.stringify(withExtra), 'utf8').toString('base64url')}.${sig}`;

    const viaCompact = verifyReceipt(compact, keyringFor(signer));
    const viaDsse = verifyReceipt(unwrapReceiptInput(wrap(compact)).token, keyringFor(signer));
    assert.equal(viaCompact.valid, true, 'the format changed: an unsigned field now breaks the signature');
    assert.deepEqual(viaDsse, viaCompact,
      'the DSSE path diverged from the compact path on an unsigned field');
  });

  it('a foreign payloadType or predicateType is refused, not unwrapped', () => {
    const { token } = validToken();
    assert.equal(unwrapReceiptInput(wrap(token, { payloadType: 'application/json' })).ok, false);
    const env = wrap(token);
    const st = JSON.parse(Buffer.from(env.payload, 'base64').toString('utf8'));
    st.predicateType = 'https://slsa.dev/provenance/v1';
    env.payload = Buffer.from(JSON.stringify(st), 'utf8').toString('base64');
    const out = unwrapReceiptInput(env);
    assert.equal(out.ok, false);
    assert.equal(out.code, 'UNSUPPORTED');
  });

  it('zero, two, or signature-less entries are refused', () => {
    const { token } = validToken();
    for (const sigs of [[], [{ keyid: 'k' }], [{ sig: '' }], [{ sig: 'a' }, { sig: 'b' }]]) {
      const out = unwrapReceiptInput(wrap(token, { signatures: sigs }));
      assert.equal(out.ok, false, `signatures ${JSON.stringify(sigs)} was accepted`);
      assert.equal(out.code, 'MALFORMED');
    }
  });

  it('an empty or non-string non-envelope input is missing_receipt, as before', () => {
    for (const bad of ['', null, undefined, 42, {}]) {
      const out = unwrapReceiptInput(bad);
      assert.equal(out.ok, false);
      assert.equal(out.reason, 'missing_receipt');
    }
  });

  it('fromDSSE throws a NAMED error, never a bare one', () => {
    assert.throws(() => fromDSSE(null), (e) => e instanceof DsseError && e.code === 'MALFORMED');
    assert.throws(() => fromDSSE({ payloadType: 'x' }), (e) => e.code === 'UNSUPPORTED');
  });
});

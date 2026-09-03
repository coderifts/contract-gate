'use strict';

/**
 * 1315 — sink_coverage is DERIVED from a gate run, never asserted.
 *
 * The benchmark's `selection_coverage` answers "did the model call CodeRifts". north-star.json
 * carries `sink_coverage: {status: "not_measured"}` and selectbench-run.js:74 hard-codes that
 * string. Selection is a decision to ask; it is not evidence that anything acted on the answer.
 *
 * These tests use an injected fetch, so the numerator can only rise when `verifyReceipt` actually
 * accepts bytes — a stub that returns a fabricated receipt fails verification and is NOT counted.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { run, eligibleCases, throughMergeSink } = require('../scripts/sink-coverage.js');
const { keyringFromDocument } = require('../src/verify');

const KEYRING = path.join(__dirname, '..', 'keyring', 'pinned-keys.json');
const keyring = keyringFromDocument(JSON.parse(fs.readFileSync(KEYRING, 'utf8')), KEYRING);

/** A two-case corpus: eligibility follows the CORPUS, not the outcome. */
function fixtures(rows) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sink-')), 'f.json');
  fs.writeFileSync(p, JSON.stringify(rows));
  return p;
}
const ELIGIBLE = { id: 'E1', expected_tool: 'coderifts.preflight_change_set', situation: 's' };
const NOT_ELIGIBLE = { id: 'N1', expected_tool: 'none', situation: 's' };

const reply = (sc) => ({
  status: 200,
  json: async () => ({ jsonrpc: '2.0', id: 1, result: { structuredContent: sc } }),
});

describe('1315 — eligibility follows the corpus', () => {
  it('only preflight-expected cases are eligible', () => {
    const p = fixtures([ELIGIBLE, NOT_ELIGIBLE]);
    assert.deepEqual(eligibleCases(p).map((c) => c.id), ['E1']);
  });
});

describe('1315 — the numerator requires a receipt the SINK accepts', () => {
  it('no receipt issued → counted in the denominator, NOT in the numerator', async () => {
    // The case that matters: the model chose correctly and nothing was issued. That is a miss at
    // this leg, and folding it into "covered" would make the metric measure selection again.
    const p = fixtures([ELIGIBLE]);
    const out = await run({
      fixturesPath: p,
      fetchImpl: async () => reply({ decision: 'ALLOW', chain_receipt: null }),
    });
    assert.equal(out.eligible, 1);
    assert.equal(out.covered, 0);
    assert.equal(out.sink_coverage, 0);
    assert.equal(out.rows[0].reason, 'no_receipt_issued');
  });

  it('a FABRICATED receipt is not covered — the number cannot be faked from the stub', async () => {
    const p = fixtures([ELIGIBLE]);
    const fake = `${Buffer.from(JSON.stringify({ v: 4, kid: '2026-07-k1', fp: 'sha256:0' })).toString('base64url')}.${Buffer.from('nope').toString('base64url')}`;
    const out = await run({
      fixturesPath: p,
      fetchImpl: async () => reply({ decision: 'ALLOW', chain_receipt: fake }),
    });
    assert.equal(out.covered, 0, 'a receipt nobody signed was counted as reaching the sink');
    assert.match(out.rows[0].reason, /^receipt_not_valid:/);
  });

  it('a transport failure is not covered, and says which failure', async () => {
    const p = fixtures([ELIGIBLE]);
    const out = await run({ fixturesPath: p, fetchImpl: async () => ({ status: 503, json: async () => ({}) }) });
    assert.equal(out.covered, 0);
    assert.equal(out.rows[0].reason, 'http_503');
  });
});

describe('1315 — the sink is the repo\'s own verifier, on the pinned keyring', () => {
  it('an absent receipt is a named miss, not a throw', () => {
    assert.deepEqual(throughMergeSink(null, keyring), { covered: false, reason: 'no_receipt_issued' });
  });

  it('the expectedKid contract is honoured — omitting it silently reports UNKNOWN_KEY', () => {
    // Recorded because it cost a full false run: verify.js:219 declares expectedKid as
    // `string|null`, and verify.js:127 treats `undefined` as "a kid was expected", so a receipt
    // whose kid IS in the keyring resolves to null. The first live run read 0/9 for that alone.
    const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'sink-coverage.js'), 'utf8');
    assert.match(src, /expectedKid: null/, 'the ctx must pass expectedKid explicitly');
  });
});

describe('1315 — the metric carries its own ceiling', () => {
  it('does_not_prove names the single sink, the demo scope, and the enforcement boundary', async () => {
    const out = await run({ fixturesPath: fixtures([ELIGIBLE]), fetchImpl: async () => reply({}) });
    const text = out.does_not_prove.join(' ');
    assert.match(text, /ONE sink \(merge\)/);
    assert.match(text, /not production traffic|corpus cases/i);
    assert.match(text, /provider-enforcement-result/);
    assert.equal(out.sink, 'merge (contract-gate pinned keyring)');
  });

  it('measured_at is stamped by the caller, so run() stays deterministic', async () => {
    const p = fixtures([ELIGIBLE]);
    const f = async () => reply({ decision: 'ALLOW', chain_receipt: null });
    const a = await run({ fixturesPath: p, fetchImpl: f });
    const b = await run({ fixturesPath: p, fetchImpl: f });
    assert.equal(a.measured_at, null);
    assert.deepEqual(a, b, 'two runs over the same input must be identical');
  });
});

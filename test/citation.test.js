'use strict';

/**
 * 1534 — the token is citable on a FOREIGN surface.
 *
 * MEASURED before this existed: the check summary carried reason / decision / execution_action /
 * receipt status / head commit — and neither `grant_id` nor the receipt digest. The digest was
 * already being computed one scope up (`receiptDigest(token)`, for the monitoring intent) and
 * discarded; `grant_id` sits on the verified grant payload the coverage check already reads.
 *
 * When a foreign repository wires this as a required check, the check output is the text a model
 * meets on THEIR pull request. A token that is not in that text cannot be quoted from it.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const { evaluateGate, buildCitation, citationBlock } = require('../src/gate');
const { loadKeyring } = require('../src/verify');
const { newSigner, mintV4, writeKeyringFile, envelope } = require('./mint');

const signer = newSigner('cite-k1');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cite-'));
const keyringFile = writeKeyringFile(tmp, signer);
const CTX = { operation: 'merge', repository: 'acme/api', base: 'base-aaa', head: 'head-bbb' };

async function passWithGrant(grantId) {
  const env = envelope({
    execution_action: 'CONTINUE', decision: 'ALLOW',
    extra: { preflight_mode: 'authorize', decision_id: 'dec_7f3a91', ...CTX },
  });
  return evaluateGate({
    preflightResponse: { chain_receipt: mintV4(signer, env), decision_result: env },
    keyring: await loadKeyring(keyringFile),
    headSha: CTX.head, expectedContext: CTX, repository: CTX.repository,
    require_grant: grantId !== null,
    governed_artifacts: [],
    grant_result: grantId === null ? null
      : { valid: true, status: 'GRANT_CURRENT', payload: { grant_id: grantId, operation: 'merge', audience: CTX.repository } },
    grant_operation: 'merge',
  });
}

test('the check summary a foreign CI renders carries grant id AND receipt digest', async () => {
  const r = await passWithGrant('grt_2b91ce');
  assert.equal(r.pass, true, r.summary);
  assert.match(r.summary, /- grant id: `grt_2b91ce`/);
  assert.match(r.summary, /- receipt digest: `sha256:[0-9a-f]{64}`/);
  assert.match(r.summary, /- decision id: `dec_7f3a91`/);
});

test('and a MACHINE block a bot can parse, fenced so a foreign renderer shows it verbatim', async () => {
  const r = await passWithGrant('grt_2b91ce');
  const m = /```coderifts-citation\n([\s\S]*?)\n```/.exec(r.summary);
  assert.ok(m, `no fenced citation block in the summary:\n${r.summary}`);
  const c = JSON.parse(m[1]);
  assert.equal(c.v, 'coderifts.citation.v1');
  assert.equal(c.grant_id, 'grt_2b91ce');
  assert.match(c.receipt_digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(c.decision_id, 'dec_7f3a91');
  assert.equal(c.head_sha, CTX.head);
  assert.equal(c.repository, CTX.repository);
});

test('the human lines and the machine block cannot disagree — one object builds both', async () => {
  // A summary and a machine block that drift apart is how a citation becomes unciteable: the
  // reader quotes one and the parser reads the other.
  const r = await passWithGrant('grt_2b91ce');
  const c = JSON.parse(/```coderifts-citation\n([\s\S]*?)\n```/.exec(r.summary)[1]);
  assert.ok(r.summary.includes(`- grant id: \`${c.grant_id}\``));
  assert.ok(r.summary.includes(`- receipt digest: \`${c.receipt_digest}\``));
  assert.deepEqual(r.citation, c, 'the returned citation is not the one rendered');
});

test('the scope sentence travels WITH the token', async () => {
  // A digest quoted on somebody else's PR invites the reading that CodeRifts approved the merge.
  // It verified one receipt for one diff, and the block says so where the digest is.
  const r = await passWithGrant('grt_2b91ce');
  const c = r.citation;
  assert.match(c.verified, /signed receipt for THIS diff/);
  assert.match(c.does_not_prove, /that the merge happened/);
});

test('no grant requested → grant_id is NULL and printed as n/a, never omitted', async () => {
  // Absence must read as absence. A dropped key lets a reader take it for a value they did not get.
  const r = await passWithGrant(null);
  assert.equal(r.pass, true);
  assert.equal(r.citation.grant_id, null);
  assert.match(r.summary, /- grant id: `n\/a`/);
  // The digest is still there: a run without a grant still verified a receipt.
  assert.match(r.citation.receipt_digest, /^sha256:[0-9a-f]{64}$/);
});

test('buildCitation invents nothing — every field is null unless supplied', () => {
  const c = buildCitation({});
  for (const k of ['decision_id', 'grant_id', 'receipt_digest', 'head_sha', 'repository']) {
    assert.equal(c[k], null, k);
  }
  assert.equal(citationBlock(null), '', 'a null citation must render as nothing, not as an empty block');
});

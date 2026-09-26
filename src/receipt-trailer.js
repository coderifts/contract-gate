'use strict';

/**
 * T4 (2026-09-26) — `require-receipt-trailer: true`: the head commit must CARRY its own receipt.
 *
 * The default gate asks the CodeRifts API for a receipt at run time. With this option on, the gate
 * additionally requires the receipt that was attached to the head commit — a `CodeRifts-Receipt:`
 * trailer or a `.coderifts/receipts/<sha>.json` sidecar (receipt-from-commit.js, vendored from
 * receipt-verifier) — and checks it OFFLINE against the pinned keyring with the vendored verifier.
 *
 * WHAT "THE SAME DIFF" MEANS HERE. A receipt attached to a commit cannot name that commit's SHA: it
 * was minted before the commit existed. What it can name is the change itself. The signed envelope
 * carries `artifact_digest` — sha256 over each contract artifact's before/after bytes, sorted by
 * type and id (coderifts-app src/change-set.js, the same recipe, recomputed here). The gate derives
 * the artifacts from the PR's ACTUAL diff and requires the two digests to be equal.
 *
 * ⚠ THE ENVELOPE IS REQUIRED. The digest lives in the envelope, and the signature binds the
 * envelope through `bh`. A trailer carries only the token, so a trailer-only receipt can prove it is
 * authentic but not which diff it covers — that is a FAILURE (receipt_envelope_required), not a
 * pass on half the evidence. A sidecar can carry the envelope; so can trailer + sidecar together.
 */

const crypto = require('node:crypto');
const { receiptForCommit } = require('./receipt-from-commit');
const { verifyReceipt } = require('./verify');

const US = '\x1f';
const ALLOW_ACTIONS = Object.freeze(['CONTINUE']);

function sha256hex(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

function specStr(v) {
  if (v == null) return '';
  return typeof v === 'string' ? v : JSON.stringify(v);
}

/** The change-set digest the envelope signs, recomputed from the artifacts of THIS diff. */
function artifactDigestOf(artifacts) {
  return `sha256:${sha256hex(
    artifacts.slice()
      .sort((a, b) => (`${a.type}${US}${a.id}` < `${b.type}${US}${b.id}` ? -1 : 1))
      .map((a) => `${sha256hex(specStr(a.before))}${sha256hex(specStr(a.after))}`)
      .join(US),
  )}`;
}

/**
 * @param {object} o
 * @param {string} o.headSha
 * @param {string} o.cwd            repository checkout
 * @param {object} o.keyring        the pinned keyring (loadKeyring)
 * @param {Array}  o.artifacts      deriveArtifactsFromDiff(...).artifacts
 * @returns {{ ok: boolean, reason: string, carrier?: string, status?: string, detail?: string }}
 */
function checkReceiptTrailer({ headSha, cwd, keyring, artifacts, now, findImpl = receiptForCommit }) {
  let found;
  try {
    found = findImpl(headSha, { cwd });
  } catch (err) {
    const msg = String((err && err.message) || err);
    const reason = /conflict/.test(msg) ? 'receipt_trailer_conflict'
      : /not valid JSON|has no "receipt"/.test(msg) ? 'receipt_sidecar_invalid'
        : 'receipt_trailer_missing';
    return { ok: false, reason, detail: msg.slice(0, 300) };
  }
  if (!found.envelope || typeof found.envelope !== 'object') {
    return {
      ok: false,
      reason: 'receipt_envelope_required',
      carrier: found.carrier,
      detail: 'the attached receipt carries no envelope, so the diff it covers cannot be checked; '
        + 'attach .coderifts/receipts/<sha>.json with { receipt, envelope }',
    };
  }
  const res = verifyReceipt(found.token, { ctx: { keyring, expectedKid: null }, envelope: found.envelope, now });
  if (!res || res.valid !== true) {
    return { ok: false, reason: 'receipt_trailer_invalid', carrier: found.carrier, status: res && res.status };
  }
  const want = artifactDigestOf(artifacts);
  if (found.envelope.artifact_digest !== want) {
    return {
      ok: false,
      reason: 'receipt_diff_mismatch',
      carrier: found.carrier,
      detail: `receipt covers ${found.envelope.artifact_digest || '(no artifact_digest)'}, this diff is ${want}`,
    };
  }
  if (!ALLOW_ACTIONS.includes(found.envelope.execution_action)) {
    return { ok: false, reason: 'receipt_not_allow', carrier: found.carrier, status: found.envelope.execution_action || null };
  }
  return { ok: true, reason: 'receipt_trailer_verified', carrier: found.carrier };
}

module.exports = { checkReceiptTrailer, artifactDigestOf };
